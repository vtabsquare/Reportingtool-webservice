import React, {lazy,Suspense,useEffect,useMemo,useRef,useState} from 'react';
import ReactECharts from 'echarts-for-react';
import type { Visual } from '../types';
import { formatForField } from '../formatting';
import {resolveTableFieldValueColor} from '../conditionalFormatting';

const MapVisual=lazy(()=>import('./MapVisual'));

// Compute the auto mid-color for a diverging heatmap scale.
// Blends each endpoint toward white in HSL space, then averages the hues.
// This gives a proper near-white midpoint (like Power BI's default diverging scale)
// that maximizes visual distinction between low, mid, and high values.
function heatmapAutoMid(lo: string, hi: string): string {
  const hexToHsl = (hex: string) => {
    const c = hex.replace('#','');
    let r = parseInt(c.slice(0,2),16)/255, g = parseInt(c.slice(2,4),16)/255, b = parseInt(c.slice(4,6),16)/255;
    const max = Math.max(r,g,b), min = Math.min(r,g,b);
    let h = 0, s = 0, l = (max+min)/2;
    if (max !== min) {
      const d = max-min;
      s = l>0.5 ? d/(2-max-min) : d/(max+min);
      switch(max){ case r: h=((g-b)/d+(g<b?6:0))/6; break; case g: h=((b-r)/d+2)/6; break; case b: h=((r-g)/d+4)/6; break; }
    }
    return [h*360, s*100, l*100];
  };
  const hslToHex = ([h,s,l]: number[]) => {
    h/=360; s/=100; l/=100;
    const hue2rgb = (p:number,q:number,t:number) => { if(t<0)t+=1; if(t>1)t-=1; if(t<1/6)return p+(q-p)*6*t; if(t<1/2)return q; if(t<2/3)return p+(q-p)*(2/3-t)*6; return p; };
    if(s===0){ const v=Math.round(l*255); return '#'+[v,v,v].map(x=>x.toString(16).padStart(2,'0')).join(''); }
    const q=l<0.5?l*(1+s):l+s-l*s, p=2*l-q;
    return '#'+[hue2rgb(p,q,h+1/3),hue2rgb(p,q,h),hue2rgb(p,q,h-1/3)].map(x=>Math.round(x*255).toString(16).padStart(2,'0')).join('');
  };
  const [h1,s1] = hexToHsl(lo);
  const [h2,s2] = hexToHsl(hi);
  // Average hue (short way around circle), keep low saturation at high lightness → near-white tint
  let dh = h2 - h1; if(dh>180) dh-=360; if(dh<-180) dh+=360;
  const midH = ((h1 + dh*0.5)+360)%360;
  const midS = (s1+s2)*0.5 * 0.25; // mostly desaturated
  return hslToHex([midH, midS, 96]); // very high lightness = near-white
}

// ─── Scatter chart series builder (module-level to prevent TDZ in minified builds) ──
function buildScatterSeriesData(
  rows: any[],
  axisField: string,
  xField: string,
  yField: string,
  sizeField: string | undefined,
  legendField: string | undefined,
  palette: string[],
  accent: string,
  chartOpacity: number,
  dotSize: number,
  maxBubbleSize: number,
  marker: string,
  showMarkers: boolean,
  showLabels: boolean,
  labelColor: string,
  labelSize: number,
  labelPosition: string
): any[] {
  var maxSz = 1;
  if (sizeField) {
    for (var ri = 0; ri < rows.length; ri++) {
      var sv = Number(rows[ri][sizeField]) || 0;
      if (sv > maxSz) maxSz = sv;
    }
  }
  function dotSizeFn(d: any) {
    if (!sizeField) return dotSize || 10;
    return Math.max(5, (d[2] / maxSz) * (maxBubbleSize || 45));
  }
  function makePoint(r: any) {
    return {
      name: String(r[axisField] || ''),
      value: [
        Number(r[xField]) || 0,
        Number(r[yField]) || 0,
        sizeField ? Number(r[sizeField]) || 0 : 0
      ]
    };
  }
  if (!legendField) {
    return [{ type: 'scatter', name: yField || 'Scatter', data: rows.map(makePoint), symbol: marker, symbolSize: showMarkers?dotSizeFn:0, itemStyle: { color: accent, opacity: chartOpacity }, label:{show:showLabels,color:labelColor,fontSize:labelSize,position:labelPosition==='inside'?'inside':'top',formatter:(p:any)=>p.data?.name||p.value?.[1]} }];
  }
  var legendVals: string[] = [];
  for (var li = 0; li < rows.length; li++) {
    var lv = String(rows[li][legendField] || '');
    if (legendVals.indexOf(lv) < 0) legendVals.push(lv);
  }
  return legendVals.map(function(sn, si) {
    return {
      type: 'scatter',
      name: sn,
      data: rows.filter(function(r) { return String(r[legendField] || '') === sn; }).map(makePoint),
      symbol: marker,
      symbolSize: showMarkers?dotSizeFn:0,
      itemStyle: { color: palette[si % palette.length], opacity: chartOpacity },
      label:{show:showLabels,color:labelColor,fontSize:labelSize,position:'top',formatter:(p:any)=>p.data?.name||p.value?.[1]}
    };
  });
}

function resolveBoundNumber(row:any,field?:string):number|undefined{
  if(!row||!field)return undefined;
  const cleanKey=field.replace(/^(field:|numericField:|hierarchy:|measure:)/,'');
  const candidates=[field,cleanKey];
  const fieldLower=field.toLowerCase(),cleanLower=cleanKey.toLowerCase();
  const matched=Object.keys(row).find(key=>{const lower=key.toLowerCase();return lower===fieldLower||lower===cleanLower||lower.endsWith('.'+fieldLower)||lower.endsWith('.'+cleanLower)});
  if(matched)candidates.push(matched);
  for(const key of candidates){const value=row[key];if(value!==undefined&&value!==null&&value!==''){const numeric=Number(value);if(Number.isFinite(numeric))return numeric}}
  return undefined;
}

// ─── ChartScrollerWrapper ────────────────────────────────────────────────────
// Fix: own localStart state + drive ECharts zoom via dispatchAction() directly,
// bypassing the React render cycle entirely. The thumb drags freely at 60 fps.
function ChartScrollerWrapper({option,categories,horizontal,events,echartsKey,visibleCount}:{
  option:any;categories:any[];horizontal:boolean;events:any;echartsKey:string;visibleCount:number;
}) {
  const echartsRef=useRef<any>(null);
  const [localStart,setLocalStart]=useState(0);
  const visible=Math.max(3,Math.min(100,visibleCount||12));
  const needsScroll=categories.length>visible;
  const maxStart=Math.max(0,categories.length-visible);
  // Reset to beginning whenever the chart itself changes
  useEffect(()=>{setLocalStart(0);},[echartsKey]);
  const handleChange=(e:React.ChangeEvent<HTMLInputElement>)=>{
    const val=Number(e.target.value);
    setLocalStart(val);
    // Dispatch directly to ECharts — zero React re-renders, silky smooth drag
    const instance=echartsRef.current?.getEchartsInstance?.();
    if(instance&&categories.length>0){
      const start=(val/categories.length)*100;
      const end=((val+visible)/categories.length)*100;
      instance.dispatchAction({type:'dataZoom',dataZoomIndex:0,start,end});
    }
  };
  const handleDataZoom=(evt:any)=>{
    const instance=echartsRef.current?.getEchartsInstance?.();
    if(instance&&categories.length>0){
      const zoom=instance.getOption()?.dataZoom?.[0];
      if(zoom&&typeof zoom.start==='number')setLocalStart(Math.max(0,Math.min(maxStart,(zoom.start/100)*categories.length)));
    }
    if(events?.datazoom)events.datazoom(evt);
  };
  const chartEvents=useMemo(()=>({...events,datazoom:handleDataZoom}),[events,categories.length,visible,maxStart]);
  return (
    <div style={{display:'flex',flexDirection:horizontal?'row':'column',height:'100%',width:'100%'}}>
      <div style={{flex:1,minHeight:0,minWidth:0}}>
        <ReactECharts ref={echartsRef} key={echartsKey} opts={{renderer:'canvas'}} notMerge={true}
          style={{height:'100%',width:'100%'}} onEvents={chartEvents} option={option}/>
      </div>
      {needsScroll&&(
        <div className={`chartNativeScroller ${horizontal?'chartNativeScrollerVertical':''}`} style={{flexShrink:0,display:'flex',width:horizontal?'14px':'100%',height:horizontal?'100%':'24px',padding:horizontal?'12px 2px':'6px 12px 2px 12px'}}>
          <input type="range" min={0} max={maxStart} step={0.001} value={localStart}
            onChange={handleChange}
            style={horizontal?{writingMode:'vertical-lr',width:'6px',height:'100%',cursor:'pointer'}:{width:'100%',height:'16px',cursor:'pointer'}}
            aria-label="Scroll chart categories"/>
        </div>
      )}
    </div>
  );
}

function tableCssVariables(visual:Visual){
  return {'--table-text':visual.format.tableTextColor||'#242424','--table-font':visual.format.tableFontFamily||'Segoe UI','--table-align':visual.format.tableTextAlign||'left','--table-weight':visual.format.tableTextBold?700:400,'--table-style':visual.format.tableTextItalic?'italic':'normal','--table-wrap':visual.format.tableTextWrap?'normal':'nowrap','--table-bg':visual.format.tableBackground||'#ffffff','--table-font-size':`${visual.format.tableFontSize||11}px`,'--table-row-padding':`${visual.format.tableRowPadding??8}px`,'--table-alt':visual.format.tableAlternatingRows===false?(visual.format.tableBackground||'#ffffff'):visual.format.tableAlternateColor||'#f8fafc','--table-header-color':visual.format.tableHeaderColor||'#0f172a','--table-header-font':visual.format.tableHeaderFontFamily||'Segoe UI','--table-header-align':visual.format.tableHeaderTextAlign||'left','--table-header-weight':visual.format.tableHeaderBold===false?400:700,'--table-header-style':visual.format.tableHeaderItalic?'italic':'normal','--table-header-wrap':visual.format.tableHeaderWordWrap?'normal':'nowrap','--table-header-bg':visual.format.tableHeaderBackground||'#f1f5f9','--table-header-size':`${visual.format.tableHeaderFontSize||11}px`,'--table-grid':visual.format.tableGridVisible===false?'transparent':visual.format.tableGridColor||'#e2e8f0','--table-vgrid':visual.format.tableVerticalGridVisible?visual.format.tableGridColor||'#e2e8f0':'transparent','--table-grid-width':`${visual.format.tableGridWidth??1}px`,'--table-col-width':visual.format.tableAutoWidth===false?`${visual.format.tableColumnWidth||100}px`:'auto','--table-total-bg':visual.format.tableTotalBackground||'#f1f5f9','--table-total-color':visual.format.tableTotalTextColor||'#0f172a','--table-accent':visual.format.accent||'#118dff'} as any;
}

function mixRuleColor(from:string,to:string,ratio:number){
  const parse=(hex:string)=>{const raw=hex.replace('#','');const full=raw.length===3?raw.split('').map(x=>x+x).join(''):raw;return [0,2,4].map(i=>Number.parseInt(full.slice(i,i+2),16))};
  const a=parse(from),b=parse(to),t=Math.max(0,Math.min(1,ratio));
  if(a.some(Number.isNaN)||b.some(Number.isNaN))return ratio<.5?from:to;
  return '#'+a.map((value,i)=>Math.round(value+(b[i]-value)*t).toString(16).padStart(2,'0')).join('');
}

function tableConditionalStyle(visual:Visual,field:string,value:any,conditionalValues:Record<string,any>={}){
  const rule=visual.format.tableConditionalRules?.[field];
  const numeric=Number(value);
  const baseStyle: any = {
    '--cell-text': visual.format.tableTextColor || undefined,
    '--table-text': visual.format.tableTextColor || undefined,
    '--table-font-size': visual.format.tableFontSize ? `${visual.format.tableFontSize}px` : undefined,
    fontSize: visual.format.tableFontSize ? `${visual.format.tableFontSize}px` : undefined,
    fontFamily: visual.format.tableFontFamily || undefined,
    textAlign: visual.format.tableTextAlign || undefined,
    fontWeight: visual.format.tableTextBold ? 700 : undefined,
    fontStyle: visual.format.tableTextItalic ? 'italic' : undefined,
    whiteSpace: visual.format.tableTextWrap ? 'normal' : 'nowrap',
    color: visual.format.tableTextColor || undefined
  };
  if(!rule?.enabled)return baseStyle;
  if(rule.formatBy==='fieldValue'){
    const color=resolveTableFieldValueColor(rule,conditionalValues);
    if(!color)return baseStyle;
    if(rule.applyTo==='text')return {...baseStyle,__textColor:color};
    const style:any={...baseStyle,backgroundImage:'none','--cell-bg':color};
    if(rule.applyTo==='both')style['--cell-text']=colorContrast(color);
    return style;
  }
  if(!Number.isFinite(numeric))return baseStyle;
  const min=Number.isFinite(rule.min)?Number(rule.min):0,max=Number.isFinite(rule.max)?Number(rule.max):100;
  // 3-stop gradient: when midColor is set, use min→mid→max
  let color:string;
  if(rule.midColor){
    const midVal=Number.isFinite(rule.midValue)?Number(rule.midValue):(min+max)/2;
    const minColor=rule.minColor||'#ffffff';
    const midColor=rule.midColor;
    const maxColor=rule.maxColor||'#118dff';
    if(numeric<=midVal){
      const r=midVal===min?0:Math.max(0,Math.min(1,(numeric-min)/(midVal-min)));
      color=mixRuleColor(minColor,midColor,r);
    } else {
      const r=max===midVal?1:Math.max(0,Math.min(1,(numeric-midVal)/(max-midVal)));
      color=mixRuleColor(midColor,maxColor,r);
    }
  } else {
    const ratio=max===min?(numeric>=max?1:0):(numeric-min)/(max-min);
    color=mixRuleColor(rule.minColor||'#ffffff',rule.maxColor||'#118dff',ratio);
  }
  if(rule.applyTo==='text'){
    // Return __textColor so the td renderer wraps content in a span — this avoids !important CSS wars
    return {backgroundImage:'none',__textColor:color} as any;
  }
  const style:any={backgroundImage:'none'};
  style['--cell-bg']=color;
  if(rule.applyTo==='both'){
    const rgb=[1,3,5].map(i=>Number.parseInt(color.slice(i,i+2),16));
    style['--cell-text']=(rgb[0]*299+rgb[1]*587+rgb[2]*114)/1000>145?'#111827':'#ffffff';
  }
  return {...baseStyle, ...style};
}

