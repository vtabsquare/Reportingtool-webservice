import {useEffect,useMemo,useState} from 'react';
import {ChevronDown,Plus,RotateCcw,Search,SlidersHorizontal,Sparkles,Trash2} from 'lucide-react';
import type {ConditionalFormatRule,NumberFormat,Visual} from '../types';
import {CURRENCIES,DEFAULT_NUMBER_FORMAT} from '../formatting';
import {formattingDefaults,generalFormattingCards,VISUAL_DEFINITIONS,type FormattingCardSchema,type FormattingControlSchema} from '../visualFormattingSchema';
import {useStudio} from '../store';
import {DeferredNumberInput} from './DeferredNumberInput';
import {CATEGORY_PALETTE,stableCategoryColor} from '../categoryColors';

type Props={visual:Visual;updateVisual:(fn:(visual:Visual)=>void)=>void;mode?:'format'|'analytics';multiSelect?:boolean;multiSelectSameType?:boolean;categories?:string[]};
type Scope='visual'|'general';

const read=(visual:Visual,key:string)=>{
  if(key==='title')return (visual as any)[key];
  if(key==='slicerStyle'){
    const style=(visual as any)[key];
    return ['button','tile','horizontalTiles','verticalTiles'].includes(style)?'button':style;
  }
  if(key==='x'||key==='y'||key==='w'||key==='h'||key==='rotation'||key==='locked')return (visual as any)[key];
  if(key==='paddingTop'||key==='paddingRight'||key==='paddingBottom'||key==='paddingLeft')return (visual.format as any)[key]??visual.format.padding??8;
  if(key==='titleFontFamily')return visual.format.titleFontFamily??visual.format.fontFamily;
  if(key==='subtitleFontFamily')return visual.format.subtitleFontFamily??visual.format.titleFontFamily??visual.format.fontFamily;
  if(key==='titleBold')return visual.format.titleBold??(visual.format.titleFontWeight!==undefined?visual.format.titleFontWeight>=600:undefined);
  if(key==='subtitleBold')return visual.format.subtitleBold??(visual.format.subtitleFontWeight!==undefined?visual.format.subtitleFontWeight>=600:undefined);
  return (visual.format as any)[key];
};

function write(visual:Visual,key:string,value:any){
  if(key==='title'){visual.title=value||VISUAL_DEFINITIONS[visual.type].displayName;return}
  if(key==='slicerStyle'){visual.slicerStyle=value;return}
  if(key==='x'||key==='y'||key==='w'||key==='h'||key==='rotation'||key==='locked'){
    if(key==='rotation'||key==='locked'){(visual as any)[key]=value;return}
    if((key==='w'||key==='h')&&visual.format.lockAspectRatio){
      const ratio=Math.max(.1,visual.w/Math.max(1,visual.h));
      if(key==='w'){visual.w=Math.max(40,value);visual.h=Math.max(30,Math.round(value/ratio))}
      else{visual.h=Math.max(30,value);visual.w=Math.max(40,Math.round(value*ratio))}
    }else (visual as any)[key]=value;
    visual.x=Math.max(0,visual.x);visual.y=Math.max(0,visual.y);visual.w=Math.max(40,visual.w);visual.h=Math.max(30,visual.h);return;
  }
  if(key==='shapeType'){
    visual.format.shapeType=value;
    // Keep a newly selected line visible. Outline can still be turned off after.
    if(value==='line'&&visual.format.shapeStrokeVisible===false)visual.format.shapeStrokeVisible=true;
    return;
  }
  if(key==='titleBold'){visual.format.titleBold=!!value;visual.format.titleFontWeight=value?700:400;return}
  if(key==='subtitleBold'){visual.format.subtitleBold=!!value;visual.format.subtitleFontWeight=value?700:400;return}
  (visual.format as any)[key]=value;
  if(key==='cornerRadius'){
    visual.format.cornerLinked=true;
    visual.format.cornerRadii={topLeft:value,topRight:value,bottomRight:value,bottomLeft:value};
  }
}

