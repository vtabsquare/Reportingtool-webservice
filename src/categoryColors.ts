/** Stable category colours independent of database row order. */
export const CATEGORY_PALETTE = [
  '#118dff', '#12239e', '#e66c37', '#6b007b', '#e044a7',
  '#744ec2', '#d9b300', '#d64550', '#197278', '#1aab40'
];

export function stableCategoryColor(value: unknown, palette: string[] = CATEGORY_PALETTE): string {
  const colors = palette.length ? palette : CATEGORY_PALETTE;
  const text = String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase();
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return colors[(hash >>> 0) % colors.length];
}

/**
 * Allocate colours deterministically without repeating a palette entry until
 * every entry has been used. Explicit overrides are retained and reserve their
 * colour so an automatically coloured neighbour does not immediately repeat it.
 */
export function distinctCategoryColors(
  values: unknown[],
  palette: string[] = CATEGORY_PALETTE,
  overrides: Record<string,string> = {},
): Map<string,string> {
  const colors=(palette.length?palette:CATEGORY_PALETTE).filter((color,index,list)=>
    list.findIndex(candidate=>candidate.toLowerCase()===color.toLowerCase())===index
  );
  const keys=Array.from(new Set(values.map(value=>String(value??''))))
    .sort((left,right)=>left.localeCompare(right,undefined,{numeric:true,sensitivity:'base'}));
  const result=new Map<string,string>();
  const used=new Set<string>();
  for(const key of keys){
    const override=overrides[key];
    if(override){result.set(key,override);used.add(override.toLowerCase())}
  }
  for(const key of keys){
    if(result.has(key))continue;
    const preferred=colors.findIndex(color=>color.toLowerCase()===stableCategoryColor(key,colors).toLowerCase());
    let chosen='';
    for(let offset=0;offset<colors.length;offset+=1){
      const candidate=colors[((preferred<0?0:preferred)+offset)%colors.length];
      if(!used.has(candidate.toLowerCase())){chosen=candidate;break}
    }
    // Repetition is intentional only after the complete palette is occupied.
    if(!chosen)chosen=colors[(preferred<0?result.size:preferred)%colors.length];
    result.set(key,chosen);used.add(chosen.toLowerCase());
  }
  return result;
}