function colorContrast(color:string){
  const hex=/^#([0-9a-f]{6})$/i.exec(color);
  if(!hex)return'#111827';
  const rgb=[0,2,4].map(index=>Number.parseInt(hex[1].slice(index,index+2),16));
  return(rgb[0]*299+rgb[1]*587+rgb[2]*114)/1000>145?'#111827':'#ffffff';
}

function matrixConditionalStyle(visual:Visual,field:string,value:any,conditionalValues:Record<string,any>){
  const style:any=tableConditionalStyle(visual,field,value,conditionalValues);
  if(style.__textColor){style.color=style.__textColor;style['--cell-text']=style.__textColor;delete style.__textColor}
  return style;
}

function PremiumDataTable({rows,formats,visual,matrix=false,conditionalValues={}}:{rows:any[];formats:any;visual:Visual;matrix?:boolean;conditionalValues?:Record<string,any>}){
  const[search,setSearch]=useState('');const[page,setPage]=useState(0);const[sort,setSort]=useState<{field:string,dir:'asc'|'desc'}|null>(null);const pageSize=20;
  const columns=rows.length?Object.keys(rows[0]):[];
  const filtered=useMemo(()=>{const q=search.trim().toLowerCase();let data=!q?rows:rows.filter(r=>columns.some(c=>String(r[c]??'').toLowerCase().includes(q)));if(sort){data=[...data].sort((a,b)=>{const av=a[sort.field],bv=b[sort.field];const cmp=typeof av==='number'&&typeof bv==='number'?av-bv:String(av??'').localeCompare(String(bv??''));return sort.dir==='asc'?cmp:-cmp})}return data},[rows,search,sort]);
  const pages=Math.max(1,Math.ceil(filtered.length/pageSize));const current=Math.min(page,pages-1);const visible=filtered.slice(current*pageSize,(current+1)*pageSize);
  const numericMax:Record<string,number>={};for(const c of columns){numericMax[c]=Math.max(...filtered.map(r=>typeof r[c]==='number'?Math.abs(r[c]):0),1)}
  const tableStyle=tableCssVariables(visual);
  const conditionalCell=(value:any,pct:number)=>{if(!visual.format.conditionalColorsEnabled)return `linear-gradient(90deg, color-mix(in srgb, ${visual.format.accent||'#118dff'} 18%, transparent) ${pct}%, transparent ${pct}%)`;const n=Number(value),color=n>0?(visual.format.conditionalPositiveColor||'#16a34a'):n<0?(visual.format.conditionalNegativeColor||'#dc2626'):(visual.format.conditionalZeroColor||'#64748b');return `linear-gradient(90deg, color-mix(in srgb, ${color} 20%, transparent) ${pct}%, transparent ${pct}%)`};
  const [colWidths, setColWidths] = useState<Record<string,number>>({});
  const startResize=(e:any,c:string)=>{
    e.stopPropagation();
    e.preventDefault();
    const startX = e.pageX;
    const th = e.target.closest('th');
    const tr = th?.closest('tr');
    setColWidths(prev => {
      if (Object.keys(prev).length === 0 && tr) {
        const initial: Record<string,number> = {};
        Array.from(tr.querySelectorAll('th')).forEach((t: any, i) => {
          if (columns[i]) initial[columns[i]] = t.getBoundingClientRect().width;
        });
        return initial;
      }
      return prev;
    });
    const startW = th ? th.getBoundingClientRect().width : 100;
    const move = (me: any) => {
      setColWidths(prev => ({...prev, [c]: Math.max(30, startW + (me.pageX - startX))}));
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  };
  const displayNames=(visual.format as any).fieldDisplayNames;
  const formatColumnHeaderLocal = (c: string) => formatColumnHeader(c, visual.format.tableShowPrefix === true, displayNames);
  return <div className={'premiumDataTable '+(matrix?'matrixMode':'')+(visual.format.tableHeaderVisible===false?' hideTableHeader':'')} style={tableStyle}>
    <div className="premiumTableToolbar"><div className="premiumTableSearch">⌕<input value={search} onChange={e=>{setSearch(e.target.value);setPage(0)}} placeholder="Search rows…"/></div><span>{filtered.length.toLocaleString()} rows</span></div>
    <div className="tableWrap premiumTable"><table style={{tableLayout:Object.keys(colWidths).length||visual.format.tableAutoWidth===false?'fixed':'auto',width:Object.keys(colWidths).length||visual.format.tableAutoWidth===false?'max-content':'100%',minWidth:'100%'}}><thead><tr>{columns.map(c=><th key={c} onClick={()=>setSort(s=>s?.field===c?{field:c,dir:s.dir==='asc'?'desc':'asc'}:{field:c,dir:'asc'})} style={{width:colWidths[c]||(visual.format.tableAutoWidth===false?visual.format.tableColumnWidth||100:undefined),position:'relative'}}>{formatColumnHeaderLocal(c)}<span>{sort?.field===c?(sort.dir==='asc'?' ↑':' ↓'):''}</span><div style={{cursor: 'col-resize', position:'absolute', right:0, top:0, bottom:0, width:8}} onMouseDown={(e)=>startResize(e,c)} /></th>)}</tr></thead><tbody>{visible.map((row,ri)=><tr key={ri}>{columns.map((c,ci)=>{const numeric=typeof row[c]==='number';const pct=numeric?Math.min(100,Math.abs(row[c])/numericMax[c]*100):0;const hasFormat=!!formats?.[c];const ruleStyle=tableConditionalStyle(visual,c,row[c],conditionalValues);const textColor=ruleStyle.__textColor;const userColor=textColor||visual.format.tableTextColor||undefined;const rowBg=visual.format.tableAlternatingRows===false?(visual.format.tableBackground||undefined):(ri%2!==0?(visual.format.tableAlternateColor||'#f8fafc'):(visual.format.tableBackground||undefined));const tdStyle:any={...(numeric?{backgroundImage:conditionalCell(row[c],pct)}:{}),...ruleStyle};if(textColor)delete tdStyle.__textColor;// Set CSS variables directly on td so !important CSS rules like var(--cell-text,#172033) pick up user settings
tdStyle['--cell-text']=userColor;tdStyle['--table-text']=userColor;tdStyle['--cell-bg']=ruleStyle['--cell-bg']||rowBg;tdStyle['--table-font-size']=visual.format.tableFontSize?`${visual.format.tableFontSize}px`:undefined;tdStyle.fontSize=visual.format.tableFontSize?`${visual.format.tableFontSize}px`:undefined;tdStyle.fontFamily=visual.format.tableFontFamily||undefined;tdStyle.textAlign=visual.format.tableTextAlign||undefined;tdStyle.fontWeight=visual.format.tableTextBold?700:undefined;tdStyle.fontStyle=visual.format.tableTextItalic?'italic':undefined;tdStyle.whiteSpace=visual.format.tableTextWrap?'normal':'nowrap';const content=numeric||hasFormat?formatForField(row[c],c,formats):String(row[c]??'');return <td key={c} className={matrix&&ci===0?'matrixRowHeader':''} style={tdStyle}>{content}</td>})}</tr>)}</tbody>
    {visual.format.tableGrandTotal!==false&&<tfoot><tr>{columns.map((c,i)=>{
      if(i===0) return <th key={c}>{visual.format.tableTotalLabel||'Total'}</th>;
      const isNum = filtered.some(r=>typeof r[c]==='number');
      if(!isNum) return <td key={c}></td>;
      const sum = filtered.reduce((acc, r)=>acc + (Number(r[c])||0), 0);
      return <td key={c}>{formatForField(sum, c, formats)}</td>;
    })}</tr></tfoot>}
    </table></div>
    <div className="premiumTablePager"><button onClick={()=>setPage(p=>Math.max(0,p-1))} disabled={current===0}>Previous</button><span>Page {current+1} of {pages}</span><button onClick={()=>setPage(p=>Math.min(pages-1,p+1))} disabled={current>=pages-1}>Next</button></div>
  </div>
}

export function formatColumnHeader(c: string, showTablePrefix = false, displayNames?: Record<string,string>) {
  if(displayNames && displayNames[c]) return displayNames[c];
  let display = c;
  if (!showTablePrefix && display.includes('.')) {
    display = display.split('.').pop() || display;
  }
  if (display.includes('::')) {
    const [core, agg] = display.split('::');
    if (!agg) return core;
    const lowerAgg = agg.toLowerCase();
    if (lowerAgg === 'sum') return `Sum of ${core}`;
    if (lowerAgg === 'average') return `Average of ${core}`;
    if (lowerAgg === 'min') return `Min of ${core}`;
    if (lowerAgg === 'max') return `Max of ${core}`;
    if (lowerAgg === 'count') return `Count of ${core}`;
    if (lowerAgg === 'count_distinct') return `Distinct Count of ${core}`;
    return `${agg} of ${core}`;
  }
  return display;
}

function PremiumMatrix({rows,visual,formats,conditionalValues={}}:{rows:any[];visual:Visual;formats:any;conditionalValues?:Record<string,any>}){
  const rowFields=visual.bindings.axis||[];
  const columnField=visual.bindings.legend?.[0];
  const valueFields=visual.bindings.values||[];
  const columnValues=columnField?Array.from(new Set(rows.map(r=>String(r[columnField]??'')))):[];
  const grouped=useMemo(()=>{
    const map=new Map<string,any>();
    for(const row of rows){
      const key=rowFields.map(f=>String(row[f]??'')).join('\u001f');
      if(!map.has(key))map.set(key,{key,labels:rowFields.map(f=>row[f]),rows:[]});
      map.get(key).rows.push(row);
    }
    return Array.from(map.values());
  },[rows,rowFields.join('|')]);
  const aggregate=(items:any[],field:string)=>{const nums=items.map(r=>Number(r[field])).filter(Number.isFinite);return nums.length?nums.reduce((a,b)=>a+b,0):items[0]?.[field]};
  return <div className={'premiumDataTable matrixMode'+(visual.format.tableHeaderVisible===false?' hideTableHeader':'')} style={tableCssVariables(visual)}>
    <div className="tableWrap premiumTable matrixTable"><table style={{tableLayout:visual.format.tableAutoWidth===false?'fixed':'auto',width:visual.format.tableAutoWidth===false?'max-content':'100%',minWidth:'100%'}}><thead>
      {visual.format.tableHeaderVisible!==false&&<tr>{rowFields.map(f=><th key={f} rowSpan={columnField?2:1}>{formatColumnHeader(f, visual.format.tableShowPrefix === true, (visual.format as any).fieldDisplayNames)}</th>)}{columnField?columnValues.map(c=><th key={c} colSpan={Math.max(1,valueFields.length)} className="matrixColumnGroup">{c}</th>):valueFields.map(v=><th key={v}>{formatColumnHeader(v, visual.format.tableShowPrefix === true, (visual.format as any).fieldDisplayNames)}</th>)}</tr>}
      {columnField&&visual.format.tableHeaderVisible!==false&&<tr>{columnValues.flatMap(c=>valueFields.map(v=><th key={`${c}:${v}`}>{formatColumnHeader(v, visual.format.tableShowPrefix === true)}</th>))}</tr>}
    </thead><tbody>{grouped.map((group:any)=><><tr key={group.key} style={{height:(visual.format.matrixRowPadding??8)*2+18}}>{rowFields.map((f,i)=><td key={f} className="matrixRowHeader" style={matrixConditionalStyle(visual,f,group.labels[i],conditionalValues)}><span style={{paddingLeft:visual.format.matrixSteppedLayout===false?0:i*14}}>{i>0&&visual.format.matrixSteppedLayout!==false?'↳ ':''}{visual.format.matrixExpandIcons!==false&&i===0?'⊞ ':''}{String(group.labels[i]??'')}</span></td>)}{columnField?columnValues.flatMap(c=>valueFields.map(v=>{const matching=group.rows.filter((r:any)=>String(r[columnField]??'')===c);const value=matching.length?aggregate(matching,v):undefined;return <td key={`${c}:${v}`} style={matrixConditionalStyle(visual,v,value,conditionalValues)}>{matching.length?formatForField(value,v,formats):'—'}</td>})):valueFields.map(v=>{const value=aggregate(group.rows,v);return <td key={v} style={matrixConditionalStyle(visual,v,value,conditionalValues)}>{formatForField(value,v,formats)}</td>})}</tr>{visual.format.matrixSubtotals!==false&&group.rows.length>1&&<tr className="matrixSubtotal"><th colSpan={Math.max(1,rowFields.length)}>Subtotal</th>{columnField?columnValues.flatMap(c=>valueFields.map(v=><th key={`${c}:${v}`}>{formatForField(aggregate(group.rows.filter((r:any)=>String(r[columnField]??'')===c),v),v,formats)}</th>)):valueFields.map(v=><th key={v}>{formatForField(aggregate(group.rows,v),v,formats)}</th>)}</tr>}</>)}</tbody>
    {visual.format.matrixGrandTotal!==false&&<tfoot><tr><th colSpan={Math.max(1,rowFields.length)}>{visual.format.tableTotalLabel||'Grand total'}</th>{columnField?columnValues.flatMap(c=>valueFields.map(v=><th key={`${c}:${v}`}>{formatForField(aggregate(rows.filter(r=>String(r[columnField]??'')===c),v),v,formats)}</th>)):valueFields.map(v=><th key={v}>{formatForField(aggregate(rows,v),v,formats)}</th>)}</tr></tfoot>}
    </table></div>
  </div>;
}

function Chart({ visual, rows, onPointClick, conditionalValues={} }: { visual: Visual; rows: any[]; onPointClick?:(field:string,value:any)=>void;conditionalValues?:Record<string,any> }) {
  if(visual.type==='map')return <Suspense fallback={<div className="visualEmpty">Loading map renderer…</div>}><MapVisual visual={visual} rows={rows} onPointClick={onPointClick}/></Suspense>;
  const axis = visual.bindings.axis?.[visual.drillLevel || 0] || visual.bindings.axis?.slice(-1)[0];
  const valueField = visual.bindings.values?.[0];
  const targetField = visual.bindings.target?.[0];
  const legendField=visual.bindings.legend?.[0];
  const accent = visual.format.accent || '#118dff';
  const formats = visual.format.fieldFormats || {};
  const fmt = (value: any, field = valueField) => formatForField(value, field, formats);
  const labelColor = visual.format.labelColor || '#242424';
  const labelSize = visual.format.labelFontSize || 10;
  const axisColor=visual.format.axisColor||'#616161';
  const axisSize=visual.format.axisFontSize||9;
  const lineWidth=visual.format.lineWidth||3;
  const smooth=visual.format.smoothLines!==false;
  const marker=visual.format.markerShape||'circle';
  const chartOpacity=Math.max(0,Math.min(1,(visual.format.chartOpacity??100)/100));
  const valueColor=(raw:any)=>{const n=Number(raw);if(!visual.format.conditionalColorsEnabled||!Number.isFinite(n))return accent;return n>0?(visual.format.conditionalPositiveColor||'#16a34a'):n<0?(visual.format.conditionalNegativeColor||'#dc2626'):(visual.format.conditionalZeroColor||'#64748b')};
  const fontFamily=`${visual.format.fontFamily||'Aptos'}, 'Segoe UI Variable', 'Segoe UI', sans-serif`;
  const gridLineColor=visual.format.gridLineColor||'#e6e6e6';
  const gridLineStyle=visual.format.gridLineStyle||'dotted';
  const axisTitleStyle={color:axisColor,fontSize:axisSize,fontFamily,fontWeight:600};
  const showXAxis = visual.format.xAxisVisible ?? visual.format.axesVisible !== false;
  const showYAxis = visual.format.yAxisVisible ?? visual.format.axesVisible !== false;
  const showXAxisTitle = visual.format.xAxisTitleVisible ?? visual.format.axisTitleVisible;
  const showYAxisTitle = visual.format.yAxisTitleVisible ?? visual.format.axisTitleVisible;
  const referenceMarkLine=(horizontal=false)=>visual.format.referenceLineEnabled?{symbol:'none',silent:true,lineStyle:{color:visual.format.referenceLineColor||'#d13438',type:'dashed',width:2},label:{show:true,formatter:visual.format.referenceLineLabel||'Reference',color:visual.format.referenceLineColor||'#d13438',fontSize:10},data:[horizontal?{xAxis:visual.format.referenceLineValue??0}:{yAxis:visual.format.referenceLineValue??0}]}:undefined;
  // categoryZoom: sets the INITIAL visible window only (start=0).
  // All subsequent scrolling is handled entirely inside ChartScrollerWrapper.
  const categoryZoom=(categories:any[],horizontal=false)=>{
    const visible=Math.max(3,Math.min(100,visual.format.visibleCategoryCount||12));
    const end=Math.min(100,(visible/Math.max(1,categories.length))*100);
    return [{type:'inside',start:0,end,
      xAxisIndex:horizontal?undefined:0,yAxisIndex:horizontal?0:undefined,
      zoomLock:true,moveOnMouseWheel:true,moveOnMouseMove:false}];
  };
  const tooltipBase:any={show:visual.format.tooltipEnabled!==false,backgroundColor:visual.format.tooltipBackground||'#ffffff',borderColor:visual.format.tooltipColor||'#242424',borderWidth:1,textStyle:{color:visual.format.tooltipColor||'#242424',fontFamily,fontSize:12},extraCssText:'box-shadow:0 6px 18px rgba(0,0,0,.16);border-radius:3px;'};
  const allValueFields=visual.bindings.values||[];
  const premiumPalette=[accent,...['#118dff','#12239e','#e66c37','#6b007b','#e044a7','#744ec2','#d9b300','#d64550','#197278','#1aab40'].filter(color=>color.toLowerCase()!==accent.toLowerCase())];
  const configuredSeriesColor=(field:string|undefined,index:number,fallback?:string)=>field&&visual.format.seriesColors?.[field]||fallback||premiumPalette[index%premiumPalette.length];
  const categoryOverrides=useMemo(()=>(visual.format as any).categoryColors||{},[visual.format]);
  const categoryColor=(name:any,index:number,raw:any)=>categoryOverrides[String(name)]||(visual.format.conditionalColorsEnabled?valueColor(raw):visual.format.categoricalColors===false?accent:premiumPalette[index%premiumPalette.length]);
  const onPointClickRef = useRef(onPointClick);
  useEffect(() => { onPointClickRef.current = onPointClick; }, [onPointClick]);
  
  // Format YYYY-MM date hierarchy month values as readable "Oct '24" labels.
  // The raw YYYY-MM value is preserved in the category data for correct click-to-filter;
  // only the displayed axis label is reformatted.
  const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const fmtCategoryLabel = (val: any): string => {
    const s = String(val ?? '');
    if (/^\d{4}-\d{2}$/.test(s)) {
      const [yr, mo] = s.split('-');
      return `${MONTH_ABBR[+mo - 1]} '${yr.slice(2)}`;
    }
    return s;
  };
  
  // ECharts must receive the pointer event without the designer selecting and
  // re-rendering the visual mid-drag; clicks still keep their existing slicer action.
  const chartEvents:Record<string,Function>|undefined=axis?{mousedown:(p:any)=>p?.event?.event?.stopPropagation?.(),click:(p:any)=>{const value=p?.name!==undefined&&p?.name!==''?p.name:rows[p?.dataIndex||0]?.[axis];if(value!==undefined)onPointClickRef.current?.(axis,value)}}:undefined;
  // Formatting updates must be reflected immediately. Remount the ECharts instance when
  // renderer-relevant formatting changes so stale tooltip/axis/legend state cannot survive.
  const formatRefreshKey=JSON.stringify(visual.format);


  const legendVisible = visual.format.legendVisible !== false;
  const legendPosition = visual.format.legendPosition || 'bottom';
  const legend: any = {
    show: legendVisible,
    textStyle: { color: visual.format.legendColor||axisColor, fontSize: visual.format.legendFontSize||11,fontFamily }
  };
  if (legendPosition === 'top') Object.assign(legend, { top: 0, left: 'center' });
  if (legendPosition === 'bottom') Object.assign(legend, { bottom: 0, left: 'center' });
  if (legendPosition === 'left') Object.assign(legend, { left: 0, top: 'middle', orient: 'vertical' });
  if (legendPosition === 'right') Object.assign(legend, { right: 0, top: 'middle', orient: 'vertical' });

  if (visual.type === 'kpi') {
    const seriesValues=rows.map(r=>Number(r?.[valueField||''])).filter(Number.isFinite);
    const current=seriesValues.length?seriesValues[seriesValues.length-1]:Number(rows?.[0]?.[valueField||'']);
    const explicitTarget=targetField?Number(rows?.[rows.length-1]?.[targetField]):Number.NaN;
    const previous=seriesValues.length>1?seriesValues[seriesValues.length-2]:Number.NaN;
    const compare=Number.isFinite(explicitTarget)?explicitTarget:previous;
    const diff=Number.isFinite(current)&&Number.isFinite(compare)?current-compare:Number.NaN;
    const pct=Number.isFinite(diff)&&compare!==0?diff/Math.abs(compare)*100:Number.NaN;
    const favorable=visual.format.favorableDirection||'up';
    const good=Number.isFinite(diff)&&((favorable==='up'&&diff>0)||(favorable==='down'&&diff<0));
    const bad=Number.isFinite(diff)&&((favorable==='up'&&diff<0)||(favorable==='down'&&diff>0));
    const indicatorColor=good?(visual.format.positiveColor||'#16a34a'):bad?(visual.format.negativeColor||'#dc2626'):(visual.format.neutralColor||'#64748b');
    const arrow=Number.isFinite(diff)?(diff>0?'↑':diff<0?'↓':'→'):'';
    const spark=seriesValues.slice(-18);
    const min=Math.min(...spark,0),max=Math.max(...spark,1),range=max-min||1;
    const points=spark.map((v,i)=>`${spark.length===1?50:(i/(spark.length-1))*100},${34-((v-min)/range)*26}`).join(' ');
    const metricLabel=valueField||'Metric';
    const icon=(metricLabel.match(/sales|revenue|amount|cost|profit|price/i)?'₹':metricLabel.match(/customer|employee|user|people/i)?'●':metricLabel.match(/order|invoice|ticket|case/i)?'▣':'◆');
    return <div className="premiumKpiCard">
      <div className="premiumKpiTop"><span className="premiumKpiIcon" style={{background:`${accent}16`,color:accent}}>{icon}</span><div><small>{metricLabel}</small>{visual.format.subtitleVisible&&visual.format.subtitle&&<span>{visual.format.subtitle}</span>}</div></div>
      <div className="premiumKpiMain">{visual.format.calloutVisible!==false&&<b style={{fontSize:visual.format.fontSize||38,color:visual.format.labelColor||'#0f172a',fontWeight:visual.format.calloutFontWeight||700}}>{fmt(current)}</b>}{visual.format.indicatorEnabled!==false&&arrow&&<div className="premiumKpiDelta" style={{color:indicatorColor}}><strong>{arrow}{Number.isFinite(pct)?` ${Math.abs(pct).toFixed(1)}%`:''}</strong><span>{targetField?`vs ${targetField}`:'vs previous'}</span></div>}</div>
      {spark.length>1&&<div className="premiumSparkline"><svg viewBox="0 0 100 38" preserveAspectRatio="none"><polyline points={points} fill="none" stroke={accent} strokeWidth="2.6" vectorEffect="non-scaling-stroke"/><polyline points={`0,38 ${points} 100,38`} fill={`${accent}10`} stroke="none"/></svg></div>}
    </div>;
  }

  if (visual.type === 'card') {
    const row=rows?.[0]||{};
    const fields=allValueFields.length?allValueFields:(valueField?[valueField]:[]);
    const autoFit=visual.format.cardAutoFit!==false;
    const columns=visual.format.cardLayoutDirection==='horizontal'?(autoFit?`repeat(auto-fit,minmax(130px,1fr))`:`repeat(${Math.max(1,visual.format.cardsPerRow||2)},minmax(0,1fr))`):'1fr';
    const justify={left:'flex-start',center:'center',right:'flex-end'}[visual.format.cardHorizontalAlign||'center'];
    const vertical={top:'flex-start',middle:'center',bottom:'flex-end'}[visual.format.cardVerticalAlign||'middle'];
    const trans=Math.max(0,Math.min(100,visual.format.cardBackgroundTransparency??0));
    const imagePosition=visual.format.cardImagePosition||'left';
    const image=visual.format.cardImageEnabled&&visual.format.cardImageUrl?<img className="powerCardImage" src={visual.format.cardImageUrl} alt="" style={{width:visual.format.cardImageSize||44,height:visual.format.cardImageSize||44,objectFit:visual.format.cardImageFit||'contain'}}/>:null;
    return <div className="powerCardGrid" style={{gridTemplateColumns:columns,columnGap:visual.format.cardGapX??10,rowGap:visual.format.cardGapY??10}}>{fields.map(field=>{const category=visual.format.categoryLabelText||(visual.format as any).fieldDisplayNames?.[field]||(field||'Value').replace(/^.*\./,'').replace(/_/g,' ');const referenceValue=targetField?row[targetField]:undefined;const categoryNode=visual.format.categoryLabelVisible!==false?<div className="powerCardCategory" style={{color:visual.format.categoryLabelColor||'#616161',fontSize:visual.format.categoryLabelFontSize||11,fontWeight:visual.format.categoryLabelFontWeight||400}}>{category}</div>:null;const referenceNode=visual.format.referenceLabelsVisible?<div className="powerCardReference" style={{color:visual.format.referenceLabelColor||'#616161',fontSize:visual.format.referenceLabelFontSize||10}}><span>{visual.format.referenceLabelText||'Reference'}</span><b>{targetField?formatForField(referenceValue,targetField,formats):'-'}</b></div>:null;return <div key={field} className={'powerCardItem '+(image?'image-'+imagePosition:'image-none')} style={{background:`color-mix(in srgb, ${visual.format.cardBackground||'#ffffff'} ${100-trans}%, transparent)`,border:visual.format.cardBorderVisible?`${visual.format.cardBorderWidth||1}px solid ${visual.format.cardBorderColor||'#e2e8f0'}`:'none',borderRadius:visual.format.cardCornerRadius??8,padding:visual.format.cardPadding??12,minHeight:visual.format.cardMinHeight||92,alignItems:justify,justifyContent:vertical,textAlign:visual.format.cardHorizontalAlign||'center'}}>{imagePosition==='background'&&image?<div className="powerCardImageBackground">{image}</div>:null}{['left','above'].includes(imagePosition)&&image}{visual.format.referenceLabelPosition==='above'&&referenceNode}{visual.format.categoryLabelPosition==='above'&&categoryNode}{visual.format.calloutVisible!==false&&<div className="advancedCardValue" style={{color:visual.format.labelColor||'#242424',fontFamily,fontSize:visual.format.fontSize||28,fontWeight:visual.format.calloutFontWeight||700,whiteSpace:visual.format.calloutWrap===false?'nowrap':'normal'}}>{formatForField(row[field],field,formats)}</div>}{visual.format.categoryLabelPosition!=='above'&&categoryNode}{visual.format.referenceLabelPosition!=='above'&&referenceNode}{['right','below'].includes(imagePosition)&&image}</div>})}</div>;
  }

  if (visual.type === 'multirowcard') {
    const row=rows?.[0]||{};
    const boundFields=allValueFields.length?allValueFields:Object.keys(row).slice(0,6);
    const fields=[...boundFields].sort((a,b)=>{const order=visual.format.cardSortOrder||'binding';if(order==='reverse')return boundFields.indexOf(b)-boundFields.indexOf(a);if(order==='valueAsc'||order==='valueDesc'){const delta=(Number(row[a])||0)-(Number(row[b])||0);return order==='valueAsc'?delta:-delta}return boundFields.indexOf(a)-boundFields.indexOf(b)});
    const tilePalette=['#2563eb','#10b981','#8b5cf6','#f59e0b','#0ea5e9','#ef4444','#14b8a6','#6366f1'];
    const iconFor=(field:string)=>field.match(/sales|revenue|amount|price|cost|profit/i)?'₹':field.match(/customer|employee|user|people/i)?'●':field.match(/product|item|sku/i)?'◆':field.match(/order|invoice|ticket|case/i)?'▣':'#';
    const niceValue=(field:string,value:any)=>{const n=Number(value);if(Number.isFinite(n)&&Number.isInteger(n)&&field.match(/customer|product|order|count|quantity/i))return n.toLocaleString();return formatForField(value,field,formats)};
    const autoFit=visual.format.cardAutoFit!==false,columns=visual.format.cardLayoutDirection==='vertical'?'1fr':autoFit?`repeat(auto-fit,minmax(${visual.format.cardMinWidth||150}px,1fr))`:`repeat(${Math.max(1,visual.format.cardsPerRow||2)},minmax(0,1fr))`;
    const justify={left:'flex-start',center:'center',right:'flex-end'}[visual.format.cardHorizontalAlign||'left'];const align={top:'flex-start',middle:'center',bottom:'flex-end'}[visual.format.cardVerticalAlign||'middle'];
    const trans=Math.max(0,Math.min(100,visual.format.cardBackgroundTransparency??0));
    return <div className="multiCardGrid premiumMultiCardGrid" style={{'--multi-grid-columns':columns,columnGap:visual.format.cardGapX??10,rowGap:visual.format.cardGapY??10} as any}>{fields.map((field,i)=>{const local=visual.format.cardStyles?.[field]||{},c=local.accent||tilePalette[i%tilePalette.length],iconPosition=visual.format.cardIconPosition||'left',labelOrder=visual.format.cardTitlePosition==='bottom'?3:1,valueOrder=visual.format.cardValuePosition==='top'?0:visual.format.cardValuePosition==='bottom'?4:2,localBorder=local.borderVisible??visual.format.cardBorderVisible;return <div className={'multiCardItem premiumMultiCardItem icon-'+iconPosition} key={field} style={{'--metric-color':c,'--multi-bg':`color-mix(in srgb, ${local.background||visual.format.cardBackground||'#ffffff'} ${100-trans}%, transparent)`,'--multi-border':localBorder?`${local.borderWidth||visual.format.cardBorderWidth||1}px solid ${local.borderColor||visual.format.cardBorderColor||'#e2e8f0'}`:'none','--multi-radius':`${local.cornerRadius??visual.format.cardCornerRadius??8}px`,'--multi-padding':`${visual.format.cardPadding??12}px`,'--multi-min-height':`${visual.format.cardMinHeight||92}px`,'--multi-label-color':local.labelColor||visual.format.categoryLabelColor||'#616161','--multi-label-size':`${visual.format.categoryLabelFontSize||11}px`,'--multi-label-weight':visual.format.categoryLabelFontWeight||400,'--multi-value-color':local.valueColor||visual.format.labelColor||'#242424','--multi-value-size':`${visual.format.fontSize||28}px`,'--multi-value-weight':visual.format.calloutFontWeight||700,justifyContent:align,textAlign:visual.format.cardHorizontalAlign||'left'} as any}><span className="premiumMultiIcon" style={{background:`${c}14`,color:c,width:visual.format.cardIconSize||34,height:visual.format.cardIconSize||34,fontSize:Math.max(12,(visual.format.cardIconSize||34)*.4),alignSelf:justify}}>{iconFor(field)}</span><div className="premiumMultiContent" style={{alignItems:justify}}>{visual.format.categoryLabelVisible!==false&&<span className="premiumMultiLabel" style={{order:labelOrder}}>{visual.format.categoryLabelText||(visual.format as any).fieldDisplayNames?.[field]||(field||'').replace(/^.*\./,'').replace(/_/g,' ')}</span>}{visual.format.calloutVisible!==false&&<b style={{order:valueOrder,whiteSpace:visual.format.calloutWrap===false?'nowrap':'normal'}}>{niceValue(field,row[field])}</b>}<small style={{order:5}}>Current value</small></div></div>})}</div>;
  }

  if (visual.type === 'progress') {
    const current = Number(rows?.[0]?.[valueField || ''] || 0);
    const minField = ((visual.bindings as any).min || [])[0];
    const maxField = ((visual.bindings as any).max || [])[0];
    const boundMin = minField ? Number(rows?.[0]?.[minField]) : undefined;
    const boundMax = maxField ? Number(rows?.[0]?.[maxField]) : undefined;
    const minimum = typeof visual.format.gaugeMin === 'number' ? visual.format.gaugeMin : (Number.isFinite(boundMin) ? boundMin! : 0);
    const boundTarget=resolveBoundNumber(rows?.[0],targetField);
    const rawTarget=boundTarget!==undefined?boundTarget:(typeof visual.format.gaugeTargetValue==='number'?visual.format.gaugeTargetValue:undefined);
    const hasTarget=visual.format.gaugeTargetVisible!==false&&rawTarget!==undefined&&Number.isFinite(rawTarget);
    const maximum = typeof visual.format.gaugeMax === 'number' ? visual.format.gaugeMax : (Number.isFinite(boundMax) ? boundMax! : Math.max(Math.abs(current) * 1.25, minimum + 1));
    const range = Math.max(maximum - minimum, 0.0001);
    
    const showPercent = visual.format.progressShowPercent !== false;
    const pct = Math.max(0, Math.min(100, ((current - minimum) / range) * 100));

    const targetPct = hasTarget ? Math.max(0, Math.min(100, ((rawTarget! - minimum) / range) * 100)) : undefined;

    return (
      <div className="progressVisual" style={{ padding: '0 12px', display: 'flex', flexDirection: 'column', justifyContent: 'center', height: '100%', boxSizing: 'border-box' }}>
        <div className="progressMetric" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '8px' }}>
          {visual.format.dataLabels!==false&&<b style={{ color: visual.format.labelColor || valueColor(current), fontSize: Math.max(10, visual.format.labelFontSize || visual.format.fontSize || 28) + 'px', lineHeight: 1 }}>
            {showPercent ? `${pct.toFixed(1)}%` : fmt(current)}
          </b>}
          <span style={{ fontSize: '13px', color: '#64748b', fontWeight: 500 }}>
            {valueField || 'Progress'}
          </span>
        </div>
        
        <div className="progressTrack" style={{ 
          position: 'relative', 
          background: visual.format.progressTrackColor || '#e2e8f0', 
          height: visual.format.progressThickness || 12,
          borderRadius: '999px',
          overflow: 'visible' 
        }}>
          <i style={{ 
            position: 'absolute', top: 0, left: 0, bottom: 0,
            width: `${pct}%`, 
            background: valueColor(current),
            borderRadius: '999px',
            transition: 'width 0.3s ease'
          }} />

          {hasTarget && (
            <>
                <div style={{
                  position: 'absolute', top: '50%', left: `${targetPct}%`, transform: 'translate(-50%, -50%)',
                  width: '4px', height: 'calc(100% + 8px)',
                  background: visual.format.targetColor || '#333333',
                  borderRadius: '2px', zIndex: 10, boxSizing:'border-box'
                }} />
              {visual.format.targetLabelVisible!==false&&<div style={{
                position: 'absolute', top: 'calc(100% + 4px)', left: `${targetPct}%`, transform: 'translateX(-50%)',
                color: visual.format.targetColor || '#333333', fontSize: '11px', fontWeight: 700, whiteSpace: 'nowrap'
              }}>
                ▲ {showPercent ? `${targetPct!.toFixed(1)}%` : fmt(rawTarget!)}
              </div>}
            </>
          )}
        </div>

        {visual.format.gaugeAxisLabelsVisible!==false&&<div style={{ position: 'relative', marginTop: '6px', height: '16px', fontSize: `${visual.format.gaugeAxisLabelFontSize||11}px`, color: visual.format.gaugeAxisLabelColor||'#64748b' }}>
          <span style={{ position: 'absolute', left: 0 }}>{showPercent ? '0%' : fmt(minimum)}</span>
          <span style={{ position: 'absolute', right: 0 }}>{showPercent ? '100%' : fmt(maximum)}</span>
        </div>}
      </div>
    );
  }

  if (visual.type === 'matrix') return <PremiumMatrix rows={rows} visual={visual} formats={formats} conditionalValues={conditionalValues}/>;

  if (visual.type === 'table') return <PremiumDataTable rows={rows} formats={formats} visual={visual} conditionalValues={conditionalValues}/>;

  // For pie/donut the category field is placed in bindings.legend (not axis).
  // Fall back to legendField so every chart type works regardless of which pane was used.
  const effectiveAxis = axis || legendField;
  const names = rows.map((row) => row[effectiveAxis || '']);
  const values = rows.map((row) => row[valueField || '']);
  const globalMaxCatW = Math.max(0, ...(names.length ? names : ['']).map(c => String(fmtCategoryLabel(c)).length)) * (axisSize * 0.6);
  const globalXNameGap = globalMaxCatW > 40 ? globalMaxCatW * 0.7 + 25 : 35;
  const tooltipFormatter = (params: any) => {
    const entries = Array.isArray(params) ? params : [params];
    const first = entries[0];
    const dataIndex = first?.dataIndex ?? 0;
    const row = rows[dataIndex] || {};
    const isAxis = Array.isArray(params);
    const title = isAxis && first?.name ? `${first.name}<br/>` : '';
    const main = entries.map((p: any) => {
      const label = isAxis ? (p.seriesName ? formatColumnHeader(p.seriesName) : '') : p.name;
      return `${p.marker || ''}${label ? label + (isAxis ? ': ' : '<br/>') : ''}<b>${fmt(p.value, p.seriesName || valueField)}</b>`;
    }).join('<br/>');
    const extras=(visual.bindings.tooltips||[]).map((field)=>`${field}: <b>${formatForField(row[field],field,formats)}</b>`).join('<br/>');
    return title + (extras ? `${main}<br/>${extras}` : main);
  };


  if (visual.type === 'treemap') {
    return <ReactECharts key={formatRefreshKey} opts={{renderer:'canvas'}} notMerge={true} style={{height:'100%'}} onEvents={chartEvents} option={{
      tooltip:{...tooltipBase,formatter:(p:any)=>`${p.name}<br/><b>${fmt(p.value)}</b>`},
       series:[{type:'treemap',roam:false,nodeClick:false,breadcrumb:{show:false},left:6,right:6,top:6,bottom:6,label:{show:!!visual.format.dataLabels,position:visual.format.labelPosition==='center'?'inside':'insideTop',align:'center',verticalAlign:visual.format.labelPosition==='center'?'middle':'top',color:labelColor,fontFamily,fontSize:labelSize,formatter:visual.format.labelPosition==='center'?(p:any)=>`${p.name}\n${fmt(p.value)}`:(p:any)=>`{name|${p.name}}\n{val|${fmt(p.value)}}`,rich:visual.format.labelPosition==='center'?undefined:{name:{color:labelColor,fontFamily,fontSize:Math.max(12,labelSize+2),fontWeight:'bold',padding:[0,0,3,0]},val:{color:labelColor,fontFamily,fontSize:labelSize}},overflow:'truncate'},labelLayout:(params:any)=>visual.format.labelPosition==='center'&&params.rect?{x:params.rect.x+params.rect.width/2,y:params.rect.y+params.rect.height/2,align:'center',verticalAlign:'middle'}:{},
        upperLabel:{show:false},itemStyle:{borderColor:'#ffffff',borderWidth:visual.format.treemapBorderWidth??2,gapWidth:visual.format.treemapGap??2},data:rows.map((r,i)=>{const name=String(r[effectiveAxis||'']),value=Number(r[valueField||'']||0);return{name,value,itemStyle:{color:categoryColor(name,i,value),opacity:chartOpacity}}})}]
    }}/>;
  }

  if (visual.type === 'funnel') {
    return <ReactECharts key={formatRefreshKey} opts={{renderer:'canvas'}} notMerge={true} style={{height:'100%'}} onEvents={chartEvents} option={{
      tooltip:{...tooltipBase,trigger:'item',formatter:tooltipFormatter},series:[{type:'funnel',left:'8%',top:12,bottom:12,width:'84%',sort:visual.format.funnelSort||'descending',gap:visual.format.funnelGap??2,
        label:{show:!!visual.format.dataLabels,color:labelColor,fontFamily,fontSize:labelSize,position:'right',formatter:(p:any)=>`${p.name}  ${fmt(p.value)}`},
        itemStyle:{borderColor:'#ffffff',borderWidth:1,opacity:chartOpacity},
        data:rows.map((r,i)=>{const name=String(r[effectiveAxis||'']),value=Number(r[valueField||'']||0);return{name,value,itemStyle:{color:categoryColor(name,i,value)}}})}]
    }}/>;
  }

  if (visual.type === 'waterfall') {
    const positiveColor = visual.format.positiveColor || '#34d399';
    const negativeColor = visual.format.negativeColor || '#fb7185';
    const totalColor = visual.format.totalColor || '#3b82f6';
    const otherColor = visual.format.otherColor || '#eab308';
    
    const catField = effectiveAxis || '';
    const bdField = visual.bindings.legend?.[0] || '';
    const valField = valueField || '';

    const finalNames: string[] = [];
    const helpers: number[] = [];
    const nums: any[] = [];
    
    if (!bdField) {
      let running = 0;
      rows.forEach(r => {
        const cat = String(r[catField] || '');
        const val = Number(r[valField] || 0);
        finalNames.push(cat);
        if (val >= 0) {
          helpers.push(running);
          nums.push({ value: val, itemStyle: { color: positiveColor }, raw: val });
        } else {
          helpers.push(running + val);
          nums.push({ value: Math.abs(val), itemStyle: { color: negativeColor }, raw: val });
        }
        running += val;
      });
      finalNames.push('Total');
      helpers.push(0);
      nums.push({ value: running, itemStyle: { color: totalColor }, raw: running });
    } else {
      const categories = Array.from(new Set(rows.map(r => String(r[catField] || ''))));
      const dataMap = new Map<string, Map<string, number>>();
      rows.forEach(r => {
        const c = String(r[catField] || '');
        const b = String(r[bdField] || '');
        const v = Number(r[valField] || 0);
        if (!dataMap.has(c)) dataMap.set(c, new Map());
        dataMap.get(c)!.set(b, v);
      });

      let running = 0;
      for (let i = 0; i < categories.length; i++) {
        const cat = categories[i];
        const currentMap = dataMap.get(cat) || new Map();
        let catTotal = 0;
        currentMap.forEach(v => catTotal += v);

        if (i === 0) {
          finalNames.push(cat);
          helpers.push(0);
          nums.push({ value: catTotal, itemStyle: { color: totalColor }, raw: catTotal });
          running = catTotal;
        } else {
          const prevCat = categories[i - 1];
          const prevMap = dataMap.get(prevCat) || new Map();
          const allBreakdowns = Array.from(new Set([...currentMap.keys(), ...prevMap.keys()]));
          let deltas: {name: any, delta: number, isOther?: boolean}[] = allBreakdowns.map(b => {
            const curVal = currentMap.get(b) || 0;
            const prevVal = prevMap.get(b) || 0;
            return { name: b, delta: curVal - prevVal };
          }).filter(d => Math.abs(d.delta) > 0.0001);

          deltas.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
          const maxBD = visual.format.maxBreakdowns || 5;
          if (deltas.length > maxBD) {
            const top = deltas.slice(0, maxBD);
            const rest = deltas.slice(maxBD);
            const otherDelta = rest.reduce((sum, d) => sum + d.delta, 0);
            if (Math.abs(otherDelta) > 0.0001) top.push({ name: 'Other', delta: otherDelta, isOther: true });
            deltas = top;
          }

          deltas.forEach(d => {
            finalNames.push(d.name);
            const val = d.delta;
            if (val >= 0) {
              helpers.push(running);
              nums.push({ value: val, itemStyle: { color: d.isOther ? otherColor : positiveColor }, raw: val });
            } else {
              helpers.push(running + val);
              nums.push({ value: Math.abs(val), itemStyle: { color: d.isOther ? otherColor : negativeColor }, raw: val });
            }
            running += val;
          });

          finalNames.push(cat);
          helpers.push(0);
          nums.push({ value: catTotal, itemStyle: { color: totalColor }, raw: catTotal });
          running = catTotal;
        }
      }
    }

    const maxValW = Math.max(0, ...nums.map(n => String(fmt(parseFloat(Number(n.raw||0).toFixed(3)))).length)) * (axisSize * 0.55);
    const wfYGap = showYAxis ? Math.max(45, maxValW + 15) : 45;
    return <ChartScrollerWrapper echartsKey={formatRefreshKey} events={chartEvents} categories={finalNames} horizontal={false} visibleCount={visual.format.visibleCategoryCount||12} option={{
      tooltip:{...tooltipBase,trigger:'axis',formatter:(p:any)=>`${p[1]?.name}<br/><b>${fmt(nums[p[1]?.dataIndex]?.raw)}</b>`},grid:{containLabel:true,left:showYAxisTitle?35:15,right:20,top:16,bottom:15+(showXAxisTitle?35:0)},dataZoom:categoryZoom(finalNames),
      xAxis:{show:showXAxis||showXAxisTitle,type:'category',data:finalNames,name:showXAxisTitle?(visual.format.xAxisTitle||catField||'Category'):'',nameLocation:'middle',nameGap:globalXNameGap,nameTextStyle:axisTitleStyle,axisLabel:{show:showXAxis,color:axisColor,fontSize:axisSize,fontFamily}},
      yAxis:{show:showYAxis||showYAxisTitle,type:'value',name:showYAxisTitle?(visual.format.yAxisTitle||valField||'Value'):'',nameLocation:'middle',nameGap:wfYGap,nameTextStyle:axisTitleStyle,axisLabel:{show:showYAxis,color:axisColor,fontSize:axisSize,formatter:(x:number)=>fmt(x)},splitLine:{show:visual.format.gridLines!==false,lineStyle:{color:gridLineColor,type:gridLineStyle}}},
      series:[
        {type:'bar',stack:'wf',silent:true,itemStyle:{color:'transparent'},data:helpers},
        {type:'bar',stack:'wf',barMaxWidth:visual.format.barWidth||38,data:nums,
         itemStyle:{borderRadius:[visual.format.barRadius??0,visual.format.barRadius??0,0,0]},
         label:{show:visual.format.dataLabels,color:labelColor,fontSize:labelSize,position:'top',formatter:(p:any)=>fmt(nums[p.dataIndex]?.raw)},markLine:referenceMarkLine(false)}
      ]
    }}/>;
  }

  if (visual.type === 'radar') {
    return <RadarChartWrapper 
      visual={visual} names={names} values={values} valueField={valueField} 
      gridLineColor={gridLineColor} accent={accent} lineWidth={lineWidth} 
      marker={marker} labelColor={labelColor} axisColor={axisColor} 
      fontFamily={fontFamily} fmt={fmt} labelSize={labelSize} axisSize={axisSize} 
    />;
  }

  if (visual.type === 'heatmap') {
    const xField = effectiveAxis || '';
    const yField = legendField || '';
    const valField = valueField || '';

    const xCategories = Array.from(new Set(rows.map(r => String(r[xField] || ''))));
    const yCategories = yField ? Array.from(new Set(rows.map(r => String(r[yField] || '')))) : [valField || 'Value'];
    
    const xMap = new Map(xCategories.map((c, i) => [c, i]));
    const yMap = new Map(yCategories.map((c, i) => [c, i]));

    let max = -Infinity;
    let min = Infinity;

    const gridData: [number, number, number | '-'][] = [];
    for (let x = 0; x < xCategories.length; x++) {
      for (let y = 0; y < yCategories.length; y++) {
        gridData.push([x, y, '-']);
      }
    }

    rows.forEach(r => {
      const xCat = String(r[xField] || '');
      const yCat = yField ? String(r[yField] || '') : (valField || 'Value');
      const xIdx = xMap.get(xCat) ?? 0;
      const yIdx = yMap.get(yCat) ?? 0;
      const v = Number(r[valField]) || 0;
      
      gridData[xIdx * yCategories.length + yIdx] = [xIdx, yIdx, v];
      
      if (v > max) max = v;
      if (v < min) min = v;
    });

    if (max === -Infinity) max = 1;
    if (min === Infinity) min = 0;
    if (max === min) max = min + 1;

    const gap = visual.format.heatmapCellGap ?? 1;
    const legendVisible = visual.format.legendVisible !== false;

    return <ChartScrollerWrapper echartsKey={formatRefreshKey} events={chartEvents} categories={yCategories} horizontal={true} visibleCount={visual.format.visibleCategoryCount||12} option={{
      tooltip:{...tooltipBase,position:'top', formatter:(p:any) => p.value[2] !== '-' ? `${xCategories[p.value[0]]} - ${yCategories[p.value[1]]}<br/><b>${fmt(p.value[2], valField)}</b>` : `${xCategories[p.value[0]]} - ${yCategories[p.value[1]]}<br/><b>No Data</b>`},
      grid:{left:legendVisible&&legendPosition==='left'?70:10,right:legendVisible&&legendPosition==='right'?70:10,top:legendVisible&&legendPosition==='top'?42:8,bottom:legendVisible&&legendPosition==='bottom'?44:8,containLabel:true},
      dataZoom:categoryZoom(yCategories,true),
      xAxis:{show:showXAxis,type:'category',position:'top',data:xCategories,axisLabel:{color:axisColor,fontSize:axisSize,rotate:xCategories.length>12?45:0},axisLine:{show:false},axisTick:{show:false},splitLine:{show:true,lineStyle:{color:'#ffffff',width:gap}}},
      yAxis:{show:showYAxis,type:'category',data:yCategories,inverse:true,axisLabel:{color:axisColor,fontSize:axisSize},axisLine:{show:false},axisTick:{show:false},splitLine:{show:true,lineStyle:{color:'#ffffff',width:gap}}},
      visualMap:{show:legendVisible,min,max,calculable:true,orient:legendPosition==='left'||legendPosition==='right'?'vertical':'horizontal',left:legendPosition==='left'?2:legendPosition==='right'?'auto':'center',right:legendPosition==='right'?2:'auto',top:legendPosition==='top'?2:legendPosition==='left'||legendPosition==='right'?'middle':'auto',bottom:legendPosition==='bottom'?2:'auto',textStyle:{color:visual.format.legendColor||axisColor,fontSize:Number(visual.format.legendFontSize)||11,fontFamily},formatter:(v:number)=>fmt(v,valField),inRange:{color:(()=>{const lo=visual.format.heatmapMinColor||'#00b050';const hi=visual.format.heatmapMaxColor||'#ff0000';const mid=visual.format.heatmapMidColor||heatmapAutoMid(lo,hi);return[lo,mid,hi]})()}},
      series:[{type:'heatmap',data:gridData,label:{show:visual.format.dataLabels,color:labelColor,fontSize:Number(labelSize)||11,formatter:(p:any)=>p.value[2]!=='-'?fmt(p.value[2],valField):''},itemStyle:{borderColor:'#ffffff',borderWidth:gap}}]
    }}/>;
  }

  if (visual.type === 'histogram') {
    const valField = effectiveAxis || '';
    const freqField = valueField || '';

    let labels: string[] = [];
    let barData: any[] = [];
    let isCategorical = false;
    let barWidth = '100%';

    // Check if the data is numerical or categorical
    let validNumbers = 0;
    rows.forEach(r => {
      const raw = r[valField];
      if (raw != null && raw !== '') {
         if (Number.isFinite(Number(raw))) validNumbers++;
      }
    });
    if (validNumbers === 0 && rows.length > 0) isCategorical = true;

    if (isCategorical) {
       // Categorical histogram (frequency bar chart)
       const catCounts: Record<string, number> = {};
       rows.forEach(r => {
          const raw = r[valField];
          const cat = raw != null && raw !== '' ? String(raw) : '(Blank)';
          const f = freqField ? Number(r[freqField] || 0) : 1;
          catCounts[cat] = (catCounts[cat] || 0) + f;
       });
       labels = Object.keys(catCounts);
       barData = labels.map(label => ({
         name: label,
         value: catCounts[label],
         itemStyle: { color: valueColor(catCounts[label]) }
       }));
       barWidth = 'auto'; // Give bars some breathing room for categorical data
    } else {
       // Existing numerical binning logic
       const dataPoints: {val: number, freq: number}[] = [];
       rows.forEach(r => {
         const v = Number(r[valField]);
         if (Number.isFinite(v)) {
           const f = freqField ? Number(r[freqField] || 0) : 1;
           dataPoints.push({val: v, freq: f});
         }
       });
       
       if (dataPoints.length > 0) {
           const binCount = Math.max(2, Math.min(100, visual.format.histogramBinCount || 10));
           const minVal = Math.min(...dataPoints.map(d => d.val));
           const maxVal = Math.max(...dataPoints.map(d => d.val));
           const step = (maxVal - minVal) / binCount || 1;
       
           const allBins: {lo: number, hi: number, count: number}[] = [];
           for (let i = 0; i < binCount; i++) {
             allBins.push({lo: minVal + i * step, hi: minVal + (i + 1) * step, count: 0});
           }
           dataPoints.forEach(d => {
             let idx = Math.floor((d.val - minVal) / step);
             if (idx >= binCount) idx = binCount - 1;
             if (idx < 0) idx = 0;
             allBins[idx].count += d.freq;
           });
       
           const precision = step < 1 ? 2 : (step < 100 ? 1 : 0);
           const edgeFmt = (v: number) => {
             if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(precision > 0 ? precision : 1)}M`;
             if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(precision > 0 ? precision : 1)}K`;
             return v.toFixed(precision);
           };
       
           labels = allBins.map(b => isCategorical ? b.lo.toString() : edgeFmt(b.lo));
           barData = allBins.map((b, i) => ({
             name: `${edgeFmt(b.lo)} - ${edgeFmt(b.hi)}`,
             value: b.count,
             itemStyle: {color: valueColor(b.count)}
           }));
       }
    }

    if (barData.length === 0) {
      return <ReactECharts key={formatRefreshKey} opts={{renderer:'canvas'}} notMerge={true} style={{height:'100%'}} option={{}}/>;
    }

    const maxValW = Math.max(0, ...barData.map(b => String(fmt(parseFloat(Number(b.value||0).toFixed(3)))).length)) * (axisSize * 0.55);
    const histYGap = showYAxis ? Math.max(42, maxValW + 15) : 42;
    return <ReactECharts key={formatRefreshKey} opts={{renderer:'canvas'}} notMerge={true} style={{height:'100%'}} onEvents={chartEvents} option={{
      tooltip:{...tooltipBase,trigger:'axis',formatter:(params:any)=>{const p=params[0];return p?`${p.name}<br/><b>${p.value}</b>`:''}},
      grid:{containLabel:true,left:showYAxisTitle?35:15,right:18,top:14,bottom:15+(showXAxisTitle?35:0)},
      xAxis:{show:showXAxis||showXAxisTitle,type:'category',data:labels,name:showXAxisTitle?(visual.format.xAxisTitle||valField||'Bins'):'',nameLocation:'middle',nameGap:48,nameTextStyle:axisTitleStyle,axisLabel:{show:showXAxis,color:axisColor,fontSize:axisSize,rotate:isCategorical?45:40,hideOverlap:true},axisTick:{alignWithLabel:true}},
      yAxis:{show:showYAxis||showYAxisTitle,type:'value',name:showYAxisTitle?(visual.format.yAxisTitle||(freqField?freqField.split('.').pop()?.split('::')[0]:'Frequency')):'',nameLocation:'middle',nameGap:histYGap,nameTextStyle:axisTitleStyle,axisLabel:{show:showYAxis,color:axisColor,fontSize:axisSize},splitLine:{show:visual.format.gridLines!==false,lineStyle:{color:gridLineColor,type:gridLineStyle}}},
      series:[{type:'bar',data:barData,
        label:{show:!!visual.format.dataLabels,color:labelColor,fontSize:labelSize,position:'top',formatter:(p:any)=>p.value>0?String(p.value):''},
        barWidth: barWidth,
        itemStyle:{borderColor:'#ffffff',borderWidth:1,opacity:chartOpacity,borderRadius:[visual.format.barRadius||0,visual.format.barRadius||0,0,0]},markLine:referenceMarkLine(false)}]
    }}/>;
  }

  if (visual.type === 'boxplot') {
    const sorted = [...values].map(v => Number(v) || 0).sort((a, b) => a - b);
    const q = (p: number) => sorted[Math.floor(p * (sorted.length - 1))];
    const data = [[q(0), q(0.25), q(0.5), q(0.75), q(1)]];
    const nums = values.map(v => Number(v) || 0);
    const maxValW = Math.max(0, ...nums.map(v => String(fmt(parseFloat(Number(v||0).toFixed(3)))).length)) * (axisSize * 0.55);
    const boxYGap = showYAxis ? Math.max(42, maxValW + 15) : 42;
    return <ReactECharts key={formatRefreshKey} opts={{renderer:'canvas'}} notMerge={true} style={{height:'100%'}} onEvents={chartEvents} option={{
      tooltip:{...tooltipBase,trigger:'item'},grid:{containLabel:true,left:showYAxisTitle?35:15,right:20,top:20,bottom:15+(showXAxisTitle?35:0)},xAxis:{show:showXAxis||showXAxisTitle,type:'category',data:[valueField||'Distribution'],name:showXAxisTitle?(visual.format.xAxisTitle||valueField||'Distribution'):'',nameLocation:'middle',nameGap:globalXNameGap,nameTextStyle:axisTitleStyle,axisLabel:{show:showXAxis,color:axisColor,fontSize:axisSize}},yAxis:{show:showYAxis||showYAxisTitle,type:'value',name:showYAxisTitle?(visual.format.yAxisTitle||'Value'):'',nameLocation:'middle',nameGap:boxYGap,nameTextStyle:axisTitleStyle,axisLabel:{show:showYAxis,color:axisColor,fontSize:axisSize,formatter:(x:number)=>fmt(x)},splitLine:{show:visual.format.gridLines!==false,lineStyle:{color:gridLineColor,type:gridLineStyle}}},
      series:[{type:'boxplot',data,itemStyle:{color:`${accent}55`,borderColor:accent,borderWidth:lineWidth},markLine:referenceMarkLine(false)},...(visual.format.boxShowOutliers===false?[]:[{type:'scatter',data:nums.filter(v=>v<q(.25)-1.5*(q(.75)-q(.25))||v>q(.75)+1.5*(q(.75)-q(.25))).map(v=>[0,v]),symbolSize:6,itemStyle:{color:accent}}])]
    }}/>;
  }

  if (visual.type === 'bubble') {
    const second=allValueFields[1];const secondVals=second?rows.map(r=>Number(r[second])||0):values.map((v,i)=>i+1);
    const max2=Math.max(...secondVals.map(Math.abs),1);
    const maxValW = Math.max(0, ...values.map(v => String(fmt(parseFloat(Number(v||0).toFixed(3)))).length)) * (axisSize * 0.55);
    const bubbleYGap = showYAxis ? Math.max(42, maxValW + 15) : 42;
    return <ReactECharts key={formatRefreshKey} opts={{renderer:'canvas'}} notMerge={true} style={{height:'100%'}} onEvents={chartEvents} option={{
      tooltip:{...tooltipBase,trigger:'item',formatter:(p:any)=>`${p.name}<br/>${valueField}: <b>${fmt(p.value[1])}</b>${second?`<br/>${second}: ${formatForField(p.value[2],second,formats)}`:''}`},
      grid:{containLabel:true,left:showYAxisTitle?35:15,right:25,top:25,bottom:15+(showXAxisTitle?35:0)},xAxis:{show:showXAxis||showXAxisTitle,type:'category',data:names,name:showXAxisTitle?(visual.format.xAxisTitle||effectiveAxis||'Category'):'',nameLocation:'middle',nameGap:globalXNameGap,nameTextStyle:axisTitleStyle,axisLabel:{show:showXAxis,color:axisColor,fontSize:axisSize}},yAxis:{show:showYAxis||showYAxisTitle,type:'value',name:showYAxisTitle?(visual.format.yAxisTitle||valueField||'Value'):'',nameLocation:'middle',nameGap:bubbleYGap,nameTextStyle:axisTitleStyle,axisLabel:{show:showYAxis,color:axisColor,fontSize:axisSize,formatter:(x:number)=>fmt(x)},splitLine:{show:visual.format.gridLines!==false,lineStyle:{color:gridLineColor,type:gridLineStyle}}},
      series:[{type:'scatter',data:values.map((v,i)=>[names[i],Number(v)||0,secondVals[i]]),symbol:marker,symbolSize:visual.format.showDataPoints===false?0:(d:any)=>(visual.format.bubbleMinSize??10)+Math.abs(d[2])/max2*((visual.format.bubbleMaxSize??45)-(visual.format.bubbleMinSize??10)),itemStyle:{color:(p:any)=>valueColor(p.value?.[1]),opacity:chartOpacity},label:{show:!!visual.format.dataLabels,color:labelColor,fontSize:labelSize,position:'top',formatter:(p:any)=>fmt(p.value[1])},markLine:referenceMarkLine(false)}]
    }}/>;
  }

  if (visual.type === 'combo') {
      const second=visual.bindings.target?.[0];const secondData=second?rows.map(r=>r[second]):[];
      const primaryColor=configuredSeriesColor(valueField,0,accent),secondaryColor=configuredSeriesColor(second,1,visual.format.comboSecondaryColor||'#f59e0b');
      const xMargin = (legendVisible && legendPosition === 'bottom' ? 45 : 15) + (showXAxisTitle ? 35 : 0);
      const lgLeft = (legendVisible && legendPosition === 'left' ? 85 : 15) + (showYAxisTitle ? 50 : 0);
      const lgRight = (legendVisible && legendPosition === 'right' ? 85 : 15);
      const maxValW = Math.max(0, ...values.map(v => String(fmt(parseFloat(Number(v||0).toFixed(3)))).length)) * (axisSize * 0.55);
      const comboYGap = showYAxis ? Math.max(42, maxValW + 15) : 42;
      return <ChartScrollerWrapper echartsKey={formatRefreshKey} events={chartEvents} categories={names} horizontal={false} visibleCount={visual.format.visibleCategoryCount||12} option={{
      color: premiumPalette,
      tooltip:{...tooltipBase,trigger:'axis'},legend:{...legend,data:[valueField,second].filter(Boolean)},grid:{containLabel:true,left:(legendVisible && legendPosition === 'left' ? 85 : 15) + (showYAxisTitle ? 25 : 0),right:lgRight,top:30,bottom:xMargin},dataZoom:categoryZoom(names),
      xAxis:{show:showXAxis||showXAxisTitle,type:'category',data:names,name:showXAxisTitle?(visual.format.xAxisTitle||effectiveAxis||'Category'):'',nameLocation:'middle',nameGap:globalXNameGap,nameTextStyle:axisTitleStyle,axisLabel:{show:showXAxis,color:axisColor,fontSize:axisSize}},
      yAxis:[{show:showYAxis||showYAxisTitle,type:'value',name:showYAxisTitle?(visual.format.yAxisTitle||valueField||'Value'):'',nameLocation:'middle',nameGap:comboYGap,nameTextStyle:axisTitleStyle,axisLabel:{show:showYAxis,color:axisColor,fontSize:axisSize,formatter:(x:number)=>fmt(x,valueField)},splitLine:{show:visual.format.gridLines!==false,lineStyle:{color:gridLineColor,type:gridLineStyle}}},...(second?[{show:(showYAxis||showYAxisTitle)&&visual.format.comboSecondaryAxisVisible!==false,type:'value',name:showYAxisTitle?formatColumnHeader(second):'',nameLocation:'middle',nameGap:comboYGap,nameTextStyle:{...axisTitleStyle,color:secondaryColor},axisLabel:{show:showYAxis,color:secondaryColor,fontSize:axisSize,formatter:(x:number)=>formatForField(x,second,formats)},splitLine:{show:false}}]:[])],
      series:[{name:valueField,type:'bar',clip:true,data:values.map(v=>({value:v,itemStyle:{color:visual.format.conditionalColorsEnabled?valueColor(v):primaryColor}})),label:{show:!!visual.format.dataLabels,color:labelColor,fontSize:labelSize,position:visual.format.labelPosition==='outside'?'top':'inside',distance:5,formatter:(p:any)=>Number(p.value)===0?'':fmt(p.value)},labelLayout:{moveOverlap:'shiftY'},barMaxWidth:visual.format.barWidth||34,itemStyle:{color:primaryColor,opacity:chartOpacity,borderRadius:[visual.format.barRadius??0,visual.format.barRadius??0,0,0]},markLine:referenceMarkLine(false)},
       ...(second?[{name:second,type:'line',clip:true,yAxisIndex:1,data:secondData,smooth,lineStyle:{color:secondaryColor,width:lineWidth},itemStyle:{color:secondaryColor},symbol:visual.format.showDataPoints===false?'none':marker,symbolSize:visual.format.dataPointSize||7,label:{show:!!visual.format.dataLabels,color:visual.format.comboSecondaryLabelColor||labelColor,fontSize:labelSize,position:'top',distance:8,formatter:(p:any)=>Number(p.value)===0?'':formatForField(p.value,second,formats)},labelLayout:{moveOverlap:'shiftY'}}]:[])]
    }}/>;
  }

  if (visual.type === 'donut' || visual.type === 'pie') {
    const total=values.reduce((a:any,b:any)=>Number(a||0)+Number(b||0),0);
    // Pie and donut legends are intentionally horizontal. Old reports that saved a
    // side position are migrated at render time to bottom, keeping them usable.
    const autoLegend=legendPosition==='top'?'top':'bottom';
    const legendBand=legendVisible?44:6;
    const premiumLegend:any={show:legendVisible,type:'scroll',orient:'horizontal',left:'center',width:'92%',height:28,textStyle:{color:visual.format.legendColor||axisColor,fontSize:visual.format.legendFontSize||11,fontWeight:600,fontFamily},itemWidth:12,itemHeight:12,itemGap:14,pageIconSize:10,pageTextStyle:{color:visual.format.legendColor||axisColor}};
    if(autoLegend==='top')Object.assign(premiumLegend,{top:2,bottom:'auto'});
    else Object.assign(premiumLegend,{bottom:2,top:'auto'});
    const center:any=['50%','50%'];
    return (
      <ReactECharts key={formatRefreshKey} opts={{renderer:'canvas'}} notMerge={true}
        style={{ height: '100%' }}
        onEvents={chartEvents}
        option={{
          animationDuration: 750,
          animationEasing:'cubicOut',
          color: premiumPalette,
          tooltip: {
            ...tooltipBase,
            trigger: 'item',
            padding:[10,12],
            formatter: (p: any) => {
              const row=rows[p.dataIndex]||{};
              const extras=(visual.bindings.tooltips||[]).map((field)=>`${field}: <b>${formatForField(row[field],field,formats)}</b>`).join('<br/>');
              return `<b>${p.name}</b><br/>${p.marker}${fmt(p.value)} &nbsp; <span style="color:#94a3b8">${p.percent}%</span>${extras?'<br/>'+extras:''}`;
            }
          },
          legend:premiumLegend,
          graphic: visual.type==='donut'&&values.length?[{type:'text',left:'center',top:'42%',style:{text:fmt(total),fill:'#0f172a',fontSize:24,fontWeight:800,textAlign:'center',textVerticalAlign:'middle'},z:10},{type:'text',left:'center',top:'52%',style:{text:(valueField||'Total').replace(/^.*\./,''),fill:'#64748b',fontSize:10,fontWeight:600,textAlign:'center',textVerticalAlign:'middle'},z:10}]:[],
          series: [
            {
              type: 'pie',
               left:8,
               right:8,
               top:autoLegend==='top'?legendBand:6,
               bottom:autoLegend==='bottom'?legendBand:6,
              radius: visual.type === 'donut' ? [`${Math.max(10,Math.min(85,visual.format.donutInnerRadius??55))}%`, `${visual.format.pieOuterRadius??72}%`] : `${visual.format.pieOuterRadius??72}%`,
              startAngle:90-(visual.format.pieRotation??0),
              center,
              minAngle:2,
              avoidLabelOverlap:true,
              data: rows.map((row,i) => {const name=row[axis || legendField || ''],value=Number(row[valueField || '']||0);return {name,value,itemStyle:{color:categoryColor(name,i,value)}}}),
              itemStyle: { borderColor: '#ffffff', borderWidth: visual.format.pieSliceGap??3,borderRadius:5,shadowBlur:4,shadowColor:'rgba(15,23,42,.08)',opacity:chartOpacity },
              emphasis:{scale:true,scaleSize:8,itemStyle:{shadowBlur:18,shadowColor:'rgba(15,23,42,.22)'}},
              labelLine:{show:!!visual.format.dataLabels,length:13,length2:10,lineStyle:{width:1.4}},
              label: {
                show: !!visual.format.dataLabels,
                position:'outside',
                color: labelColor,
                fontSize: Math.max(10, visual.format.labelFontSize || labelSize),
                 edgeDistance:8,
                 bleedMargin:4,
                formatter: (p: any) => {
                  const ov=categoryOverrides[p.name]||{};
                  const sz=Math.max(10, ov.size || visual.format.labelFontSize || labelSize);
                  const clr=ov.color || labelColor;
                  const fstw=ov.bold?'bold':'700';
                  const sndw=ov.bold?'bold':'600';
                  const fsti=ov.italic?'italic':'normal';
                  return `{name_${p.dataIndex}|${p.name}}\n{value_${p.dataIndex}|${fmt(p.value)} (${p.percent}%)} `;
                },
                rich: rows.reduce((acc, r, i) => {
                   const name = r[effectiveAxis||''];
                   const ov:any = { color: categoryOverrides[String(name)] };
                  const sz = Math.max(10, ov.size || visual.format.labelFontSize || labelSize);
                  const clr = ov.color || labelColor;
                  const fstw = ov.bold ? 'bold' : 700;
                  const sndw = ov.bold ? 'bold' : 600;
                  const fsti = ov.italic ? 'italic' : 'normal';
                  acc[`name_${i}`] = { fontWeight: fstw, fontStyle: fsti, color: clr, fontSize: sz, lineHeight: sz * 1.25 };
                  acc[`value_${i}`] = { fontWeight: sndw, fontStyle: fsti, color: clr, fontSize: Math.max(10, sz - 1), lineHeight: Math.max(10, sz - 1) * 1.25 };
                  return acc;
                 }, {} as any)
               },
               labelLayout:{hideOverlap:true,moveOverlap:'shiftY'}
            }
          ]
        }}
      />
    );
  }

  if (visual.type === 'gauge') {
    const numberValue = Number(values[0] || 0);
    const minField = ((visual.bindings as any).min || [])[0];
    const maxField = ((visual.bindings as any).max || [])[0];
    const boundMin = minField ? Number(rows?.[0]?.[minField]) : undefined;
    const boundMax = maxField ? Number(rows?.[0]?.[maxField]) : undefined;
    const boundTarget=resolveBoundNumber(rows?.[0],targetField);
    const rawTarget=boundTarget!==undefined?boundTarget:(typeof visual.format.gaugeTargetValue==='number'?visual.format.gaugeTargetValue:undefined);
    const hasTarget=visual.format.gaugeTargetVisible!==false&&rawTarget!==undefined&&Number.isFinite(rawTarget);
    const minimum = typeof visual.format.gaugeMin === 'number' ? visual.format.gaugeMin : (Number.isFinite(boundMin) ? boundMin! : 0);
    const autoMaxCandidates=[Math.abs(numberValue)*1.25,minimum+1];
    if(hasTarget)autoMaxCandidates.push(Math.abs(rawTarget!)*1.15);
    const maximum = typeof visual.format.gaugeMax === 'number' ? visual.format.gaugeMax : (Number.isFinite(boundMax) ? boundMax! : Math.max(...autoMaxCandidates));
    const thickness = visual.format.gaugeThickness ?? 30;
    const showPercent = visual.format.gaugeShowPercent === true;

    // When in percent mode, remap value to 0–100 scale
    const range = Math.max(maximum - minimum, 0.0001);
    const displayValue = showPercent ? Math.min(100, Math.max(0, ((numberValue - minimum) / range) * 100)) : numberValue;
    const displayMin = showPercent ? 0 : minimum;
    const displayMax = showPercent ? 100 : maximum;
    const minLabel = showPercent ? '0%' : fmt(minimum);
    const maxLabel = showPercent ? '100%' : fmt(maximum);

    return (
      <ReactECharts key={formatRefreshKey} opts={{renderer:'canvas'}} notMerge={true}
        style={{ height: '100%' }}
        onEvents={chartEvents}
        option={{
          series: [
            (() => {
              const trackColor = visual.format.gaugeTrackColor || '#e2e8f0';

              return {
                type: 'gauge',
                z: 2,
                min: displayMin, max: displayMax,
                startAngle: 180, endAngle: 0,
                center: ['50%', '72%'], radius: '90%',
                progress: { show: true, width: thickness },
                axisLine: {
                  lineStyle: {
                    width: thickness,
                    color: [[1, trackColor]]
                  }
                },
                 axisLabel: {
                   show: visual.format.gaugeAxisLabelsVisible!==false, distance: thickness + 8,
                   color: visual.format.gaugeAxisLabelColor || '#64748b',
                   fontSize: visual.format.gaugeAxisLabelFontSize || 11,
                  formatter: (val: number) => (val === displayMin || val === displayMax) ? (val === displayMin ? minLabel : maxLabel) : ''
                },
                axisTick: { show: false },
                splitLine: { show: false },
                 pointer: {show:true,icon:'path://M-2 0 L2 0 L1 -70 L-1 -70 Z',length:'68%',width:5,itemStyle:{color:accent}},
                 anchor:{show:true,size:10,itemStyle:{color:accent,borderColor:'#ffffff',borderWidth:2}},
                detail: {
                  valueAnimation: true,
                  color: visual.format.labelColor || '#0f172a',
                   show:visual.format.dataLabels!==false,
                   fontSize: visual.format.labelFontSize || visual.format.fontSize || 28,
                  offsetCenter: [0, '35%'],
                  formatter: (x: number) => showPercent ? `${x.toFixed(1)}%` : fmt(numberValue)
                },
                data: [{ value: displayValue, name: valueField || '' }],
                itemStyle: { color: accent },
                title: { show: false }
              };
            })(),
            // Draw the target notch above the progress arc so it remains visible at and beyond target.
            ...(hasTarget ? [(() => {
              const targetVal=rawTarget!;
              const displayTarget = showPercent
                ? Math.min(100, Math.max(0, ((targetVal - minimum) / range) * 100))
                : targetVal;
              const targetLabel = showPercent
                ? `${displayTarget.toFixed(1)}%`
                : fmt(targetVal,targetField);

              const targetRatio = Math.max(0, Math.min(1, (targetVal - minimum) / range));
              // Half-width of the notch in ratio units — 1.2% of arc = single visible tick
              const hw = 0.012;
              const lo = Math.max(0, targetRatio - hw);
              const hi = Math.min(1, targetRatio + hw);
              const tickColor = visual.format.targetColor || '#333333';

              // Build color segments: transparent | tick color | transparent
              // This renders a single colored notch on the arc at the target position
              const colorSegments: [number, string][] =
                lo === 0
                  ? [[hi, tickColor], [1, 'transparent']]
                  : hi === 1
                    ? [[lo, 'transparent'], [1, tickColor]]
                    : [[lo, 'transparent'], [hi, tickColor], [1, 'transparent']];

              // Position the target label beyond the outside edge of the arc.
              const angle = (1 - targetRatio) * Math.PI;
              const labelRadius = 110;
              const offsetX = Math.cos(angle) * labelRadius;
              const offsetY = -Math.sin(angle) * labelRadius;

              return {
                type: 'gauge',
                z: 10,
                min: displayMin, max: displayMax,
                startAngle: 180, endAngle: 0,
                center: ['50%', '72%'], radius: '91%',
                progress: { show: false },
                axisLine: {
                  show: true,
                  lineStyle: {
                    width: thickness + 8,
                    color: colorSegments
                  }
                },
                axisTick: { show: false },
                splitLine: { show: false },
                pointer: {show:false},
                anchor: { show: false },
                axisLabel: { show: false },
                title: { show: false },
                data: [{ value: displayTarget }],
                detail: {
                  show: visual.format.targetLabelVisible !== false,
                  color: tickColor,
                  fontSize: Math.max(9, Math.min(14, (visual.format.labelFontSize || 11) - 2)),
                  fontWeight: 600,
                  offsetCenter: [`${offsetX}%`, `${offsetY}%`],
                  formatter: () => `Target ${targetLabel}`
                },
              };
            })()] : [])
          ]
        }}
      />
    );
  }

  if (visual.type === 'scatter') {
    var scatterXF = ((visual.bindings as any).x || [])[0] as string | undefined;
    var scatterYF = valueField || '';
    var scatterSzF = ((visual.bindings as any).size || [])[0] as string | undefined;
    var scatterLgF = ((visual.bindings as any).legend || [])[0] as string | undefined;
    var scatterAxisF = axis || '';

    const maxValLen = Math.max(0, ...values.map(v => String(fmt(parseFloat(Number(v||0).toFixed(3)))).length));
    const scatterYGap = showYAxis ? (maxValLen * axisSize * 0.55 + 15) : 20;

    if (!scatterXF) {
      // Legacy fallback - no X measure bound yet
      return (
        <ReactECharts key={formatRefreshKey} opts={{renderer:'canvas'}} notMerge={true}
          style={{ height: '100%' }}
          onEvents={chartEvents}
          option={{
            tooltip: { ...tooltipBase, trigger: 'item', formatter: tooltipFormatter },
            grid:{containLabel:true,left:showYAxisTitle?35:15,right:20,top:18,bottom:15+(showXAxisTitle?35:0)},
            xAxis: { type: 'category', data: names, show: showXAxis||showXAxisTitle, name: showXAxisTitle?(visual.format.xAxisTitle||axis||'Category'):'', nameLocation:'middle', nameGap:30, nameTextStyle:axisTitleStyle, axisLabel: { show:showXAxis, color: axisColor, fontSize: axisSize, fontFamily } },
            yAxis: { show: showYAxis||showYAxisTitle, type: 'value', name: showYAxisTitle?(visual.format.yAxisTitle||valueField||'Value'):'', nameLocation:'middle', nameGap:scatterYGap, nameTextStyle:axisTitleStyle, axisLabel: { show:showYAxis, color: axisColor, fontSize: axisSize, fontFamily, formatter: (v: number) => fmt(v) }, splitLine: { show: visual.format.gridLines !== false, lineStyle: { color: gridLineColor, type: gridLineStyle } } },
            series: [{ type: 'scatter', data: values, symbol:marker, symbolSize: visual.format.showDataPoints===false?0:(visual.format.dataPointSize || 10), itemStyle: { color: accent, shadowBlur: 8, shadowColor: `${accent}55`, opacity: chartOpacity }, label: { show: !!visual.format.dataLabels, color: labelColor, fontSize: labelSize, position:'top',formatter: (p: any) => fmt(p.value) }, markLine: referenceMarkLine(false) }]
          }}
        />
      );
    }

    // Build series using module-level function (hoisted, TDZ-safe in all minifiers)
    var builtSeries = buildScatterSeriesData(
      rows, scatterAxisF, scatterXF, scatterYF, scatterSzF, scatterLgF,
      premiumPalette, accent, chartOpacity,
      visual.format.dataPointSize || 10, visual.format.bubbleMaxSize || 45,
      marker, visual.format.showDataPoints!==false, !!visual.format.dataLabels,
      labelColor, labelSize, 'top'
    );
    var capturedXF = scatterXF;
    var capturedYF = scatterYF;
    var capturedSzF = scatterSzF;
    var capturedLgF = scatterLgF;

    return (
      <ReactECharts key={formatRefreshKey} opts={{renderer:'canvas'}} notMerge={true}
        style={{ height: '100%' }}
        onEvents={chartEvents}
        option={{
          animationDuration: 650,
          color: premiumPalette,
          legend: capturedLgF ? { ...legend, data: builtSeries.map((s: any) => s.name) } : undefined,
          tooltip: {
            ...tooltipBase,
            trigger: 'item',
            formatter: (p: any) => {
              var res = (p.data && p.data.name) ? `<b>${p.data.name}</b><br/>` : '';
              if (capturedLgF) res += `${capturedLgF}: ${p.seriesName}<br/>`;
              res += `${capturedXF}: <b>${fmt(p.value[0], capturedXF)}</b><br/>`;
              res += `${capturedYF}: <b>${fmt(p.value[1], capturedYF)}</b>`;
              if (capturedSzF) res += `<br/>${capturedSzF}: <b>${fmt(p.value[2], capturedSzF)}</b>`;
              return res;
            }
          },
          grid: { containLabel: true, left: showYAxisTitle ? 35 : 15, right: capturedLgF ? 20 : 30, top: capturedLgF ? 35 : 25, bottom: showXAxisTitle ? 30 : 15 },
          xAxis: {
            show: showXAxis || showXAxisTitle,
            type: 'value',
            name: showXAxisTitle ? (visual.format.xAxisTitle || capturedXF) : undefined,
            nameLocation: 'middle', nameGap: 30,
            nameTextStyle: { color: axisColor, fontSize: axisSize, fontFamily, fontWeight: 600 },
            axisLabel: { color: axisColor, fontSize: axisSize, fontFamily, formatter: (v: number) => fmt(v, capturedXF) },
            splitLine: { show: false }
          },
          yAxis: {
            show: showYAxis || showYAxisTitle,
            type: 'value',
            name: showYAxisTitle ? (visual.format.yAxisTitle || capturedYF) : undefined,
            nameLocation: 'middle', nameGap: scatterYGap,
            nameTextStyle: { color: axisColor, fontSize: axisSize, fontFamily, fontWeight: 600 },
            axisLabel: { color: axisColor, fontSize: axisSize, fontFamily, formatter: (v: number) => fmt(v, capturedYF) },
            splitLine: { show: visual.format.gridLines !== false, lineStyle: { color: gridLineColor, type: gridLineStyle } }
          },
          series: builtSeries
        }}
      />
    );
  }




  if (legendField && ['bar','column','stackedbar','stackedcolumn','line','area'].includes(visual.type)) {
    const categories=Array.from(new Set(rows.map(r=>String(r[axis||'']))));
    const seriesNames=Array.from(new Set(rows.map(r=>String(r[legendField]))));
    const palette=premiumPalette;
    const horizontal=visual.type==='bar'||visual.type==='stackedbar';
    const maxCatW = Math.max(0, ...categories.map(c => String(fmtCategoryLabel(c)).length)) * (axisSize * 0.6);
    const seriesData = seriesNames.map((sn,si)=>({
      name:sn,
      data:categories.map(cat=>{const row=rows.find(r=>String(r[axis||''])===cat&&String(r[legendField])===sn);return Number(row?.[valueField||'']||0)})
    }));
    const allValuesForGap = seriesData.flatMap((s:any) => s.data.map((d:any) => d));
    const maxValW = Math.max(0, ...allValuesForGap.map((v:any) => String(fmt(parseFloat(Number(v||0).toFixed(3)))).length)) * (axisSize * 0.55);
      const yMargin = (legendPosition === 'left' ? 85 : 15) + (showYAxisTitle ? 25 : 0);
      const xMargin = (legendPosition === 'bottom' ? 45 : 15) + (showXAxisTitle ? 25 : 0);
      const estLabelW = horizontal ? maxCatW : maxValW;
      const estLabelH = horizontal ? 15 : (maxCatW > 40 ? maxCatW * 0.7 + 5 : 15);
      const yNameGap = estLabelW + yMargin / 2;
      const xNameGap = estLabelH + xMargin / 2;

    const categoryAxis:any={show:horizontal?(showYAxis||showYAxisTitle):(showXAxis||showXAxisTitle),type:'category',data:categories,name:(horizontal?showYAxisTitle:showXAxisTitle)?((horizontal?visual.format.yAxisTitle:visual.format.xAxisTitle)||axis||'Category'):'',nameTextStyle:axisTitleStyle,nameLocation:'middle',nameGap:horizontal?yNameGap:xNameGap,axisLabel:{show:horizontal?showYAxis:showXAxis,color:axisColor,fontSize:axisSize,fontFamily,formatter:(v:any)=>fmtCategoryLabel(v)},axisTick:{show:false,lineStyle:{color:axisColor}},axisLine:{show:horizontal?showYAxis:showXAxis,lineStyle:{color:axisColor}}};
    const valueAxis:any={show:horizontal?(showXAxis||showXAxisTitle):(showYAxis||showYAxisTitle),type:'value',name:(horizontal?showXAxisTitle:showYAxisTitle)?((horizontal?visual.format.xAxisTitle:visual.format.yAxisTitle)||valueField||'Value'):'',nameTextStyle:axisTitleStyle,nameLocation:'middle',nameGap:horizontal?xNameGap:yNameGap,axisLabel:{show:horizontal?showXAxis:showYAxis,color:axisColor,fontSize:axisSize,fontFamily,formatter:(x:number)=>fmt(x)},axisLine:{show:false},splitLine:{show:visual.format.gridLines!==false,lineStyle:{color:gridLineColor,type:gridLineStyle}}};
    const isLine=visual.type==='line'||visual.type==='area';
    const stacked=(visual.type==='stackedbar'||visual.type==='stackedcolumn')&&seriesNames.length>1;
    return <ChartScrollerWrapper echartsKey={formatRefreshKey} events={chartEvents} categories={categories} horizontal={horizontal} visibleCount={visual.format.visibleCategoryCount||12} option={{
      animationDuration:650,color:palette,legend:{...legend,show:true,data:seriesNames},
      tooltip:{...tooltipBase,trigger:'axis',formatter:tooltipFormatter},
      grid:{containLabel:true,left:yMargin,right:horizontal?42:24,top:30,bottom:xMargin},
      toolbox: { show: false },
      dataZoom:categoryZoom(categories,horizontal),
      xAxis:horizontal?valueAxis:categoryAxis,yAxis:horizontal?categoryAxis:valueAxis,
      series:seriesNames.map((sn,si)=>({
        name:sn,type:isLine?'line':'bar',stack:stacked?'total':undefined,smooth,
        data:categories.map(cat=>{const row=rows.find(r=>String(r[axis||''])===cat&&String(r[legendField])===sn);return Number(row?.[valueField||'']||0)}),
        itemStyle:{color:palette[si%palette.length],opacity:chartOpacity,borderRadius:!isLine?(stacked?(si===seriesNames.length-1?(horizontal?[0,visual.format.barRadius??0,visual.format.barRadius??0,0]:[visual.format.barRadius??0,visual.format.barRadius??0,0,0]):0):[visual.format.barRadius??0,visual.format.barRadius??0,visual.format.barRadius??0,visual.format.barRadius??0]):0},
        emphasis:{focus:'series',itemStyle:{shadowBlur:10,shadowColor:`${palette[si%palette.length]}55`}},
        lineStyle:{color:palette[si%palette.length],width:lineWidth},areaStyle:visual.type==='area'?{opacity:.12}:undefined,markLine:si===0?referenceMarkLine(horizontal):undefined,
        symbol:marker,symbolSize:visual.format.dataPointSize||7,barMaxWidth:visual.format.barWidth||42,
        label:{show:!!visual.format.dataLabels,color:stacked?'#ffffff':labelColor,fontWeight:700,fontSize:Math.max(10,labelSize),position:stacked?'inside':horizontal?'right':'top',formatter:(p:any)=>Number(p.value)===0?'':fmt(p.value)},labelLayout:{hideOverlap:true},clip:true
      }))
    }}/>;
  }

  const horizontal =
    visual.type === 'bar' || visual.type === 'stackedbar';
    
  const maxCatW = Math.max(0, ...names.map(c => String(fmtCategoryLabel(c)).length)) * (axisSize * 0.6);
  const maxValW = Math.max(0, ...values.map(v => String(fmt(parseFloat(Number(v||0).toFixed(3)))).length)) * (axisSize * 0.55);
    const yMargin = (legendVisible && legendPosition === 'left' ? 85 : 15) + (showYAxisTitle ? 25 : 0);
    const xMargin = (legendVisible && legendPosition === 'bottom' ? 45 : 15) + (showXAxisTitle ? 25 : 0);
    const estLabelW = horizontal ? maxCatW : maxValW;
    const estLabelH = horizontal ? 15 : (maxCatW > 40 ? maxCatW * 0.7 + 5 : 15);
    const yNameGap = estLabelW + yMargin / 2;
    const xNameGap = estLabelH + xMargin / 2;

  const categoryAxis: any = {
    show: horizontal ? (showYAxis || showYAxisTitle) : (showXAxis || showXAxisTitle),
    type: 'category',
    data: names,
    name:(horizontal ? showYAxisTitle : showXAxisTitle) ? ((horizontal?visual.format.yAxisTitle:visual.format.xAxisTitle)||axis||'Category') : '',
    nameTextStyle:axisTitleStyle,
    nameLocation:'middle',nameGap:horizontal?yNameGap:xNameGap,
    axisLabel: { show: horizontal ? showYAxis : showXAxis, color: axisColor, fontSize: axisSize, fontFamily, formatter: (v: any) => fmtCategoryLabel(v) },
    axisLine: { show: horizontal ? showYAxis : showXAxis, lineStyle: { color: axisColor } },
    axisTick: { show: false, lineStyle: { color: axisColor } }
  };

  const valueAxis: any = {
    show: horizontal ? (showXAxis || showXAxisTitle) : (showYAxis || showYAxisTitle),
    type: 'value',
    name:(horizontal ? showXAxisTitle : showYAxisTitle) ? ((horizontal?visual.format.xAxisTitle:visual.format.yAxisTitle)||valueField||'Value') : '',
    nameTextStyle:axisTitleStyle,
    nameLocation:'middle',nameGap:horizontal?xNameGap:yNameGap,
    axisLabel: {
      show: horizontal ? showXAxis : showYAxis,
      color: axisColor,
      fontSize: axisSize,
      fontFamily,
      formatter: (x: number) => fmt(x)
    },
    axisLine: { show: false },
    splitLine: {
      show: visual.format.gridLines !== false,
      lineStyle: { color: gridLineColor, type: gridLineStyle }
    }
  };

  const base: any = {
    animationDuration: 650,
    color: premiumPalette,
    textStyle: { color: '#334155' },
    tooltip: {
      ...tooltipBase,
      trigger: 'axis',
      formatter: tooltipFormatter
    },
    grid: {
      containLabel: true,
      left: yMargin,
      right: horizontal ? 42 : 24,
      top: 30,
      bottom: xMargin
    },
    toolbox: { show: false },
    dataZoom: categoryZoom(names, horizontal),
    xAxis: horizontal ? valueAxis : categoryAxis,
    yAxis: horizontal ? categoryAxis : valueAxis,
    series: []
  };

  const chartType =
    visual.type === 'line' || visual.type === 'area' ? 'line' : 'bar';
  const showPoints = visual.format.showDataPoints !== false;

  const activeValues = visual.bindings.values && visual.bindings.values.length > 0 ? visual.bindings.values : [valueField || ''];
  // For multi-value, use premiumPalette directly so series get distinct, high-contrast colours
  // (blue, green, purple, amber, red…). Single-value still follows the user's accent.
  const multiValuePalette = premiumPalette;
  const palette = multiValuePalette;
  const multiValue = activeValues.length > 1;
  const stacked = (visual.type === 'stackedbar'||visual.type==='stackedcolumn')&&multiValue;

  // Build one Y-axis per value field when there are multiple (dual-axis like Power BI).
  // For a single value field keep the original single-axis behaviour.
  if (multiValue && !horizontal && !stacked) {
    base.yAxis = activeValues.map((vf, si) => {
      const c = si === 0 ? axisColor : palette[si % palette.length];
      return {
        show: showYAxis || showYAxisTitle,
        type: 'value',
        name: showYAxisTitle ? formatColumnHeader(vf) : '',
        nameTextStyle: { ...axisTitleStyle, color: c },
        nameLocation: 'middle',
        nameGap: 52,
        position: si === 0 ? 'left' : 'right',
        offset: si > 1 ? (si - 1) * 60 : 0,
        axisLabel: { show: showYAxis, color: c, fontSize: axisSize, fontFamily, formatter: (x: number) => formatForField(x, vf, formats) },
        axisLine: { show: showYAxis, lineStyle: { color: c } },
        splitLine: { show: si === 0 && visual.format.gridLines !== false, lineStyle: { color: gridLineColor, type: gridLineStyle } }
      };
    });
    // Multi-value legend is ALWAYS shown at the top, independent of format pane settings.
    // Without it the user cannot tell which bar/line corresponds to which measure.
    base.grid = { left: showYAxisTitle ? 78 : 58, right: activeValues.length > 1 ? (showYAxisTitle ? 80 : 60) : 24, top: 30, bottom: showXAxisTitle ? 65 : 28 };
    base.legend = {
      show: true,
      top: 0,
      left: 'center',
      data: activeValues.map(vf => formatColumnHeader(vf, false, (visual.format as any).fieldDisplayNames)),
      textStyle: { color: axisColor, fontSize: axisSize, fontFamily }
    };
  }
  if(multiValue&&stacked){
    base.legend={...legend,show:legendVisible,data:activeValues.map(vf=>formatColumnHeader(vf))};
    base.grid={...base.grid,top:legendVisible&&legendPosition==='top'?36:24,bottom:legendVisible&&legendPosition==='bottom'?48:base.grid.bottom};
  }

  base.series = activeValues.map((vf, si) => {
    const seriesColor = configuredSeriesColor(vf,si,multiValue?palette[si%palette.length]:accent);
    const isBar = chartType === 'bar';
    return {
      name: multiValue ? formatColumnHeader(vf, false, (visual.format as any).fieldDisplayNames) : ((visual.format as any).fieldDisplayNames?.[vf] || vf),
      type: chartType,
      clip:true,
      yAxisIndex: multiValue && !horizontal && !stacked ? si : 0,
      data: rows.map((row) => {
        const v = row[vf];
        return {
          value: v,
          itemStyle: { color: multiValue ? seriesColor : valueColor(v) }
        };
      }),
      smooth,
      barMaxWidth: visual.format.barWidth || 38,
      areaStyle: visual.type === 'area' ? { opacity: (visual.format.areaOpacity??18)/100 } : undefined,
      itemStyle: {
        color: (p:any) => multiValue ? seriesColor : valueColor(p.value),
        borderRadius: isBar ? (stacked?(si===activeValues.length-1?(horizontal?[0,visual.format.barRadius??0,visual.format.barRadius??0,0]:[visual.format.barRadius??0,visual.format.barRadius??0,0,0]):0):(horizontal?[0,visual.format.barRadius??0,visual.format.barRadius??0,0]:[visual.format.barRadius??0,visual.format.barRadius??0,0,0])) : 0,
        opacity: chartOpacity,
        shadowBlur: isBar ? 4 : 0,
        shadowColor: isBar ? `${seriesColor}28` : 'transparent'
      },
      emphasis: { focus: 'series', itemStyle: { shadowBlur: 14, shadowColor: `${seriesColor}44` } },
      lineStyle: { color: seriesColor, width: lineWidth },
      markLine: si === 0 ? referenceMarkLine(horizontal) : undefined,
      symbol: showPoints ? marker : 'none',
      showSymbol: showPoints,
      symbolSize: visual.format.dataPointSize || 7,
      label: {
        show: visual.format.dataLabels,
        color: stacked?'#ffffff':labelColor,
        fontSize: labelSize,
        position: stacked?'inside':horizontal?'right':'top',
        distance:chartType==='line'&&multiValue?6+si*4:5,
        formatter: (p: any) => Number(p.value)===0?'':fmt(p.value, vf)
      },
      labelLayout:{hideOverlap:true},
      stack: stacked ? 'total' : undefined
    };
  });

  return <ChartScrollerWrapper 
    echartsKey={formatRefreshKey} 
    events={chartEvents} 
    categories={names} 
    horizontal={horizontal} 
    visibleCount={visual.format.visibleCategoryCount||12} 
    option={base}
  />;
}