function Control({schema,visual,updateVisual}:{schema:FormattingControlSchema;visual:Visual;updateVisual:Props['updateVisual']}){
  const rawValue=read(visual,schema.key);
  // For number inputs with no defaultValue (i.e. "Auto" overrides), use rawValue directly without falling back to defaultValue
  const isAutoNumber=schema.type==='number'&&schema.defaultValue===undefined;
  const value=isAutoNumber?rawValue:(rawValue??schema.defaultValue);
  const dependency=schema.dependsOn;
  const dependencyDefault=(formattingDefaults(visual.type,'all') as any)[dependency?.key||''];
  const dependencyValue=dependency?read(visual,dependency.key)??dependencyDefault:undefined;
  const disabled=!!dependency&&(dependency.notValue!==undefined?dependencyValue===dependency.notValue:dependencyValue!==(dependency.value??true));
  if(disabled&&dependency.hide)return null;
  const commit=(next:any)=>updateVisual(v=>write(v,schema.key,next));
  if(schema.type==='toggle')return <label className={'formatSchemaToggle '+(disabled?'disabled':'')}><span>{schema.label}</span><input type="checkbox" checked={!!value} disabled={disabled} onChange={e=>commit(e.target.checked)}/></label>;
  if(isAutoNumber){
    // Empty = Auto. Keystrokes stay local; the visual changes only on blur.
    return <label className={'formatSchemaControl '+(disabled?'disabled':'')}>
      <span>{schema.label}</span>
      <DeferredNumberInput placeholder="Auto" value={value} min={schema.min} max={schema.max} step={schema.step} disabled={disabled} allowEmpty onCommit={commit}/>
    </label>;
  }
  return <label className={'formatSchemaControl '+(disabled?'disabled':'')}><span>{schema.label}{schema.suffix&&schema.type==='range'?<em>{value}{schema.suffix}</em>:null}</span>
    {schema.type==='color'?<div className="schemaColor"><input type="color" value={String(value||schema.defaultValue)} disabled={disabled} onChange={e=>commit(e.target.value)}/><input value={String(value||'')} disabled={disabled} onChange={e=>commit(e.target.value)}/></div>:
    schema.type==='select'?<select value={value} disabled={disabled} onChange={e=>commit(e.target.value)}>{schema.options?.map(option=><option key={String(option.value)} value={option.value}>{option.label}</option>)}</select>:
    schema.type==='textarea'?<textarea rows={3} value={String(value||'')} disabled={disabled} onChange={e=>commit(e.target.value)}/>:
    schema.type==='text'?<input value={String(value||'')} disabled={disabled} onChange={e=>commit(e.target.value)}/>:
    schema.type==='number'?<DeferredNumberInput value={Number(value)} min={schema.min} max={schema.max} step={schema.step} disabled={disabled} onCommit={commit}/>:
    <input type={schema.type} value={value} min={schema.min} max={schema.max} step={schema.step} disabled={disabled} onChange={e=>commit(Number(e.target.value))}/>}</label>;
}

function DataFormat({visual,updateVisual}:{visual:Visual;updateVisual:Props['updateVisual']}){
  const fields=Array.from(new Set([...(visual.type==='table'||visual.type==='matrix'?(visual.bindings.axis||[]):[]),...(visual.bindings.values||[]),...(visual.bindings.target||[])]));
  const[field,setField]=useState(fields[0]||'');
  const active=fields.includes(field)?field:(fields[0]||'');
  if(!active)return <div className="schemaEmptyNote">Add a field or measure to this visual to configure its display format.</div>;
  const format:NumberFormat={...DEFAULT_NUMBER_FORMAT,...visual.format.fieldFormats?.[active]};
  const set=(key:keyof NumberFormat,value:any)=>updateVisual(v=>{v.format.fieldFormats=v.format.fieldFormats||{};v.format.fieldFormats[active]={...DEFAULT_NUMBER_FORMAT,...v.format.fieldFormats[active],[key]:value}});
  return <div className="schemaDataFormat">
    <label>Field / measure<select value={active} onChange={e=>setField(e.target.value)}>{fields.map(item=><option key={item}>{item}</option>)}</select></label>
    <div className="formatStyleButtons"><button className={format.style==='number'?'active':''} onClick={()=>set('style','number')}>123</button><button className={format.style==='currency'?'active':''} onClick={()=>set('style','currency')}>$</button><button className={format.style==='percentage'?'active':''} onClick={()=>set('style','percentage')}>%</button></div>
    {format.style==='currency'&&<label>Currency<select value={format.currency} onChange={e=>set('currency',e.target.value)}>{CURRENCIES.map(currency=><option key={currency.code} value={currency.code}>{currency.symbol} · {currency.code}</option>)}</select></label>}
    <div className="schemaTwoColumn"><label>Decimal places<input type="number" min="0" max="8" value={format.decimals} onChange={e=>set('decimals',Number(e.target.value))}/></label><label>Display units<select value={format.displayUnits} onChange={e=>set('displayUnits',e.target.value)}><option value="auto">Auto</option><option value="none">None</option><option value="thousand">Thousands</option><option value="million">Millions</option><option value="billion">Billions</option><option value="trillion">Trillions</option></select></label></div>
    <label>Date format<select value={format.dateFormat||'default'} onChange={e=>set('dateFormat',e.target.value)}><option value="default">Automatic</option><option value="dd/MM/yyyy">DD/MM/YYYY</option><option value="MM/dd/yyyy">MM/DD/YYYY</option><option value="yyyy-MM-dd">YYYY-MM-DD</option><option value="dd MMM yyyy">DD MMM YYYY</option></select></label>
    <div className="schemaTwoColumn"><label>Prefix<input value={format.prefix||''} onChange={e=>set('prefix',e.target.value)}/></label><label>Suffix<input value={format.suffix||''} onChange={e=>set('suffix',e.target.value)}/></label></div>
  </div>;
}

