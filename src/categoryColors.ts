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