function RadarChartWrapper({ visual, names, values, valueField, gridLineColor, accent, lineWidth, marker, labelColor, axisColor, fontFamily, fmt, labelSize, axisSize }: any) {
  const radarNames = names.slice(0, 12).map((n: any) => String(n ?? ''));
  const radarValues = values.slice(0, 12).map((v: any) => Number(v) || 0);
  const count = Math.max(3, radarNames.length);
  while (radarNames.length < count) radarNames.push('');
  while (radarValues.length < count) radarValues.push(0);

  const ref = useRef<HTMLDivElement>(null);
  const [dim, setDim] = useState({ w: 320, h: 205 });

  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(entries => {
      if (entries[0]) {
        const { width, height } = entries[0].contentRect;
        if (width > 0 && height > 0) setDim({ w: width, h: height });
      }
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  const cx = dim.w / 2;
  const cy = dim.h / 2;
  const radius = Math.min(cx, cy) * 0.65;
  const circumference = 2 * Math.PI * radius;
  const maxPointSize = Math.max(2, (circumference / count) * 0.25);
  const maxFontSize = Math.max(8, (circumference / count) * 0.45);

  const size = Math.min(maxPointSize, Math.max(4, visual.format.dataPointSize || 6));
  const finalLabelSize = Math.min(maxFontSize, labelSize);
  const finalAxisSize = Math.min(maxFontSize, axisSize);

  const max = Math.max(...radarValues.map((v: any) => Math.abs(v)), 1) * 1.1;
  const point = (i: number, r: number) => {
    const a = -Math.PI / 2 + i * Math.PI * 2 / count;
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r] as const;
  };
  const polygon = (r: number) => Array.from({ length: count }, (_, i) => point(i, r).join(',')).join(' ');
  const dataPoints = radarValues.map((v: any, i: number) => point(i, Math.max(0, Math.min(1, Math.abs(v) / max)) * radius).join(',')).join(' ');

  return <div ref={ref} style={{ height: '100%', width: '100%', position: 'relative' }}>
    {dim.w > 0 && <svg width={dim.w} height={dim.h} role="img" aria-label={`${valueField || 'Value'} radar chart`} style={{ position: 'absolute', top: 0, left: 0, overflow: 'visible', fontFamily }}>
      {visual.format.radarGridVisible !== false && [.25, .5, .75, 1].map(level => <polygon key={level} points={polygon(radius * level)} fill={level % 1 === 0 ? '#f8fafc' : 'none'} stroke={gridLineColor} strokeWidth="1" />)}
      {visual.format.radarGridVisible !== false && Array.from({ length: count }, (_, i) => { const [x, y] = point(i, radius); return <line key={i} x1={cx} y1={cy} x2={x} y2={y} stroke={gridLineColor} strokeWidth="1" /> })}
      <polygon points={dataPoints} fill={accent} fillOpacity={(visual.format.radarFillOpacity ?? 18) / 100} stroke={accent} strokeWidth={lineWidth} strokeLinejoin="round" />
      {visual.format.showDataPoints !== false && radarValues.map((v: any, i: number) => {
        const [x, y] = point(i, Math.max(0, Math.min(1, Math.abs(v) / max)) * radius);
        const shape = marker === 'rect' ? <rect x={x - size} y={y - size} width={size * 2} height={size * 2} rx={0} fill="#fff" stroke={accent} strokeWidth="2" /> : marker === 'roundRect' ? <rect x={x - size} y={y - size} width={size * 2} height={size * 2} rx={size * .5} fill="#fff" stroke={accent} strokeWidth="2" /> : marker === 'diamond' ? <polygon points={`${x},${y - size * 1.4} ${x + size * 1.4},${y} ${x},${y + size * 1.4} ${x - size * 1.4},${y}`} fill="#fff" stroke={accent} strokeWidth="2" /> : marker === 'triangle' ? <polygon points={`${x},${y - size * 1.5} ${x + size * 1.4},${y + size} ${x - size * 1.4},${y + size}`} fill="#fff" stroke={accent} strokeWidth="2" /> : <circle cx={x} cy={y} r={size} fill="#fff" stroke={accent} strokeWidth="2" />;
        return <g key={i}>{shape}<title>{radarNames[i]}: {fmt(v)}</title></g>
      })}
      {!!visual.format.dataLabels && radarValues.map((v: any, i: number) => {
        const [x, y] = point(i, Math.max(0, Math.min(1, Math.abs(v) / max)) * radius);
        const offset = visual.format.showDataPoints !== false ? (size + 5) : 4;
        return <text key={`value-${i}`} x={x} y={y - offset} textAnchor="middle" fill={labelColor} fontSize={finalLabelSize}>{fmt(v)}</text>
      })}
      {visual.format.radarLabelVisible !== false && radarNames.map((name: any, i: number) => {
        const [x, y] = point(i, radius + 17);
        const anchor = x < cx - 8 ? 'end' : x > cx + 8 ? 'start' : 'middle';
        return <text key={i} x={x} y={y} textAnchor={anchor} dominantBaseline="middle" fill={axisColor} fontSize={finalAxisSize}>{name}</text>
      })}
      <text x={cx} y={dim.h - 10} textAnchor="middle" fill={axisColor} fontSize="10" fontWeight="600">{valueField || 'Value'}</text>
    </svg>}
  </div>;
}

export default React.memo(Chart, (prev, next) => {
  if (prev.rows !== next.rows) return false;
  if (prev.visual.type !== next.visual.type) return false;
  if (prev.visual.drillLevel !== next.visual.drillLevel) return false;
  if (JSON.stringify(prev.visual.bindings) !== JSON.stringify(next.visual.bindings)) return false;
  if (JSON.stringify(prev.visual.filters) !== JSON.stringify(next.visual.filters)) return false;
  if (JSON.stringify(prev.visual.sort) !== JSON.stringify(next.visual.sort)) return false;
  if (JSON.stringify(prev.visual.format) !== JSON.stringify(next.visual.format)) return false;
  if (JSON.stringify(prev.visual.action) !== JSON.stringify(next.visual.action)) return false;
  if (prev.visual.title !== next.visual.title) return false;
  return true;
});