function IndividualCardFormat({visual,updateVisual}:{visual:Visual;updateVisual:Props['updateVisual']}){
  const fields=visual.bindings.values||[];
  const[selected,setSelected]=useState(fields[0]||'');
  const active=fields.includes(selected)?selected:(fields[0]||'');
  if(!active)return <div className="schemaEmptyNote">Add two or more values to select and format an individual card.</div>;
  const local=visual.format.cardStyles?.[active]||{};
  const set=(key:string,value:any)=>updateVisual(v=>{v.format.cardStyles=v.format.cardStyles||{};v.format.cardStyles[active]={...(v.format.cardStyles[active]||{}),[key]:value}});
  const reset=()=>updateVisual(v=>{if(!v.format.cardStyles)return;delete v.format.cardStyles[active]});
  const label=(field:string)=>field.replace(/^.*\./,'').replace(/::.*$/,'').replace(/_/g,' ');
  return <div className="schemaDataFormat individualCardFormat">
    <label>Card<select value={active} onChange={e=>setSelected(e.target.value)}>{fields.map(field=><option key={field} value={field}>{label(field)}</option>)}</select></label>
    <div className="schemaTwoColumn"><label>Card background<div className="schemaColor"><input type="color" value={local.background||visual.format.cardBackground||'#ffffff'} onChange={e=>set('background',e.target.value)}/><input value={local.background||''} placeholder="Inherit" onChange={e=>set('background',e.target.value||undefined)}/></div></label><label>Accent<div className="schemaColor"><input type="color" value={local.accent||visual.format.accent||'#118dff'} onChange={e=>set('accent',e.target.value)}/><input value={local.accent||''} placeholder="Inherit" onChange={e=>set('accent',e.target.value||undefined)}/></div></label></div>
    <div className="schemaTwoColumn"><label>Value color<div className="schemaColor"><input type="color" value={local.valueColor||visual.format.labelColor||'#242424'} onChange={e=>set('valueColor',e.target.value)}/><input value={local.valueColor||''} placeholder="Inherit" onChange={e=>set('valueColor',e.target.value||undefined)}/></div></label><label>Label color<div className="schemaColor"><input type="color" value={local.labelColor||visual.format.categoryLabelColor||'#616161'} onChange={e=>set('labelColor',e.target.value)}/><input value={local.labelColor||''} placeholder="Inherit" onChange={e=>set('labelColor',e.target.value||undefined)}/></div></label></div>
    <label className="formatSchemaToggle"><span>Individual border</span><input type="checkbox" checked={local.borderVisible??visual.format.cardBorderVisible??false} onChange={e=>set('borderVisible',e.target.checked)}/></label>
    <div className="schemaTwoColumn"><label>Border color<div className="schemaColor"><input type="color" value={local.borderColor||visual.format.cardBorderColor||'#e2e8f0'} onChange={e=>set('borderColor',e.target.value)}/><input value={local.borderColor||''} placeholder="Inherit" onChange={e=>set('borderColor',e.target.value||undefined)}/></div></label><label>Corner radius<input type="number" min="0" max="40" value={local.cornerRadius??visual.format.cardCornerRadius??8} onChange={e=>set('cornerRadius',Number(e.target.value))}/></label></div>
    <button type="button" className="schemaInlineReset" onClick={reset}><RotateCcw size={12}/>Reset selected card</button>
  </div>;
}

