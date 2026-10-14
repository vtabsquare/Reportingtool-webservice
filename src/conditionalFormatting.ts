import type {ConditionalFormatRule,TableConditionalRule,VisualFormat} from './types';

const FALLBACK_NAMED_COLORS=new Set(['transparent','currentcolor','black','silver','gray','white','maroon','red','purple','fuchsia','green','lime','olive','yellow','navy','blue','teal','aqua','orange','aliceblue','antiquewhite','aquamarine','azure','beige','bisque','brown','chocolate','coral','crimson','cyan','darkblue','darkcyan','darkgray','darkgreen','darkorange','darkred','deeppink','gold','goldenrod','indigo','ivory','khaki','lavender','lightblue','lightgray','lightgreen','magenta','navyblue','orchid','pink','plum','salmon','seagreen','skyblue','tan','tomato','turquoise','violet']);

export function normalizeConditionalColor(value:any):string|undefined{
  if(typeof value!=='string')return undefined;
  const color=value.trim();
  if(!color||color.length>128)return undefined;
  if(typeof CSS!=='undefined'&&typeof CSS.supports==='function')return CSS.supports('color',color)?color:undefined;
  if(/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color))return color;
  if(/^(?:rgb|rgba|hsl|hsla)\(\s*[-+.%\d\s,\/]+\)$/i.test(color))return color;
  return FALLBACK_NAMED_COLORS.has(color.toLowerCase())?color:undefined;
}

export function resolveTableFieldValueColor(rule:TableConditionalRule|undefined,values:Record<string,any>):string|undefined{
  if(!rule?.enabled||rule.formatBy!=='fieldValue')return undefined;
  return normalizeConditionalColor(rule.colorMeasure?values[rule.colorMeasure]:undefined)||normalizeConditionalColor(rule.fallbackColor);
}

export function conditionalRuleMatches(rule:ConditionalFormatRule,value:any):boolean{
  const blank=value===null||value===undefined||value==='';
  if(rule.operator==='isBlank')return blank;
  if(rule.operator==='isNotBlank')return !blank;
  if(blank)return false;
  const left=Number(value),right=Number(rule.value),right2=Number(rule.value2);
  const numeric=Number.isFinite(left)&&Number.isFinite(right);
  if(rule.operator==='eq')return numeric?left===right:String(value)===String(rule.value??'');
  if(rule.operator==='neq')return numeric?left!==right:String(value)!==String(rule.value??'');
  if(!numeric)return false;
  if(rule.operator==='gt')return left>right;
  if(rule.operator==='gte')return left>=right;
  if(rule.operator==='lt')return left<right;
  if(rule.operator==='lte')return left<=right;
  if(rule.operator==='between')return Number.isFinite(right2)&&left>=Math.min(right,right2)&&left<=Math.max(right,right2);
  return false;
}

function applyColor(patch:Partial<VisualFormat>,rule:ConditionalFormatRule,color:string){
  if(rule.target==='visualBackground'){patch.background=color;patch.backgroundEnabled=true;patch.backgroundTransparency=0;}
  else if(rule.target==='dataColor')patch.accent=color;
  else if(rule.target==='titleText')patch.titleColor=color;
  else if(rule.target==='valueText'){patch.labelColor=color;patch.tableTextColor=color;}
  else if(rule.target==='labelText'){patch.labelColor=color;patch.categoryLabelColor=color;}
  else if(rule.target==='borderColor'){patch.borderColor=color;patch.borderVisible=true;}
  else if(rule.target==='buttonFill')patch.buttonBackground=color;
  else if(rule.target==='buttonText')patch.buttonTextColor=color;
  else if(rule.target==='buttonSelectedFill')patch.buttonSelectedBackground=color;
  else if(rule.target==='buttonSelectedText')patch.buttonSelectedTextColor=color;
  else if(rule.target==='buttonSelectedBorder'){patch.buttonSelectedBorderColor=color;patch.buttonBorderVisible=true;}
}

export function resolveConditionalFormat(rules:ConditionalFormatRule[]|undefined,values:Record<string,any>):Partial<VisualFormat>{
  const patch:Partial<VisualFormat>={};
  for(const rule of rules||[]){
    if(rule.enabled===false||!rule.measure)continue;
    if(rule.formatBy==='fieldValue'){
      const color=normalizeConditionalColor(values[rule.measure])||normalizeConditionalColor(rule.fallbackColor);
      if(color)applyColor(patch,rule,color);
      continue;
    }
    const color=normalizeConditionalColor(rule.color);
    if(!color||!conditionalRuleMatches(rule,values[rule.measure]))continue;
    applyColor(patch,rule,color);
  }
  return patch;
}