function SeriesColorFormat({visual,updateVisual}:{visual:Visual;updateVisual:Props['updateVisual']}){
  const fields=visual.bindings.values||[];
  const[selected,setSelected]=useState(fields[0]||'');
  const active=fields.includes(selected)?selected:(fields[0]||'');
  if(!active)return <div className="schemaEmptyNote">Add a value or measure to configure its series color.</div>;
  const palette=['#118dff','#12239e','#e66c37','#6b007b','#e044a7','#744ec2','#d9b300','#d64550','#197278','#1aab40'];
  const fallback=fields.length===1?(visual.format.accent||palette[0]):palette[fields.indexOf(active)%palette.length];
  const current=visual.format.seriesColors?.[active]||fallback;
  const set=(value:string)=>updateVisual(v=>{v.format.seriesColors=v.format.seriesColors||{};v.format.seriesColors[active]=value});
  const reset=()=>updateVisual(v=>{if(!v.format.seriesColors)return;delete v.format.seriesColors[active]});
  const label=(field:string)=>field.replace(/^.*\./,'').replace(/::.*$/,'').replace(/_/g,' ');
  return <div className="schemaDataFormat seriesColorFormat">
    <label>Series<select value={active} onChange={e=>setSelected(e.target.value)}>{fields.map(field=><option key={field} value={field}>{label(field)}</option>)}</select></label>
    <label>Color<div className="schemaColor"><input type="color" value={current} onChange={e=>set(e.target.value)}/><input value={visual.format.seriesColors?.[active]||''} placeholder={fallback} onChange={e=>set(e.target.value||fallback)}/></div></label>
    <button type="button" className="schemaInlineReset" onClick={reset}><RotateCcw size={12}/>Reset selected series</button>
  </div>;
}

function CategoryColorFormat({visual,updateVisual,categories}:{visual:Visual;updateVisual:Props['updateVisual'];categories?:string[]}){
  const cats=categories||[];
  const[selected,setSelected]=useState(cats[0]||'');
  const active=cats.includes(selected)?selected:(cats[0]||'');
  if(!active||cats.length===0)return <div className="schemaEmptyNote">No categories available yet. Add data to the chart first, then return here to set individual colors.</div>;
  const fallback=stableCategoryColor(active,CATEGORY_PALETTE);
  const current=(visual.format.categoryColors as any)?.[active]||fallback;
  const set=(value:string)=>updateVisual(v=>{(v.format as any).categoryColors=(v.format as any).categoryColors||{};(v.format as any).categoryColors[active]=value});
  const reset=()=>updateVisual(v=>{if(!(v.format as any).categoryColors)return;delete (v.format as any).categoryColors[active]});
  return <div className="schemaDataFormat seriesColorFormat">
    <label>Category<select value={active} onChange={e=>setSelected(e.target.value)}>{cats.map(cat=><option key={cat} value={cat}>{cat}</option>)}</select></label>
    <label>Color<div className="schemaColor"><input type="color" value={current} onChange={e=>set(e.target.value)}/><input value={(visual.format as any).categoryColors?.[active]||''} placeholder={fallback} onChange={e=>set(e.target.value||fallback)}/></div></label>
    <button type="button" className="schemaInlineReset" onClick={reset}><RotateCcw size={12}/>Reset selected category</button>
  </div>;
}

function TableConditionalFormat({visual,updateVisual}:{visual:Visual;updateVisual:Props['updateVisual']}){
  const{project}=useStudio();
  const measures=Object.keys(project?.model?.measures||{}).sort((a,b)=>Number(!/colou?r/i.test(a))-Number(!/colou?r/i.test(b))||a.localeCompare(b));
  const fields=Array.from(new Set([...(visual.bindings.axis||[]),...(visual.bindings.values||[]),...(visual.bindings.target||[]),...(visual.bindings.legend||[]),...(visual.bindings.tooltips||[])]));
  const[selected,setSelected]=useState(fields[0]||'');
  const active=fields.includes(selected)?selected:(fields[0]||'');
  if(!active)return <div className="schemaEmptyNote">Add a column or measure before creating a conditional-formatting rule.</div>;
  const rule=visual.format.tableConditionalRules?.[active]||{};
  const set=(key:string,value:any)=>updateVisual(v=>{v.format.tableConditionalRules=v.format.tableConditionalRules||{};v.format.tableConditionalRules[active]={enabled:true,formatBy:'rules',applyTo:'background',minColor:'#ffffff',maxColor:'#118dff',...v.format.tableConditionalRules[active],[key]:value}});
  const reset=()=>updateVisual(v=>{if(!v.format.tableConditionalRules)return;delete v.format.tableConditionalRules[active]});
  const label=(field:string)=>field.replace(/^.*\./,'').replace(/::.*$/,'').replace(/_/g,' ');
  const midDefault=((rule.min??0)+(rule.max??100))/2;
  const formatBy=rule.formatBy||'rules';
  return <div className="schemaDataFormat conditionalTableFormat">
    <label>Column / measure<select value={active} onChange={e=>setSelected(e.target.value)}>{fields.map(field=><option key={field} value={field}>{label(field)}</option>)}</select></label>
    <label className="formatSchemaToggle"><span>Apply color rule</span><input type="checkbox" checked={rule.enabled===true} onChange={e=>set('enabled',e.target.checked)}/></label>
    <label>Format by<select value={formatBy} disabled={rule.enabled!==true} onChange={e=>set('formatBy',e.target.value)}><option value="rules">Rules</option><option value="fieldValue">Field value (color measure)</option></select></label>
    <label>Apply to<select value={rule.applyTo||'background'} disabled={rule.enabled!==true} onChange={e=>set('applyTo',e.target.value)}><option value="background">Cell background</option><option value="text">Text color</option><option value="both">Background and text</option></select></label>
    {formatBy==='fieldValue'?<>{measures.length?<label>Color measure<select value={rule.colorMeasure||''} disabled={rule.enabled!==true} onChange={e=>set('colorMeasure',e.target.value)}><option value="">Select measure</option>{measures.map(measure=><option key={measure}>{measure}</option>)}</select></label>:<div className="schemaEmptyNote">Create a color-returning measure before using field value formatting.</div>}<label>Fallback color (optional)<div className="schemaColor"><input type="color" value={rule.fallbackColor||'#118dff'} disabled={rule.enabled!==true} onChange={e=>set('fallbackColor',e.target.value)}/><input value={rule.fallbackColor||''} placeholder="No fallback" disabled={rule.enabled!==true} onChange={e=>set('fallbackColor',e.target.value||undefined)}/></div></label><small>The measure must return a color such as #16A34A, rgb(22, 163, 74), hsl(142 76% 36%), or green.</small></>:<>
    <div className="schemaTwoColumn"><label>Minimum value<input type="number" value={rule.min??0} disabled={rule.enabled!==true} onChange={e=>set('min',Number(e.target.value))}/></label><label>Maximum value<input type="number" value={rule.max??100} disabled={rule.enabled!==true} onChange={e=>set('max',Number(e.target.value))}/></label></div>
    <div className="schemaTwoColumn"><label>Minimum color<div className="schemaColor"><input type="color" value={rule.minColor||'#ffffff'} disabled={rule.enabled!==true} onChange={e=>set('minColor',e.target.value)}/><input value={rule.minColor||'#ffffff'} disabled={rule.enabled!==true} onChange={e=>set('minColor',e.target.value)}/></div></label><label>Maximum color<div className="schemaColor"><input type="color" value={rule.maxColor||'#118dff'} disabled={rule.enabled!==true} onChange={e=>set('maxColor',e.target.value)}/><input value={rule.maxColor||'#118dff'} disabled={rule.enabled!==true} onChange={e=>set('maxColor',e.target.value)}/></div></label></div>
    <label className="formatSchemaToggle"><span>Add middle color</span><input type="checkbox" disabled={rule.enabled!==true} checked={!!rule.midColor} onChange={e=>set('midColor',e.target.checked?(rule.midColor||'#ffff00'):'')}/></label>
    {!!rule.midColor&&<>
      <div className="schemaTwoColumn"><label>Middle value<input type="number" value={rule.midValue??midDefault} disabled={rule.enabled!==true} onChange={e=>set('midValue',Number(e.target.value))}/></label><label>Middle color<div className="schemaColor"><input type="color" value={rule.midColor||'#ffff00'} disabled={rule.enabled!==true} onChange={e=>set('midColor',e.target.value)}/><input value={rule.midColor||'#ffff00'} disabled={rule.enabled!==true} onChange={e=>set('midColor',e.target.value)}/></div></label></div>
    </>}
    <small>Values use a smooth {rule.midColor?'3-stop':'2-stop'} color gradient. Values outside the range use the nearest endpoint color.</small></>}
    <button type="button" className="schemaInlineReset" onClick={reset}><RotateCcw size={12}/>Reset selected rule</button>
  </div>;
}

function MeasureConditionalFormat({visual,updateVisual}:{visual:Visual;updateVisual:Props['updateVisual']}){
  const{project}=useStudio();
  const measures=Object.keys(project?.model?.measures||{}).sort((a,b)=>Number(!/colou?r/i.test(a))-Number(!/colou?r/i.test(b))||a.localeCompare(b));
  const rules=visual.format.conditionalFormatRules||[];
  const updateRule=(id:string,changes:Partial<ConditionalFormatRule>)=>updateVisual(v=>{v.format.conditionalFormatRules=(v.format.conditionalFormatRules||[]).map(rule=>rule.id===id?{...rule,...changes}:rule)});
  const removeRule=(id:string)=>updateVisual(v=>{v.format.conditionalFormatRules=(v.format.conditionalFormatRules||[]).filter(rule=>rule.id!==id)});
  const addRule=()=>updateVisual(v=>{v.format.conditionalFormatRules=[...(v.format.conditionalFormatRules||[]),{id:crypto.randomUUID(),enabled:true,formatBy:'rules',measure:measures[0]||'',operator:'gte',value:0,target:visual.type==='button'?'buttonFill':'dataColor',color:visual.type==='button'?'#16a34a':'#118dff'}]});
  if(!measures.length)return <div className="schemaEmptyNote">Create a measure first, then use it to control colors on this visual.</div>;
  return <div className="schemaDataFormat conditionalRuleList">
    {rules.map((rule,index)=>{const formatBy=rule.formatBy||'rules';return <div className="conditionalRuleEditor" key={rule.id}>
      <div className="conditionalRuleHead"><label className="formatSchemaToggle"><span>Rule {index+1}</span><input type="checkbox" checked={rule.enabled!==false} onChange={e=>updateRule(rule.id,{enabled:e.target.checked})}/></label><button type="button" title="Delete rule" onClick={()=>removeRule(rule.id)}><Trash2 size={13}/></button></div>
      <label>Format by<select value={formatBy} onChange={e=>updateRule(rule.id,{formatBy:e.target.value as ConditionalFormatRule['formatBy']})}><option value="rules">Rules</option><option value="fieldValue">Field value (color measure)</option></select></label>
      <label>{formatBy==='fieldValue'?'Color measure':'Measure'}<select value={rule.measure} onChange={e=>updateRule(rule.id,{measure:e.target.value})}>{measures.map(measure=><option key={measure}>{measure}</option>)}</select></label>
      {formatBy==='rules'&&<><label>Condition<select value={rule.operator} onChange={e=>updateRule(rule.id,{operator:e.target.value as ConditionalFormatRule['operator']})}><option value="gt">is greater than</option><option value="gte">is greater than or equal to</option><option value="lt">is less than</option><option value="lte">is less than or equal to</option><option value="eq">equals</option><option value="neq">does not equal</option><option value="between">is between</option><option value="isBlank">is blank</option><option value="isNotBlank">is not blank</option></select></label>
      {!['isBlank','isNotBlank'].includes(rule.operator)&&<div className="schemaTwoColumn"><label>Value<input type={['eq','neq'].includes(rule.operator)?'text':'number'} value={rule.value??0} onChange={e=>updateRule(rule.id,{value:['eq','neq'].includes(rule.operator)?e.target.value:Number(e.target.value)})}/></label>{rule.operator==='between'&&<label>And<input type="number" value={rule.value2??100} onChange={e=>updateRule(rule.id,{value2:Number(e.target.value)})}/></label>}</div>}</>}
      <label>Format<select value={rule.target} onChange={e=>updateRule(rule.id,{target:e.target.value as ConditionalFormatRule['target']})}><option value="visualBackground">Visual background</option><option value="dataColor">Data color</option><option value="titleText">Title text</option><option value="valueText">Value / table text</option><option value="labelText">Labels</option><option value="borderColor">Border</option>{visual.type==='button'&&<><option value="buttonFill">Button fill (unselected)</option><option value="buttonText">Button text (unselected)</option><option value="buttonSelectedFill">Button fill (selected)</option><option value="buttonSelectedText">Button text (selected)</option><option value="buttonSelectedBorder">Button border (selected)</option></>}</select></label>
      {formatBy==='rules'?<label>Color<div className="schemaColor"><input type="color" value={rule.color||'#118dff'} onChange={e=>updateRule(rule.id,{color:e.target.value})}/><input value={rule.color||''} onChange={e=>updateRule(rule.id,{color:e.target.value})}/></div></label>:<><small>The selected measure must return a CSS color such as #16A34A, rgb(22, 163, 74), hsl(142 76% 36%), or green.</small><label>Fallback color (optional)<div className="schemaColor"><input type="color" value={rule.fallbackColor||'#118dff'} onChange={e=>updateRule(rule.id,{fallbackColor:e.target.value})}/><input value={rule.fallbackColor||''} placeholder="No fallback" onChange={e=>updateRule(rule.id,{fallbackColor:e.target.value||undefined})}/></div></label></>}
    </div>})}
    {!rules.length&&<div className="schemaEmptyNote">No measure-based rules yet. Add a rule to control this visual's colors.</div>}
    <button type="button" className="schemaInlineReset" onClick={addRule}><Plus size={12}/>Add rule</button>
  </div>;
}

function MapColorGrading({visual,updateVisual}:{visual:Visual;updateVisual:Props['updateVisual']}){
  const{project}=useStudio();
  const measures=Object.keys(project?.model?.measures||{}).sort((a,b)=>a.localeCompare(b));
  const mode=visual.format.mapColorScale==='rules'?'rules':'measure';
  const selectedColorMeasure=visual.format.mapColorMeasure||visual.bindings.color?.[0]||'';
  const colorMeasures=Array.from(new Set([selectedColorMeasure,...measures].filter(Boolean)));
  const target=visual.format.mapMode==='filled'?'filled map areas':'map bubbles';
  const setMethod=(next:'measure'|'rules')=>updateVisual(v=>{
    v.format.mapColorScale=next;
    if(next==='measure'){
      const measure=v.format.mapColorMeasure||v.bindings.color?.[0]||'';
      v.bindings.color=measure?[measure]:[];
    }else{
      v.bindings.color=[];
    }
  });
  const setColorMeasure=(measure:string)=>updateVisual(v=>{v.format.mapColorMeasure=measure||undefined;v.bindings.color=measure?[measure]:[]});
  const setNumber=(key:'mapRuleLow'|'mapRuleHigh',value:string)=>updateVisual(v=>{v.format[key]=Number(value)});
  const setColor=(key:'mapRuleLowColor'|'mapRuleMidColor'|'mapRuleHighColor',value:string)=>updateVisual(v=>{v.format[key]=value});
  const colorInput=(label:string,key:'mapRuleLowColor'|'mapRuleMidColor'|'mapRuleHighColor',fallback:string)=>{
    const value=visual.format[key]||fallback;
    return <label>{label}<div className="schemaColor"><input type="color" value={value} onChange={e=>setColor(key,e.target.value)}/><input value={value} onChange={e=>setColor(key,e.target.value)}/></div></label>;
  };
  return <div className="schemaDataFormat mapColorGradingEditor">
    <label>Color method<select value={mode} onChange={e=>setMethod(e.target.value as 'measure'|'rules')}><option value="measure">Measure</option><option value="rules">Rules</option></select></label>
    <div className="schemaEmptyNote">The selected color is applied automatically to {target}.</div>
    {mode==='measure'?<>
      <label>Color measure<select value={selectedColorMeasure} onChange={e=>setColorMeasure(e.target.value)}><option value="">Select color measure</option>{colorMeasures.map(measure=><option key={measure} value={measure}>{measure}</option>)}</select></label>
      {!measures.length&&<div className="schemaEmptyNote">Create a color-returning measure first.</div>}
      <small>The measure must return a CSS color such as #16A34A, #FACC15, or #DC2626. Low/middle/high colors belong only to Rules.</small>
    </>:<>
      <div className="schemaEmptyNote">Rules use the numeric field or measure already placed in Detail / value.</div>
      <div className="conditionalRuleEditor">
        <b>Low</b>
        <label>Upper limit<input type="number" value={visual.format.mapRuleLow??0} onChange={e=>setNumber('mapRuleLow',e.target.value)}/></label>
        {colorInput('Low color','mapRuleLowColor','#d64550')}
      </div>
      <div className="conditionalRuleEditor">
        <b>Middle</b>
        <small>Values above the low limit and below the high limit.</small>
        {colorInput('Middle color','mapRuleMidColor','#facc15')}
      </div>
      <div className="conditionalRuleEditor">
        <b>High</b>
        <label>Lower limit<input type="number" value={visual.format.mapRuleHigh??100} onChange={e=>setNumber('mapRuleHigh',e.target.value)}/></label>
        {colorInput('High color','mapRuleHighColor','#1aab40')}
      </div>
    </>}
  </div>;
}

function Card({schema,visual,updateVisual,open,onToggle,categories}:{schema:FormattingCardSchema;visual:Visual;updateVisual:Props['updateVisual'];open:boolean;onToggle:()=>void;categories?:string[]}){
  const reset=()=>updateVisual(v=>{if(schema.id==='conditionalFormatting'){v.format.tableConditionalRules={};return}if(schema.id==='measureConditionalFormatting'){v.format.conditionalFormatRules=[];return}if(schema.id==='mapAreas'){v.format.mapColorScale='measure';v.format.mapColorMeasure=undefined;v.format.mapRuleLow=0;v.format.mapRuleHigh=100;v.format.mapRuleLowColor='#d64550';v.format.mapRuleMidColor='#facc15';v.format.mapRuleHighColor='#1aab40';v.bindings.color=[];return}schema.controls.forEach(control=>write(v,control.key,control.defaultValue))});
  return <details className="formatSchemaCard" open={open} onToggle={e=>{if((e.currentTarget as HTMLDetailsElement).open!==open)onToggle()}}><summary><span><ChevronDown size={14}/><b>{schema.title}</b></span><button title={`Reset ${schema.title}`} onClick={event=>{event.preventDefault();event.stopPropagation();reset()}}><RotateCcw size={13}/></button></summary><div className="formatSchemaBody">{schema.description&&<p>{schema.description}</p>}{schema.id==='dataFormat'?<DataFormat visual={visual} updateVisual={updateVisual}/>:schema.id==='individualCards'?<IndividualCardFormat visual={visual} updateVisual={updateVisual}/>:schema.id==='seriesColors'?<SeriesColorFormat visual={visual} updateVisual={updateVisual}/>:schema.id==='categoryColors'?<CategoryColorFormat visual={visual} updateVisual={updateVisual} categories={categories}/>:schema.id==='conditionalFormatting'?<TableConditionalFormat visual={visual} updateVisual={updateVisual}/>:schema.id==='measureConditionalFormatting'?<MeasureConditionalFormat visual={visual} updateVisual={updateVisual}/>:schema.id==='mapAreas'?<MapColorGrading visual={visual} updateVisual={updateVisual}/>:schema.controls.map(control=><Control key={control.key} schema={control} visual={visual} updateVisual={updateVisual}/>)}</div></details>;
}

export default function FormattingWorkspace({visual,updateVisual,mode='format',multiSelect,multiSelectSameType,categories}:Props){
  const[scope,setScope]=useState<Scope>('visual');
  const[query,setQuery]=useState('');
  const[expanded,setExpanded]=useState<Record<string,boolean>>({});
  const definition=VISUAL_DEFINITIONS[visual.type];
  useEffect(()=>{setQuery('');setExpanded({})},[visual.id,visual.type,mode]);
  const hideVisualScope = multiSelect && !multiSelectSameType;
  const cards=mode==='analytics'?(hideVisualScope?[]:definition.analyticsCards):(hideVisualScope||scope==='general')?generalFormattingCards(visual.type):definition.visualCards;
  const visible=useMemo(()=>cards.filter(card=>!query||`${card.title} ${card.description||''} ${card.controls.map(control=>control.label).join(' ')}`.toLowerCase().includes(query.toLowerCase())),[cards,query]);
  const currentScope=mode==='analytics'?'analytics':scope;
  const resetScope=()=>updateVisual(v=>{Object.entries(formattingDefaults(v.type,currentScope)).forEach(([key,value])=>write(v,key,value));if(currentScope==='visual'&&(v.type==='table'||v.type==='matrix'))v.format.tableConditionalRules={}});
  const resetAll=()=>updateVisual(v=>{Object.entries(formattingDefaults(v.type,'all')).forEach(([key,value])=>write(v,key,value));if(v.type==='table'||v.type==='matrix')v.format.tableConditionalRules={}});
  const defaultOpen=(card:FormattingCardSchema)=>expanded[card.id]??false;
  return <section className="formattingWorkspace" aria-label={mode==='analytics'?'Analytics':'Format visual'}>
    <div className="formattingContext"><div><Sparkles size={16}/><span><b>{definition.displayName}</b><small>{mode==='analytics'?'Analytics':'Format visual'}</small></span></div><button onClick={resetAll} title="Reset all formatting"><RotateCcw size={14}/>Reset all</button></div>
    {mode==='format'&&!hideVisualScope&&<div className="formatScopeTabs" role="tablist"><button role="tab" aria-selected={scope==='visual'} className={scope==='visual'?'active':''} onClick={()=>setScope('visual')}><SlidersHorizontal size={15}/>Visual</button><button role="tab" aria-selected={scope==='general'} className={scope==='general'?'active':''} onClick={()=>setScope('general')}>General</button></div>}
    <label className="formatSchemaSearch"><Search size={13}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder={mode==='analytics'?'Search analytics...':'Search format settings...'}/>{query&&<button className="formatSchemaSearchClear" onClick={()=>setQuery('')} title="Clear search">×</button>}</label>
    <div className="formatSchemaToolbar"><span>{visible.length} {mode==='analytics'?'analytics':'formatting'} cards</span><button onClick={resetScope}><RotateCcw size={12}/>Reset {mode==='analytics'?'analytics':scope}</button></div>
    <div className="formatSchemaCards">{visible.map(card=><Card key={card.id} schema={card} visual={visual} updateVisual={updateVisual} open={defaultOpen(card)} onToggle={()=>setExpanded(prev=>({...prev,[card.id]:!(prev[card.id]??false)}))} categories={categories}/>)}{!visible.length&&<div className="schemaEmptyNote">{mode==='analytics'&&!definition.analyticsCards.length?'Analytics options are not applicable to this visual.':`No settings match “${query}”.`}</div>}</div>
  </section>;
}
