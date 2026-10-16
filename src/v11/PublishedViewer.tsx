import{useEffect,useMemo,useRef,useState}from'react';
import{createPortal}from'react-dom';
import{ChevronLeft,ChevronRight,ChevronDown,RefreshCcw,Maximize2,Minimize2,Home,CalendarDays,ShieldCheck,MonitorUp,Expand,Scaling,Eraser,BarChart3,PieChart,Table2,LayoutGrid,Filter,TrendingUp,MousePointerClick,FileDown,Presentation,Mail,FileText,Printer,Code2,QrCode,Star,Settings2,Share2,ArrowLeft,Download,FileArchive,Check,Copy,ExternalLink,Globe,Users,BellRing}from'lucide-react';
import Chart from'../components/Chart';
import PaginatedReportViewer from'./PaginatedReportViewer';
import ReportAutomationDialog from'./ReportAutomationDialog';
import{api,apiDownload,apiDownloadPost}from'../api';
import{richTextHtml}from'../richText';
import{resolveActionButtonLabel,resolveActionCommands,visualIsHidden}from'../buttonActions';
import{resolveConditionalFormat}from'../conditionalFormatting';
import type{Visual,VisualFilter}from'../types';
import html2canvas from'html2canvas';

// In WORKSPACE_ONLY (web portal) mode, report metadata comes from Supabase and
// visual queries go to the deployed Reporting Service API. The API downloads
// the viewer-authorized private snapshots before compiling the visual query.
const WORKSPACE_ONLY=import.meta.env.VITE_APP_MODE==='WORKSPACE_ONLY';

function parseProjectJson(value:any):any{
  if(value&&typeof value==='object')return value;
  if(typeof value!=='string'||!value.trim())return{};
  try{return JSON.parse(value)}catch{throw new Error('This published report contains an invalid project definition. Publish it again from Desktop.')}
}

async function fetchReportFromSupabase(reportId:string):Promise<any>{
  const{supabase}=await import('../supabase');
  if(!supabase)throw new Error('Supabase not configured');
  
  const{data,error}=await supabase
    .from('published_reports')
    .select('id,name,published_at,updated_at,project_json,workspace_id')
    .eq('id',reportId)
    .single();
  if(error)throw error;

  // Supabase RLS is the single source of truth. If this row was returned, the
  // signed-in owner, direct grantee, workspace member, or service account is
  // authorized. A second client-side grants check would incorrectly reject
  // workspace access that is valid under RLS.
  return{...data,project:parseProjectJson(data.project_json)};
}

type VisualQueryResult={rows:any[];error?:string;conditionalValues?:Record<string,any>;conditionalError?:string};
async function queryPageVisuals(reportId:string,visualIds:string[],extraFilters:VisualFilter[]=[],signal?:AbortSignal){
 // One page request replaces the previous N-request waterfall. The service
 // resolves authorization, RLS and private snapshots only once for the page.
 return api<{results:Record<string,VisualQueryResult>;durationMs:number}>(`/published/${reportId}/query-batch`,{method:'POST',body:JSON.stringify({visualIds,filters:extraFilters}),signal});
}
function visualTitleIcon(type:string){
 if(['pie','donut'].includes(type))return <PieChart size={15}/>;
 if(['table','matrix'].includes(type))return <Table2 size={15}/>;
 if(['kpi','card','multirowcard','progress','gauge'].includes(type))return <TrendingUp size={15}/>;
 if(type==='slicer')return <Filter size={15}/>;
 if(['bar','column','stackedbar','stackedcolumn','line','area','combo','scatter','bubble'].includes(type))return <BarChart3 size={15}/>;
 return <LayoutGrid size={15}/>;
}
function ViewerShape({format}:{format:any}){const type=format.shapeType||'rectangle',fillVisible=format.shapeFillVisible!==false&&type!=='line',strokeVisible=format.shapeStrokeVisible??((format.shapeStrokeWidth??0)>0),fill=format.shapeFill||'#dbeafe',fillOpacity=1-Math.max(0,Math.min(100,format.shapeFillTransparency??0))/100,stroke=format.shapeStroke||'#2563eb',strokeWidth=Math.max(0,format.shapeStrokeWidth??2),strokeStyle=format.shapeStrokeStyle||'solid',shadow=format.shadow?`drop-shadow(0 ${format.shadowOffset??8}px 10px color-mix(in srgb, ${format.shadowColor||'#000000'} 24%, transparent))`:'none';if(type==='rectangle'||type==='roundedRectangle'||type==='ellipse')return <div className={`shapeArtwork viewerShapeVisual shapeArtwork-${type}`} style={{background:fillVisible?`color-mix(in srgb, ${fill} ${Math.round(fillOpacity*100)}%, transparent)`:'transparent',border:strokeVisible&&strokeWidth>0?`${strokeWidth}px ${strokeStyle} ${stroke}`:'none',borderRadius:type==='ellipse'?'50%':type==='roundedRectangle'?`${Math.max(0,format.shapeCornerRadius??18)}px`:'0',filter:shadow}} aria-hidden="true"/>;const dash=strokeStyle==='dashed'?'10 6':strokeStyle==='dotted'?'2 5':undefined,common={fill:fillVisible?fill:'none',fillOpacity,stroke:strokeVisible&&strokeWidth>0?stroke:'none',strokeWidth,strokeDasharray:dash,strokeLinejoin:'round' as const,vectorEffect:'non-scaling-stroke' as const};return <svg className={`shapeArtwork viewerShapeVisual shapeArtwork-${type}`} style={{filter:shadow}} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">{type==='line'?<line x1="0" y1="50" x2="100" y2="50" {...common}/>:type==='triangle'?<polygon points="50,0 100,100 0,100" {...common}/>:<polygon points="50,0 100,50 50,100 0,50" {...common}/>}</svg>}

function readableInsightValue(value:any){
 if(value===null||value===undefined||value==='')return '—';
 if(typeof value==='number')return new Intl.NumberFormat(undefined,{maximumFractionDigits:2,notation:Math.abs(value)>=1000000?'compact':'standard'}).format(value);
 return String(value);
}
type ExportNarrative={title:string;points:string[]};
function insightFieldName(value:string){return String(value||'Value').split('.').pop()?.split('::')[0]?.replaceAll('_',' ')||'Value'}
function visualExportNarrative(v:Visual,rows:any[]):ExportNarrative{
 const title=v.title||v.type.replaceAll('_',' '),dimensions=[...(v.bindings.axis||[]),...(v.bindings.legend||[])],values=Array.from(new Set([...(v.bindings.values||[]),...(v.bindings.target||[]),...(v.bindings.tooltips||[])]));
 const valueField=values[0],dimensionField=dimensions[0],points:string[]=[];
 if(['kpi','card','multirowcard','progress','gauge'].includes(v.type)){
  for(const field of values.slice(0,3)){const value=rows[0]?.[field];if(value!==undefined&&value!==null&&value!=='')points.push(`${insightFieldName(field)}: ${readableInsightValue(value)}`)}
  const targetField=(v.bindings.target||[])[0],actual=Number(valueField&&rows[0]?.[valueField]),target=Number(targetField&&rows[0]?.[targetField]);
  if(targetField&&Number.isFinite(actual)&&Number.isFinite(target)&&target!==0){const variance=(actual-target)/Math.abs(target)*100;points.push(`${Math.abs(variance).toFixed(1)}% ${variance>=0?'above':'below'} ${insightFieldName(targetField)}`)}
  return{title,points:points.slice(0,3)};
 }
 if(v.type==='slicer')return{title,points:[`${rows.length} available value${rows.length===1?'':'s'}`]};
 if(['table','matrix'].includes(v.type))points.push(`${rows.length} displayed row${rows.length===1?'':'s'}`);
 if(valueField&&dimensionField){
  const grouped=new Map<string,number>();
  for(const row of rows){const value=Number(row[valueField]);if(!Number.isFinite(value))continue;const label=readableInsightValue(row[dimensionField]);grouped.set(label,(grouped.get(label)||0)+value)}
  const ordered=Array.from(grouped,([label,value])=>({label,value})),ranked=[...ordered].sort((a,b)=>b.value-a.value);
  if(ranked.length){
   points.push(`Highest ${insightFieldName(valueField)}: ${ranked[0].label} (${readableInsightValue(ranked[0].value)})`);
   if(ranked.length>1)points.push(`Lowest ${insightFieldName(valueField)}: ${ranked[ranked.length-1].label} (${readableInsightValue(ranked[ranked.length-1].value)})`);
   if(['pie','donut','treemap','funnel'].includes(v.type)){const total=ranked.reduce((sum,item)=>sum+Math.max(0,item.value),0);if(total>0)points.splice(1,0,`${ranked[0].label} contributes ${(Math.max(0,ranked[0].value)/total*100).toFixed(1)}% of the total`)}
  }
  if(['line','area','combo'].includes(v.type)){
   if(ordered.length>1&&ordered[0].value!==0){const first=ordered[0],last=ordered[ordered.length-1],change=(last.value-first.value)/Math.abs(first.value)*100;points.unshift(`${insightFieldName(valueField)} ${change>=0?'increased':'decreased'} ${Math.abs(change).toFixed(1)}% from ${first.label} to ${last.label}`)}
  }
 }
 return{title,points:points.slice(0,3)};
}

function nextPaint(){return new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())))}
async function waitForExportPage(stage:HTMLElement,pageId:string,pageName:string,timeoutMs=60000){
 const started=Date.now();let reportPage:HTMLElement|null=null;
 while(Date.now()-started<timeoutMs){
  reportPage=stage.querySelector<HTMLElement>(`.viewerPage[data-page-id="${CSS.escape(pageId)}"]`);
  if(reportPage){
   const visuals=Array.from(reportPage.querySelectorAll<HTMLElement>('[data-export-state]'));
   if((visuals.length||reportPage.querySelector('.viewerEmptyPage'))&&visuals.every(node=>node.dataset.exportState!=='loading')){
    // Don't throw on failed visuals — just note them and continue so the
    // export proceeds with whatever data did load (mirrors Power BI behaviour).
    break;
   }
  }
  await new Promise(resolve=>window.setTimeout(resolve,100));
 }
 if(!reportPage||reportPage.dataset.pageId!==pageId)throw new Error(`Timed out while loading ${pageName} for export.`);
 if(Array.from(reportPage.querySelectorAll<HTMLElement>('[data-export-state]')).some(node=>node.dataset.exportState==='loading'))throw new Error(`Timed out while waiting for data on ${pageName}.`);
 await document.fonts?.ready;
 await Promise.all(Array.from(reportPage.querySelectorAll<HTMLImageElement>('img')).map(async image=>{if(image.complete){try{await image.decode()}catch{};return}await new Promise<void>(resolve=>{image.addEventListener('load',()=>resolve(),{once:true});image.addEventListener('error',()=>resolve(),{once:true})})}));
 // ECharts reports data readiness before its canvas animation finishes.
 await new Promise(resolve=>window.setTimeout(resolve,900));
 await nextPaint();
 return reportPage;
}
function legacyCanvasColor(value:string){
 return value.replace(/color\(\s*([a-z0-9-]+)\s+([^)]*)\)/gi,(_match,space:string,body:string)=>{
   const parts=body.trim().split(/\s*\/\s*/),channels=parts[0].trim().split(/\s+/).slice(0,3);
   if(channels.length<3)return'rgba(0,0,0,0)';
   const number=(input:string)=>input.endsWith('%')?Number(input.slice(0,-1))/100:Number(input);
   let rgb=channels.map(number);if(rgb.some(channel=>!Number.isFinite(channel)))return'rgba(0,0,0,0)';
   if(space.toLowerCase()==='srgb-linear')rgb=rgb.map(channel=>channel<=.0031308?12.92*channel:1.055*Math.pow(channel,1/2.4)-.055);
   const clamp=(channel:number)=>Math.max(0,Math.min(255,Math.round(channel*255))),alpha=Math.max(0,Math.min(1,number(parts[1]||'1')));
   return`rgba(${clamp(rgb[0])},${clamp(rgb[1])},${clamp(rgb[2])},${alpha})`;
 });
}
function makeCloneColorsCanvasSafe(documentClone:Document,root:HTMLElement){
 const view=documentClone.defaultView;if(!view)return;
 for(const node of [root,...Array.from(root.querySelectorAll<HTMLElement|SVGElement>('*'))]){
   const computed=view.getComputedStyle(node);
   for(const property of Array.from(computed)){
     const value=computed.getPropertyValue(property);if(!/color\(/i.test(value))continue;
     node.style.setProperty(property,legacyCanvasColor(value),'important');
   }
 }
}
export async function captureViewerPage(element:HTMLElement,width:number,height:number){
 const canvas=await html2canvas(element,{
   backgroundColor:'#ffffff',
   width,height,
   scale:1,
   scrollX:0,
   scrollY:0,
   windowWidth:width,
   windowHeight:height,
   useCORS:true,
   allowTaint:false,
   logging:false,
   imageTimeout:8000,
   removeContainer:true,
   onclone:documentClone=>{
     // Hide pages panel so it doesn't consume horizontal space during capture
     const pagesPanel=documentClone.querySelector<HTMLElement>('.viewerPagesPanel');
     if(pagesPanel){pagesPanel.style.display='none';}
     // Make viewerBody full-width so stage isn't constrained by flex layout
     const viewerBody=documentClone.querySelector<HTMLElement>('.viewerBody');
     if(viewerBody){viewerBody.style.width=`${width}px`;viewerBody.style.overflow='visible';viewerBody.style.display='block';}
     const stage=documentClone.querySelector<HTMLElement>('.viewerStage');
     if(stage){
       stage.style.overflow='visible';
       stage.style.width=`${width}px`;
       stage.style.height=`${height}px`;
       stage.style.padding='0';
       stage.style.flex='none';
     }
     const frame=documentClone.querySelector<HTMLElement>('.viewerScaleFrame');
     if(frame){
       frame.style.width=`${width}px`;
       frame.style.height=`${height}px`;
       frame.style.transform='none';
       frame.style.overflow='visible';
     }
     const clone=documentClone.querySelector<HTMLElement>('.viewerPage');if(!clone)return;
     clone.style.transform='none';clone.style.transformOrigin='top left';clone.style.margin='0';clone.style.boxShadow='none';clone.style.borderRadius='0';clone.style.width=`${width}px`;clone.style.height=`${height}px`;clone.style.overflow='visible';
     makeCloneColorsCanvasSafe(documentClone,clone);
     for(const image of Array.from(clone.querySelectorAll<HTMLImageElement>('img'))){image.crossOrigin='anonymous';image.referrerPolicy='no-referrer'}
    }
 });
 return canvas.toDataURL('image/png');
}
function ViewerVisual({v,result,loading,selected,onCrossFilter,onAction}:{v:Visual,result?:VisualQueryResult,loading:boolean,selected?:boolean,onCrossFilter:(f:VisualFilter|null)=>void,onAction:(v:Visual)=>void}){
 const rows=result?.rows||[],err=result?.error||'';
 const[focus,setFocus]=useState(false),[slicerSelected,setSlicerSelected]=useState<string[]>([]),[slicerSearch,setSlicerSearch]=useState('');
 useEffect(()=>{const reset=()=>{setSlicerSelected([]);setSlicerSearch('')};window.addEventListener('vtab-reset-state',reset);return()=>window.removeEventListener('vtab-reset-state',reset)},[]);
 const conditionalValues=result?.conditionalValues||{};
 const f:any={...(v.format||{}),...resolveConditionalFormat(v.format?.conditionalFormatRules,conditionalValues)},displayVisual={...v,format:f};const bg=f.background||'#fff';const dark=/^#0|^#1/.test(bg.toLowerCase());const accent=f.accent||({kpi:'#2563eb',card:'#16a34a',bar:'#2563eb',column:'#0ea5e9',line:'#16a34a',area:'#10b981',pie:'#f59e0b',donut:'#8b5cf6',gauge:'#16a34a',table:'#2563eb',matrix:'#4f46e5',slicer:'#e11d48'} as any)[v.type]||'#2563eb';
 const transparency=f.backgroundEnabled===false?100:Math.max(0,Math.min(100,f.backgroundTransparency||0));
 const edges=f.borderEdges||{top:true,right:true,bottom:true,left:true};
 const border=f.borderVisible?`${f.borderWidth??1}px ${f.borderStyle||'solid'} ${f.borderColor||'#c8c8c8'}`:'0';
 const radius=`${f.cornerRadii?.topLeft??f.cornerRadius??0}px ${f.cornerRadii?.topRight??f.cornerRadius??0}px ${f.cornerRadii?.bottomRight??f.cornerRadius??0}px ${f.cornerRadii?.bottomLeft??f.cornerRadius??0}px`;
 const background=`color-mix(in srgb, ${bg} ${100-transparency}%, transparent)`;
 const titleBg=f.titleBackground||'#fff',titleTransparency=f.titleBackgroundEnabled===false?100:Math.max(0,Math.min(100,f.titleBackgroundTransparency||0)),titleBackground=`color-mix(in srgb, ${titleBg} ${100-titleTransparency}%, transparent)`;
  const shadow=f.shadow?`0 ${f.shadowOffset??12}px 32px color-mix(in srgb, ${f.shadowColor||'#0f172a'} 16%, transparent)`:'none';
  const responsiveSizeClass=f.responsive===false?' visualFixed':(v.w<=260||v.h<=130?' visualCompact':(v.w>=540?' visualWide':' visualStandard'));
  const titleTextStyle:any={fontFamily:f.titleFontFamily||f.fontFamily||'Segoe UI',fontSize:f.titleFontSize||12,color:f.titleColor||(dark?'#fff':'#242424'),fontWeight:f.titleBold===false?400:(f.titleFontWeight||700),fontStyle:f.titleFontStyle||'normal',textDecoration:f.titleUnderline?'underline':'none',whiteSpace:f.titleWrap===false?'nowrap':'normal',textAlign:f.titleAlignment||'left'};
  const subtitleTextStyle:any={fontFamily:f.subtitleFontFamily||f.titleFontFamily||f.fontFamily||'Segoe UI',fontSize:f.subtitleFontSize||10,color:f.subtitleColor||'#616161',fontWeight:f.subtitleBold?(f.subtitleFontWeight||700):400,fontStyle:f.subtitleFontStyle||'normal',textDecoration:f.subtitleUnderline?'underline':'none',whiteSpace:f.subtitleWrap===false?'nowrap':'normal',textAlign:f.subtitleAlignment||f.titleAlignment||'left'};
  if(v.type==='shape')return <div role="img" aria-label={f.altText||`${f.shapeType||'rectangle'} shape`} className="viewerShapeObject" data-export-state="ready" data-visual-title={v.title||v.type}><ViewerShape format={f}/></div>;
  if(v.type==='image'){const media=<img className="viewerImageVisual" src={v.imageSrc||''} alt={f.altText||v.imageName||''} style={{objectFit:f.imageFit||'contain',opacity:(f.imageOpacity??100)/100}}/>;return <div className={`viewerVisual viewerVisual-image visualCard ${responsiveSizeClass}`} data-export-state="ready" data-visual-title={v.title||v.type} style={{background,border:'0',borderTop:edges.top?border:'0',borderRight:edges.right?border:'0',borderBottom:edges.bottom?border:'0',borderLeft:edges.left?border:'0',borderRadius:radius,boxShadow:shadow,'--viewer-title-background':titleBackground} as any}>{f.showTitle!==false&&<div className="viewerVisualTitle visualTitle" style={{background:titleBackground,...titleTextStyle}}><div className="viewerVisualTitleLabel visualTitleText" style={{flex:1,minWidth:0,textAlign:f.titleAlignment||'left',display:'flex',flexDirection:'column',alignItems:'stretch'}}><span style={{...titleTextStyle,display:'block',width:'100%',textAlign:f.titleAlignment||'left'}}>{v.title}</span></div></div>}<div className="viewerVisualBody">{media}</div></div>}
  const content=v.type==='textbox'?(
    <div className="viewerTextBox" style={{fontSize:f.fontSize||18,color:f.labelColor||'#111827',fontFamily:f.fontFamily||'inherit',fontWeight:f.textFontWeight||400,fontStyle:f.textItalic?'italic':'normal',textDecoration:f.textUnderline?'underline':'none',textAlign:f.textAlign||'left',lineHeight:f.textLineHeight||1.45,whiteSpace:f.textWrap===false?'nowrap':'pre-wrap',overflowWrap:f.textWrap===false?'normal':'anywhere',display:'flex',flexDirection:'column',justifyContent:f.textVerticalAlign==='bottom'?'flex-end':f.textVerticalAlign==='middle'?'center':'flex-start',width:'100%',height:'100%',boxSizing:'border-box'}} dangerouslySetInnerHTML={{__html:richTextHtml(v.richText,v.text)}}/>
  ):v.type==='button'?(
    <div className="viewerActionButtonWrap" style={{width:'100%',height:'100%',display:'flex'}}>
      <button aria-pressed={f.buttonSelectionEnabled!==false?selected:undefined} className={'viewerActionButton buttonVisualOnly'+(selected?' actionSelected':'')} style={{flex:1,width:'100%',height:'100%',minHeight:0,margin:0,background:selected?(f.buttonSelectedBackground||'#16a34a'):(f.buttonBackground||'#6b7280'),color:selected?(f.buttonSelectedTextColor||'#fff'):(f.buttonTextColor||'#fff'),fontSize:f.buttonFontSize||12,borderRadius:f.buttonCornerRadius??6,border:f.buttonBorderVisible?`1px solid ${selected?(f.buttonSelectedBorderColor||'#15803d'):(f.buttonBorderColor||'#4b5563')}`:'none',boxSizing:'border-box'}} onClick={()=>onAction(v)}>
        <MousePointerClick size={16}/>{v.buttonLabel||'Action'}
      </button>
    </div>
  ):v.type==='slicer'?(()=>{
    const field=v.bindings.axis?.[0]||'',mode=v.slicerStyle||'list';
    const allOptions=rows.map(r=>String(r[field]??'')).filter((x,i,a)=>x&&a.indexOf(x)===i);
    const options=allOptions.filter(x=>!slicerSearch||x.toLowerCase().includes(slicerSearch.toLowerCase()));
    const allSelected=allOptions.length>0&&allOptions.every(option=>slicerSelected.includes(option));
    const apply=(next:string[],isSelectAll?:boolean)=>{setSlicerSelected(next);if(isSelectAll||!next.length){onCrossFilter(null)}else{onCrossFilter({field,operator:next.length===1?'equals':'in',value:next.length===1?next[0]:next})}};
    const choose=(value:string)=>apply(f.slicerSingleSelect?[value]:slicerSelected.includes(value)?slicerSelected.filter(x=>x!==value):[...slicerSelected,value]);
    const tilesPerRow=f.tilesPerRow||3;
    const tilesPerColumn=f.tilesPerColumn||0;
    const gridStyle:any={gridTemplateColumns:`repeat(${tilesPerRow}, 1fr)`};
    if(tilesPerColumn>0)gridStyle.gridTemplateRows=`repeat(${tilesPerColumn}, 1fr)`;
    return (
      <div className="viewerSlicerContents" style={{flex:1,display:'flex',flexDirection:'column',justifyContent:'center',width:'100%',boxSizing:'border-box',minHeight:0,padding:'2px 8px'}}>
        {mode!=='dropdown'&&f.slicerSearch&&<input className="slicerDropdown viewerSlicerSearch" aria-label="Search slicer values" placeholder="Search" value={slicerSearch} onChange={e=>setSlicerSearch(e.target.value)}/>}
        {mode==='dropdown'?(
          f.slicerMultiSelect?(
            <div className="slicerDropdownMulti" style={{background:f.tableBackground||'#ffffff',color:f.tableTextColor||'#242424',fontSize:f.tableFontSize||11,textAlign:(f.tableTextAlign as any)||'left',width:'100%',margin:0,boxSizing:'border-box'}}>
              {f.slicerSelectAll&&<label className="slicerListItem" style={{borderBottom:'1px solid #e2e8f0',marginBottom:4,paddingBottom:4}}><input type="checkbox" checked={allSelected} onChange={e=>{e.stopPropagation();apply(allSelected?[]:allOptions,!allSelected)}}/><span>Select all</span></label>}
              {options.map(value=><label key={value} className="slicerListItem"><input type="checkbox" checked={slicerSelected.includes(value)} onChange={e=>{e.stopPropagation();choose(value)}}/><span>{value}</span></label>)}
            </div>
          ):(
            <select aria-label={v.title||field||'Report filter'} className="slicerDropdown viewerSlicerDropdown" style={{width:'100%',margin:0,height:28,minHeight:28,color:f.tableTextColor,fontSize:f.tableFontSize||11,background:f.tableBackground||'#fff',textAlign:f.tableTextAlign,boxSizing:'border-box'}} value={allSelected?'__all__':slicerSelected[0]||''} onChange={e=>{if(e.target.value==='__all__'){apply(allOptions,true)}else if(e.target.value){apply([e.target.value])}else{apply([])}}}>
              <option value="" style={{background:f.tableBackground||'#ffffff',color:f.tableTextColor||'inherit'}}>Select…</option>
              {f.slicerSelectAll&&<option value="__all__" style={{background:f.tableBackground||'#ffffff',color:f.tableTextColor||'inherit'}}>Select all</option>}
              {options.map(value=><option key={value} value={value} style={{background:f.tableBackground||'#ffffff',color:f.tableTextColor||'inherit'}}>{value}</option>)}
            </select>
          )
        ):mode==='list'?(
          <div className={'slicerList slicer-list orientation-'+(f.slicerOrientation||'vertical')} style={{flex:1,overflow:'auto','--slicer-text':f.tableTextColor||'#242424','--slicer-size':`${f.tableFontSize||11}px`,'--slicer-bg':f.tableBackground||'#ffffff','--slicer-alt':f.tableAlternatingRows===false?(f.tableBackground||'#ffffff'):(f.tableAlternateColor||'#f8fafc'),textAlign:f.tableTextAlign} as any}>
            {f.slicerSelectAll&&!f.slicerSingleSelect&&<label className="slicerListItem"><input type="checkbox" checked={allSelected} onChange={e=>{e.stopPropagation();apply(allSelected?[]:allOptions,!allSelected)}}/><span>Select all</span></label>}
            {options.map(value=><label key={value} className="slicerListItem"><input type={(f.slicerSingleSelect||!f.slicerMultiSelect)?'radio':'checkbox'} checked={slicerSelected.includes(value)} onChange={e=>{e.stopPropagation();choose(value)}}/><span>{value}</span></label>)}
          </div>
        ):(
          <div className={'slicerList slicer-'+mode+' orientation-'+(f.slicerOrientation||'vertical')} style={{...(mode==='button'?gridStyle:{}),flex:1,overflow:'auto','--slicer-text':f.tableTextColor||'#242424','--slicer-size':`${f.tableFontSize||11}px`,'--slicer-bg':f.tableBackground||'#ffffff','--slicer-alt':f.tableAlternateColor||'#f8fafc',textAlign:f.tableTextAlign} as any}>
            {f.slicerSelectAll&&!f.slicerSingleSelect&&<button className={allSelected?'active':''} style={{borderRadius:f.slicerCornerRadius??6}} onClick={e=>{e.stopPropagation();apply(allSelected?[]:allOptions,!allSelected)}}>Select all</button>}
            {options.map(value=><button key={value} className={slicerSelected.includes(value)?'active':''} style={{borderRadius:f.slicerCornerRadius??6,color:f.tableTextColor,fontSize:f.tableFontSize}} onClick={e=>{e.stopPropagation();choose(value)}}>{value}</button>)}
          </div>
        )}
      </div>
    );
  })():<Chart visual={displayVisual} rows={rows} conditionalValues={conditionalValues} onPointClick={(field,value)=>onCrossFilter({field,operator:'equals',value})}/>;
  const narrative=visualExportNarrative(v,rows);
  const cardStyle:any={
    width:'100%',
    height:'100%',
    boxSizing:'border-box',
    overflow:'hidden',
    display:'flex',
    flexDirection:'column',
    background,
    border:'0',
    borderTop:edges.top?border:'0',
    borderRight:edges.right?border:'0',
    borderBottom:edges.bottom?border:'0',
    borderLeft:edges.left?border:'0',
    borderRadius:radius,
    boxShadow:shadow,
    fontFamily:`${f.fontFamily||'Aptos'}, 'Segoe UI Variable', 'Segoe UI', sans-serif`,
    '--viewer-accent':accent,
    '--viewer-background':background,
    '--viewer-border-top':edges.top?border:'none',
    '--viewer-border-right':edges.right?border:'none',
    '--viewer-border-bottom':edges.bottom?border:'none',
    '--viewer-border-left':edges.left?border:'none',
    '--viewer-radius':radius,
    '--viewer-shadow':shadow,
    '--viewer-title-background':titleBackground,
    '--viewer-title-color':f.titleColor||(dark?'#fff':'#111827'),
    '--viewer-title-size':`${f.titleFontSize||12}px`,
    '--viewer-title-weight':f.titleBold===false?400:(f.titleFontWeight||700),
    '--viewer-title-align':f.titleAlignment||'left',
    '--visual-title-align':f.titleAlignment||'left',
    '--visual-subtitle-align':f.subtitleAlignment||f.titleAlignment||'left',
    '--visual-title-font':f.titleFontFamily||f.fontFamily||'Segoe UI',
    '--visual-title-size':`${f.titleFontSize||12}px`,
    '--visual-title-weight':f.titleBold===false?400:(f.titleFontWeight||700),
    '--visual-title-style':f.titleFontStyle||'normal',
    '--visual-title-decoration':f.titleUnderline?'underline':'none',
    '--visual-title-wrap':f.titleWrap===false?'nowrap':'normal',
    '--visual-subtitle-font':f.subtitleFontFamily||f.titleFontFamily||f.fontFamily||'Segoe UI',
    '--visual-subtitle-size':`${f.subtitleFontSize||10}px`,
    '--visual-subtitle-color':f.subtitleColor||'#616161',
    '--visual-subtitle-weight':f.subtitleBold?(f.subtitleFontWeight||700):400,
    '--visual-subtitle-style':f.subtitleFontStyle||'normal',
    '--visual-subtitle-decoration':f.subtitleUnderline?'underline':'none',
    '--visual-subtitle-wrap':f.subtitleWrap===false?'nowrap':'normal',
    '--viewer-padding-top':`${f.paddingTop??f.padding??8}px`,
    '--viewer-padding-right':`${f.paddingRight??f.padding??8}px`,
    '--viewer-padding-bottom':`${f.paddingBottom??f.padding??8}px`,
    '--viewer-padding-left':`${f.paddingLeft??f.padding??8}px`,
    '--visual-background':background,
    '--visual-title-background':titleBackground,
    '--visual-border-top':edges.top?border:'none',
    '--visual-border-right':edges.right?border:'none',
    '--visual-border-bottom':edges.bottom?border:'none',
    '--visual-border-left':edges.left?border:'none',
    '--visual-radius':radius,
    '--visual-shadow':shadow,
    '--visual-title-color':f.titleColor||(dark?'#fff':'#0f172a'),
    '--visual-padding-top':`${f.paddingTop??f.padding??8}px`,
    '--visual-padding-right':`${f.paddingRight??f.padding??8}px`,
    '--visual-padding-bottom':`${f.paddingBottom??f.padding??8}px`,
    '--visual-padding-left':`${f.paddingLeft??f.padding??8}px`,
    '--published-background':background,
    '--published-border-top':edges.top?border:'0',
    '--published-border-right':edges.right?border:'0',
    '--published-border-bottom':edges.bottom?border:'0',
    '--published-border-left':edges.left?border:'0',
    '--published-radius':radius,
    '--published-shadow':shadow,
    '--published-title-color':f.titleColor||(dark?'#fff':'#111827'),
    '--published-title-size':`${f.titleFontSize||12}px`,
    '--published-title-weight':f.titleBold===false?400:(f.titleFontWeight||700),
    '--published-callout-size':`${f.fontSize||28}px`,
    '--published-pad-top':`${f.paddingTop??f.padding??8}px`,
    '--published-pad-right':`${f.paddingRight??f.padding??8}px`,
    '--published-pad-bottom':`${f.paddingBottom??f.padding??8}px`,
    '--published-pad-left':`${f.paddingLeft??f.padding??8}px`,
    '--slicer-font':f.tableFontFamily||f.fontFamily||'Segoe UI',
    '--slicer-text':f.tableTextColor||'#242424',
    '--slicer-size':`${f.tableFontSize||11}px`,
    '--slicer-weight':f.tableTextBold?700:400,
    '--slicer-style':f.tableTextItalic?'italic':'normal',
    '--slicer-wrap':f.tableTextWrap?'normal':'nowrap',
    '--slicer-align':f.tableTextAlign||'left',
    '--slicer-bg':f.tableBackground||'#ffffff',
    '--slicer-alt':f.tableAlternatingRows===false?(f.tableBackground||'#ffffff'):(f.tableAlternateColor||'#f8fafc'),
    '--slicer-row-padding':`${f.tableRowPadding??8}px`
  };
  const card=<div className={`viewerVisual viewerVisual-${v.type} visualCard ${v.type==='slicer'?'slicerVisual':''} ${responsiveSizeClass}`} data-export-state={loading?'loading':err?'error':'ready'} data-visual-title={v.title||v.type} data-export-narrative={JSON.stringify(narrative)} data-export-insights={JSON.stringify(narrative.points)} style={cardStyle}>
    {f.showTitle!==false&&<div className="viewerVisualTitle visualTitle" style={{background:titleBackground,...titleTextStyle}}><div className="viewerVisualTitleLabel visualTitleText" style={{flex:1,minWidth:0,textAlign:f.titleAlignment||'left',display:'flex',flexDirection:'column',alignItems:'stretch'}}><span style={{...titleTextStyle,display:'block',width:'100%',textAlign:f.titleAlignment||'left'}}>{v.title}</span>{f.subtitleVisible&&f.subtitle&&<small style={{...subtitleTextStyle,display:'block',width:'100%',textAlign:f.subtitleAlignment||f.titleAlignment||'left'}}>{f.subtitle}</small>}</div>{f.visualHeader!==false&&<button className="viewerVisualFocus" onClick={()=>setFocus(true)} title="Focus visual"><Maximize2 size={13}/></button>}</div>}
    <div className="viewerVisualBody" style={{paddingTop:f.paddingTop??f.padding??8,paddingRight:f.paddingRight??f.padding??8,paddingBottom:f.paddingBottom??f.padding??8,paddingLeft:f.paddingLeft??f.padding??8}}>{loading?<div className="viewerVisualLoading" role="status"><span className="viewerSpinner"/><b>Loading visual data…</b></div>:err?<div className="viewerError">{err}</div>:content}</div>
  </div>;
  return <>{card}{focus&&createPortal(<div className="visualFocusBackdrop" onMouseDown={()=>setFocus(false)}><div className="visualFocusPanel viewerFocusPanel" onMouseDown={e=>e.stopPropagation()}><div className="visualFocusHeader"><div><small>FOCUS MODE</small><b>{v.title}</b></div><button onClick={()=>setFocus(false)}>Close</button></div><div className="visualFocusBody">{content}</div></div></div>,document.body)}</>;
}
export default function PublishedViewer({reportId,initialItem,embedded=false,cloudMode=false,initialPaginatedId,userRole,onBack,onManageAccess}:{reportId:string,initialItem?:any,embedded?:boolean,cloudMode?:boolean,initialPaginatedId?:string,userRole?:string,onBack?:()=>void,onManageAccess?:()=>void}){
 const[item,setItem]=useState<any>((initialItem && initialItem.project)?initialItem:null),[error,setError]=useState(''),[pageIndex,setPageIndex]=useState(0),[full,setFull]=useState(false),[viewMode,setViewMode]=useState<'fitWidth'|'fitPage'|'actual'>('fitWidth'),[scale,setScale]=useState(1),[interactionFilters,setInteractionFilters]=useState<VisualFilter[]>([]),[runtimeHidden,setRuntimeHidden]=useState<Record<string,boolean>>({}),[buttonSelections,setButtonSelections]=useState<Record<string,string>>({}),[authRequired,setAuthRequired]=useState(false),[signedIn,setSignedIn]=useState(true),[login,setLogin]=useState({email:'',password:''}),[exporting,setExporting]=useState<''|'pdf'|'pptx'>(''),[visualResults,setVisualResults]=useState<Record<string,VisualQueryResult>>({}),[visualLoading,setVisualLoading]=useState(false),[visualLoadError,setVisualLoadError]=useState(''),[visualReloadKey,setVisualReloadKey]=useState(0);
 const[publishedMode,setPublishedMode]=useState<'interactive'|'paginated'>(initialPaginatedId?'paginated':'interactive');
 const[activeRibbonTab,setActiveRibbonTab]=useState<'Home'|'File'|'View'>('Home');
 const[fileDropdownOpen,setFileDropdownOpen]=useState(false);
 const[exportSubmenuOpen,setExportSubmenuOpen]=useState(false);
 const[embedSubmenuOpen,setEmbedSubmenuOpen]=useState(false);
 const[embedModal,setEmbedModal]=useState<'portal'|'web'|'sharepoint'|'developer'|null>(null);
 const[qrModalOpen,setQrModalOpen]=useState(false);
 const[saveAsModalOpen,setSaveAsModalOpen]=useState(false);
 const[saveAsName,setSaveAsName]=useState('');
 const[settingsModalOpen,setSettingsModalOpen]=useState(false);
 const[automationMode,setAutomationMode]=useState<'subscription'|'alert'|null>(null);
 const[copied,setCopied]=useState(false);
 const[pagesPanelCollapsed,setPagesPanelCollapsed]=useState(false);
 const[isFavorite,setIsFavorite]=useState<boolean>(()=>{try{const favs=JSON.parse(localStorage.getItem('vtab_pbi_favorites')||'[]');return Array.isArray(favs)&&favs.includes(reportId)}catch{return false}});
 const toggleFavorite=()=>{try{const favs=JSON.parse(localStorage.getItem('vtab_pbi_favorites')||'[]');const next=favs.includes(reportId)?favs.filter((x:string)=>x!==reportId):[...favs,reportId];localStorage.setItem('vtab_pbi_favorites',JSON.stringify(next));setIsFavorite(next.includes(reportId))}catch{}};
 const toggleFullScreen=async()=>{
  const next=!full;
  setFull(next);
  try{
   if(next&&!document.fullscreenElement){await document.documentElement.requestFullscreen?.();}
   else if(!next&&document.fullscreenElement){await document.exitFullscreen?.();}
  }catch{}
 };
 useEffect(()=>{
  const onDone=()=>setExporting('');
  window.addEventListener('vtab-export-paginated-done',onDone);
  return()=>window.removeEventListener('vtab-export-paginated-done',onDone);
 },[]);
 useEffect(()=>{
  const onFsChange=()=>{setFull(!!document.fullscreenElement);};
  document.addEventListener('fullscreenchange',onFsChange);
  return()=>document.removeEventListener('fullscreenchange',onFsChange);
 },[]);
 useEffect(()=>{
  if(!full)return;
  const onKey=(e:KeyboardEvent)=>{
   if(e.key==='Escape'){
    setFull(false);
    if(document.fullscreenElement)document.exitFullscreen?.().catch(()=>{});
   }
  };
  window.addEventListener('keydown',onKey);
  return()=>window.removeEventListener('keydown',onKey);
 },[full]);
 const stageRef=useRef<HTMLElement|null>(null);
 const actionPageHistoryRef=useRef<number[]>([]),runtimeVisibilityDefaultsRef=useRef<Record<string,boolean>>({});
 const load=()=>{
  if(initialItem && initialItem.project){setItem(initialItem);setError('');return;}
  if(WORKSPACE_ONLY){
   fetchReportFromSupabase(reportId).then(x=>{setItem({...x, role: userRole || initialItem?.role || x?.role});setError('')}).catch(e=>setError(e.message||String(e)));
   return;
  }
  api<any>(`/published/${reportId}`).then(x=>{setItem({...x, role: userRole || initialItem?.role || x?.role});setError('')}).catch(e=>setError(e.message||String(e)))
 };
 useEffect(()=>{
  if(initialItem && initialItem.project){setItem(initialItem);setError('');return;}
  if(WORKSPACE_ONLY){load();return;}
  api<any>('/auth/status').then(s=>{setAuthRequired(!!s.required);if(s.required){api('/auth/me').then(()=>{setSignedIn(true);load()}).catch(()=>setSignedIn(false))}else load()})
 },[reportId,initialItem?.id]);
 const project=item?.project,report=project?.report,pages=report?.pages||[],page=pages[pageIndex]||pages[0],s=page?.settings||{},paginatedReports=project?.paginatedReports||[];
 const effectiveRole = userRole || item?.role || initialItem?.role;
 const isViewer = !effectiveRole || effectiveRole === 'Viewer' || effectiveRole?.toLowerCase() === 'viewer';
 const canExport = !isViewer;
 const visibleVisuals=useMemo<Visual[]>(()=>page?.visuals?.filter((v:Visual)=>v.visible!==false&&!v.hidden&&!runtimeHidden[v.id])||[],[page,runtimeHidden]);
 const queryVisualIds=useMemo(()=>visibleVisuals.filter(v=>!['textbox','button','image','shape'].includes(v.type)).map(v=>v.id),[visibleVisuals]);
 const combinedFilters=useMemo<VisualFilter[]>(()=>[...(report?.filters||[]),...(page?.filters||[]),...interactionFilters],[report,page,interactionFilters]);
 useEffect(()=>{
   if(!item||!page||publishedMode!=='interactive'){setVisualLoading(false);return}
   if(!queryVisualIds.length){setVisualResults({});setVisualLoadError('');setVisualLoading(false);return}
   const controller=new AbortController();
   setVisualLoading(true);setVisualLoadError('');setVisualResults({});
   queryPageVisuals(reportId,queryVisualIds,combinedFilters,controller.signal)
    .then(response=>{if(!controller.signal.aborted)setVisualResults(response.results||{})})
    .catch((error:any)=>{if(!controller.signal.aborted)setVisualLoadError(error?.message||String(error))})
    .finally(()=>{if(!controller.signal.aborted)setVisualLoading(false)});
   return()=>controller.abort();
 },[reportId,item?.id,page?.id,JSON.stringify(queryVisualIds),JSON.stringify(combinedFilters),publishedMode,visualReloadKey]);
 useEffect(()=>{const targetPage=new URLSearchParams(location.search).get('page');if(targetPage){const index=pages.findIndex((item:any)=>item.id===targetPage);if(index>=0)setPageIndex(index)}},[item?.id]);
 const width=s.pageWidth||1600,height=s.pageHeight||900;
 const pixelLayout=(page?.visuals||[]).some((visual:Visual)=>visual.geometryVersion===2);
 const visualBottom=(page?.visuals||[]).reduce((m:any,v:any)=>Math.max(m,v.geometryVersion===2?(v.y||0)+(v.h||100):(v.y||0)*70+(v.h||2)*54+Math.max(0,(v.h||2)-1)*16),0);
 const headerHeight=s.header?.visible!==false?(s.header?.height||84):0;
 // Geometry-v2 coordinates are page-relative (the Desktop canvas origin), so
 // adding the header height here would count it twice and create a blank band.
 const contentHeight=Math.max(480,visualBottom+(s.footerGap??96)+(pixelLayout?0:headerHeight+34));
 // A geometry-v2 report owns an explicit canvas size (for example 960x720,
 // 4:3). Never grow that canvas from visual-content heuristics because doing
 // so changes the orientation that was authored in Desktop.
 const effectiveHeight=s.autoFitHeight ? Math.max(height,contentHeight) : (pixelLayout ? height : Math.max(height,contentHeight));
 useEffect(()=>{
   if(!item||!page)return;
   const stage=stageRef.current;if(!stage)return;
   const compute=()=>{
     const rect=stage.getBoundingClientRect();
     const availW=Math.max(240,rect.width-(viewMode==='fitWidth'?36:28)),availH=Math.max(240,rect.height-28);
     let next=1;
     if(viewMode==='fitWidth')next=availW/width;
     else if(viewMode==='fitPage')next=Math.min(availW/width,availH/effectiveHeight);
     else next=1;
     const clamped=Math.max(.1,Math.min(4,next));
     setScale(prev=>Math.abs(prev-clamped)>.002?clamped:prev);
   };
   compute();const ro=new ResizeObserver(compute);ro.observe(stage);window.addEventListener('resize',compute);return()=>{ro.disconnect();window.removeEventListener('resize',compute)};
 },[width,effectiveHeight,viewMode,full,activeRibbonTab,publishedMode,item?.id,page?.id]);
 useEffect(()=>{const stage=stageRef.current;if(stage)stage.scrollTo({top:0,left:0,behavior:'instant' as ScrollBehavior})},[pageIndex,viewMode,full,item?.id]);
 useEffect(()=>{for(const reportPage of pages)for(const visual of reportPage.visuals||[])if(Object.prototype.hasOwnProperty.call(runtimeVisibilityDefaultsRef.current,visual.id))visual.hidden=runtimeVisibilityDefaultsRef.current[visual.id];setRuntimeHidden({});setInteractionFilters([])},[page?.id]);
 const doLogin=async()=>{try{const r=await api<any>('/auth/login',{method:'POST',body:JSON.stringify(login)});localStorage.setItem('vtab_workspace_token',r.token);setSignedIn(true);load()}catch(e:any){alert(e.message)}};
 if(authRequired&&!signedIn)return <div className="workspaceLogin"><div className="workspaceLoginCard"><div className="brandMark">V</div><h2>Sign in to VTAB Workspace</h2><p>This published report requires a workspace account.</p><input placeholder="Email" value={login.email} onChange={e=>setLogin({...login,email:e.target.value})}/><input type="password" placeholder="Password" value={login.password} onChange={e=>setLogin({...login,password:e.target.value})}/><button className="primary" onClick={doLogin}>Sign In</button></div></div>;
 if(error)return <div className="viewerLoading"><b>Published report could not be opened</b><span>{error}</span><button onClick={()=>location.href='/?workspace=1'}>Open Workspace</button></div>;
 if(!item)return <div className="viewerLoading">Opening published report…</div>;
 if(!page)return <div className="viewerLoading">This published report has no pages.</div>;
 const exportFile=async(fmt:'pdf'|'pptx')=>{
   if (isViewer) { alert('Viewers are strictly prohibited from downloading or exporting reports.'); return; }
  if(exporting)return;
  if(publishedMode==='paginated'){
   if(fmt==='pptx') return;
   setExporting(fmt);
   window.dispatchEvent(new CustomEvent('vtab-export-paginated',{detail:{fmt}}));
   setTimeout(()=>setExporting(cur=>cur===fmt?'':cur),8000);
   return;
  }
  const originalPage=pageIndex;setExporting(fmt);
  try{
   const rendered=[] as Array<{name:string,image:string,insights:string[],narratives:ExportNarrative[]}>;
   for(let index=0;index<pages.length;index++){
    const pageDefinition=pages[index],pageSettings=pageDefinition.settings||{},pageWidth=pageSettings.pageWidth||1600;
    const pageVisuals=pageDefinition.visuals||[];
    const pagePixelLayout=pageVisuals.some((visual:Visual)=>visual.geometryVersion===2);
    const pageVisualBottom=pageVisuals.reduce((m:any,v:any)=>Math.max(m,v.geometryVersion===2?(v.y||0)+(v.h||100):(v.y||0)*70+(v.h||2)*54+Math.max(0,(v.h||2)-1)*16),0);
    const pageHeaderHeight=pageSettings.header?.visible!==false?(pageSettings.header?.height||84):0;
    const pageContentHeight=Math.max(480,pageVisualBottom+(pageSettings.footerGap??96)+(pagePixelLayout?0:pageHeaderHeight+34));
    const pageHeight=pageSettings.autoFitHeight?Math.max(pageSettings.pageHeight||900,pageContentHeight):(pagePixelLayout?(pageSettings.pageHeight||900):Math.max(pageSettings.pageHeight||900,pageContentHeight));
    setPageIndex(index);const stage=stageRef.current;if(!stage)throw new Error('The report canvas is not available for export.');
    const reportPage=await waitForExportPage(stage,String(pageDefinition.id||''),pageDefinition.name||`Page ${index+1}`);
    const insights=Array.from(reportPage.querySelectorAll<HTMLElement>('[data-export-insights]')).flatMap(node=>{try{return JSON.parse(node.dataset.exportInsights||'[]')}catch{return[]}}).filter((value,index,array)=>value&&array.indexOf(value)===index).slice(0,6);
    const narratives=Array.from(reportPage.querySelectorAll<HTMLElement>('[data-export-narrative]')).map(node=>{try{return JSON.parse(node.dataset.exportNarrative||'{}')}catch{return null}}).filter((value:any)=>value&&value.title&&Array.isArray(value.points)&&value.points.length).slice(0,6);
    rendered.push({name:pageDefinition.name||`Page ${index+1}`,image:await captureViewerPage(reportPage,pageWidth,pageHeight),insights,narratives});
   }
   const safe=(report?.name||'VTAB_Report').replace(/[^A-Za-z0-9_-]+/g,'_'),extension=fmt==='pdf'?'pdf':'pptx';
   await apiDownloadPost(`/published/${reportId}/export-rendered/${fmt}`,`${safe}.${extension}`,{pages:rendered,project});
  }catch(error:any){alert(error?.message||String(error))}finally{setPageIndex(originalPage);setExporting('')}
 };
 const shareEmail=()=>{const to=window.prompt('Recipient email(s), comma separated:','');if(!to)return;const attach=(window.prompt('Attachment: none, pdf or pptx','none')||'none').toLowerCase();api(`/published/${reportId}/share-email`,{method:'POST',body:JSON.stringify({to,attach:attach==='none'?'':attach,subject:`VTAB Report: ${report.name}`,message:'A VTAB Workspace report has been shared with you.',reportUrl:location.href})}).then(()=>alert('Report shared by email.')).catch((e:any)=>alert(e.message))};
 const executeAction=(v:Visual)=>{
  if(v.format?.buttonSelectionEnabled!==false){const group=(v.format?.buttonSelectionGroup||'default').trim()||'default';setButtonSelections(previous=>({...previous,[group]:v.id}))}
  const a=v.action;if(!a||a.type==='none')return;
  if(a.type==='navigate'){
   if(a.targetReportId&&a.targetReportId!==reportId){const url=new URL(location.href);url.searchParams.set('workspace','1');url.searchParams.set('report',a.targetReportId);if(a.targetPageId)url.searchParams.set('page',a.targetPageId);else url.searchParams.delete('page');location.href=url.toString();return}
   if(a.targetPageId){const i=pages.findIndex((item:any)=>item.id===a.targetPageId);if(i>=0){actionPageHistoryRef.current.push(pageIndex);setPageIndex(i);setInteractionFilters([])}}return;
  }
  if(a.type==='back'){const previous=actionPageHistoryRef.current.pop();setPageIndex(previous??Math.max(0,pageIndex-1));setInteractionFilters([]);return}
  if(a.type==='resetState'||a.type==='clearFilters'){setInteractionFilters([]);if(a.type==='resetState'){for(const item of page.visuals||[])if(Object.prototype.hasOwnProperty.call(runtimeVisibilityDefaultsRef.current,item.id))item.hidden=runtimeVisibilityDefaultsRef.current[item.id];setRuntimeHidden({});window.dispatchEvent(new Event('vtab-reset-state'))}return}
  const commands=resolveActionCommands(a,page);if(!commands.length)return;
  setRuntimeHidden(hidden=>{const next={...hidden};for(const command of commands){const allHidden=command.targets.length>0&&command.targets.every((target:Visual)=>visualIsHidden(target,next));for(const target of command.targets){if(!Object.prototype.hasOwnProperty.call(runtimeVisibilityDefaultsRef.current,target.id))runtimeVisibilityDefaultsRef.current[target.id]=!!target.hidden;const value=command.operation==='show'?false:command.operation==='hide'?true:!allHidden;target.hidden=value;next[target.id]=value}}return next});
 };
 for(const visual of page.visuals||[])if(visual.type==='button'&&visual.action?.dynamicLabel!==false)visual.buttonLabel=resolveActionButtonLabel(visual,page,pages,runtimeHidden);


  const downloadThisFile = async () => {
    if (!canExport || isViewer) { alert('Viewers are strictly prohibited from downloading reports.'); return; }
    try {
      const safe = (report?.name || 'VTAB_Report').replace(/[^a-zA-Z0-9_-]+/g, '_');
      try {
        await apiDownload(`/packages/export/complete`, `${safe}.vtabpkg`);
      } catch {
        const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${safe}.vtabapp`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      }
    } catch (e: any) {
      alert(e.message || String(e));
    }
  };

  const embedUrl = `${window.location.origin}/?workspace=1&report=${encodeURIComponent(reportId)}&embed=1`;
  const embedIframe = `<iframe title="${report?.name || 'VTAB Report'}" width="100%" height="600" src="${embedUrl}" frameborder="0" allowFullScreen="true"></iframe>`;

  return <div className={'publishedViewer '+(!embedded?'viewerStandalone ':'')+(full?'viewerFull':'')}>
   {/* Power BI Fabric Topbar (Matching Image 2 & 3) */}
   {!full && (
   <div className="pbi-report-topbar">
     <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
       {(onBack || embedded) && (
         <button onClick={onBack || (() => { location.href = '/?workspace=1'; })} className="pbi-btn-back" title="Back to workspace">
           <ArrowLeft size={14} /> Back
         </button>
       )}
       <div className="fabric-brand-v">V</div>
       <div className="pbi-report-title-meta">
         <b>{report.name}</b>
         <small>Data updated {new Date(item.updated_at || item.published_at).toLocaleDateString()}</small>
       </div>
     </div>

     <div style={{ flex: 1 }} />

     <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
       <span style={{ fontSize: 12, fontWeight: 600, color: '#166534', background: '#dcfce7', padding: '4px 10px', borderRadius: 4, display: 'flex', alignItems: 'center', gap: 5 }}>
         <ShieldCheck size={14} /> Governed
       </span>
       {onManageAccess ? (
         <button onClick={onManageAccess} style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#0d6257', color: '#fff', border: 'none', borderRadius: 4, padding: '6px 14px', fontWeight: 600, fontSize: 12, cursor: 'pointer' }}>
           <Share2 size={14} /> Share
         </button>
       ) : (
         <button onClick={shareEmail} style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#0d6257', color: '#fff', border: 'none', borderRadius: 4, padding: '6px 14px', fontWeight: 600, fontSize: 12, cursor: 'pointer' }}>
           <Share2 size={14} /> Share
         </button>
       )}
     </div>
   </div>
   )}

   {/* Power BI Fabric Ribbon Tabs: File | Home | View */}
   {!full && (
   <div className="pbi-report-ribbon-tabs">
     <div style={{ position: 'relative' }}>
       <button 
         className={`pbi-ribbon-tab-btn ${fileDropdownOpen ? 'active' : ''}`}
         onClick={() => setFileDropdownOpen(!fileDropdownOpen)}
       >
         File <ChevronDown size={12} style={{ marginLeft: 2 }} />
       </button>
       {fileDropdownOpen && (
         <div className="pbi-dropdown-menu" onMouseLeave={() => { setExportSubmenuOpen(false); setEmbedSubmenuOpen(false); }}>
           <button className="pbi-menu-item" onClick={() => { setFileDropdownOpen(false); setSaveAsName(`${report.name} - Copy`); setSaveAsModalOpen(true); }}>
             <div className="pbi-menu-item-left"><Copy size={15} /> Save as...</div>
           </button>
           {canExport && (
             <>
               <button className="pbi-menu-item" onClick={() => { setFileDropdownOpen(false); void downloadThisFile(); }}>
                 <div className="pbi-menu-item-left"><Download size={15} /> Download this file</div>
               </button>
               <div style={{ position: 'relative' }} onMouseEnter={() => { setExportSubmenuOpen(true); setEmbedSubmenuOpen(false); }}>
                 <button className="pbi-menu-item">
                   <div className="pbi-menu-item-left"><FileDown size={15} /> Export</div>
                   <ChevronRight size={14} className="pbi-menu-chevron" />
                 </button>
                 {exportSubmenuOpen && (
                   <div className="pbi-submenu">
                      {publishedMode !== 'paginated' && (
                        <button className="pbi-menu-item" onClick={() => { setFileDropdownOpen(false); setExportSubmenuOpen(false); exportFile('pptx'); }}>
                          <div className="pbi-menu-item-left"><Presentation size={15} /> PowerPoint</div>
                        </button>
                      )}
                     <button className="pbi-menu-item" onClick={() => { setFileDropdownOpen(false); setExportSubmenuOpen(false); exportFile('pdf'); }}>
                       <div className="pbi-menu-item-left"><FileDown size={15} /> PDF</div>
                     </button>
                   </div>
                 )}
               </div>
             </>
           )}
           <button className="pbi-menu-item" onClick={() => { setFileDropdownOpen(false); window.print(); }}>
             <div className="pbi-menu-item-left"><Printer size={15} /> Print this page</div>
           </button>
           <div style={{ position: 'relative' }} onMouseEnter={() => { setEmbedSubmenuOpen(true); setExportSubmenuOpen(false); }}>
             <button className="pbi-menu-item">
               <div className="pbi-menu-item-left"><Code2 size={15} /> Embed report</div>
               <ChevronRight size={14} className="pbi-menu-chevron" />
             </button>
             {embedSubmenuOpen && (
               <div className="pbi-submenu">
                 <button className="pbi-menu-item" onClick={() => { setFileDropdownOpen(false); setEmbedSubmenuOpen(false); setEmbedModal('sharepoint'); }}>
                   <div className="pbi-menu-item-left"><Globe size={15} /> SharePoint online</div>
                 </button>
                 <button className="pbi-menu-item" onClick={() => { setFileDropdownOpen(false); setEmbedSubmenuOpen(false); setEmbedModal('portal'); }}>
                   <div className="pbi-menu-item-left"><Code2 size={15} /> Website or portal</div>
                 </button>
                 <button className="pbi-menu-item" onClick={() => { setFileDropdownOpen(false); setEmbedSubmenuOpen(false); setEmbedModal('web'); }}>
                   <div className="pbi-menu-item-left"><ExternalLink size={15} /> Publish to web (public)</div>
                 </button>
                 <button className="pbi-menu-item" onClick={() => { setFileDropdownOpen(false); setEmbedSubmenuOpen(false); setEmbedModal('developer'); }}>
                   <div className="pbi-menu-item-left"><FileArchive size={15} /> Developer Playground</div>
                 </button>
               </div>
             )}
           </div>
           <button className="pbi-menu-item" onClick={() => { setFileDropdownOpen(false); setQrModalOpen(true); }}>
             <div className="pbi-menu-item-left"><QrCode size={15} /> Generate QR code</div>
           </button>
           <div className="pbi-menu-divider" />
           <button className="pbi-menu-item" onClick={() => { toggleFavorite(); setFileDropdownOpen(false); }}>
             <div className="pbi-menu-item-left">
               <Star size={15} fill={isFavorite ? '#d97706' : 'none'} color={isFavorite ? '#d97706' : '#616161'} /> 
               {isFavorite ? 'Remove from favorites' : 'Add to favorites'}
             </div>
           </button>
           <button className="pbi-menu-item" onClick={() => { setFileDropdownOpen(false); if (onManageAccess) onManageAccess(); else shareEmail(); }}>
             <div className="pbi-menu-item-left"><Users size={15} /> Manage access</div>
           </button>
           <button className="pbi-menu-item" onClick={() => { setFileDropdownOpen(false); setSettingsModalOpen(true); }}>
             <div className="pbi-menu-item-left"><Settings2 size={15} /> Settings</div>
           </button>
         </div>
       )}
     </div>

     <button 
       className={`pbi-ribbon-tab-btn ${activeRibbonTab === 'Home' ? 'active' : ''}`}
       onClick={() => { setActiveRibbonTab('Home'); setFileDropdownOpen(false); }}
     >
       Home
     </button>
     <button 
       className={`pbi-ribbon-tab-btn ${activeRibbonTab === 'View' ? 'active' : ''}`}
       onClick={() => { setActiveRibbonTab('View'); setFileDropdownOpen(false); }}
     >
       View
     </button>
   </div>
   )}

   {/* Home Ribbon Command Bar */}
   {!full && activeRibbonTab === 'Home' && (
     <div className="pbi-ribbon-command-bar">
       {canExport && (
         <>
           <button className="pbi-cmd-btn" onClick={() => exportFile('pdf')} disabled={!!exporting}>
             <FileDown size={15} color="#dc2626" /> PDF
           </button>
           {publishedMode !== 'paginated' && (
             <button className="pbi-cmd-btn" onClick={() => exportFile('pptx')} disabled={!!exporting}>
               <Presentation size={15} color="#ea580c" /> PPT
             </button>
           )}
           <div className="pbi-cmd-divider" />
         </>
       )}
       <button className="pbi-cmd-btn" onClick={onManageAccess || shareEmail}>
         <Share2 size={15} color="#0f6cbd" /> Share
       </button>
       <button className="pbi-cmd-btn" onClick={load}>
         <RefreshCcw size={15} color="#16a34a" /> Refresh
       </button>
       <button className="pbi-cmd-btn" onClick={()=>setAutomationMode('subscription')}>
         <Mail size={15} color="#0f6cbd" /> Subscribe
       </button>
       <button className="pbi-cmd-btn" onClick={()=>setAutomationMode('alert')}>
         <BellRing size={15} color="#b45309" /> Set alert
       </button>
       <div className="pbi-cmd-divider" />
       <a
         href="http://admin-reporting.139.59.32.39.nip.io/"
         target="_blank"
         rel="noopener noreferrer"
         className="pbi-cmd-btn"
         title="Open Admin Portal in new tab"
         style={{ textDecoration: 'none' }}
       >
         <ShieldCheck size={15} color="#0f6cbd" /> Admin Portal
       </a>
       {interactionFilters.length > 0 && (
         <button className="pbi-cmd-btn" onClick={() => setInteractionFilters([])}>
           <Eraser size={15} color="#b45309" /> Reset filters
         </button>
       )}
       {paginatedReports.length > 0 && project.paginatedPublishMode !== 'separate' && (
         <>
           <div className="pbi-cmd-divider" />
           <button className={`pbi-cmd-btn ${publishedMode === 'interactive' ? 'active' : ''}`} onClick={() => {setPublishedMode('interactive');setViewMode('fitWidth')}}>
             <BarChart3 size={15} /> Dashboard
           </button>
           <button className={`pbi-cmd-btn ${publishedMode === 'paginated' ? 'active' : ''}`} onClick={() => setPublishedMode('paginated')}>
             <FileText size={15} /> Paginated report
           </button>
         </>
       )}
     </div>
   )}

   {/* View Ribbon Command Bar (also shown in Full screen mode) */}
   {(full || activeRibbonTab === 'View') && (
     <div className="pbi-ribbon-command-bar">
       {full && (
         <>
           <div className="fabric-brand-v" style={{ width: 22, height: 22, fontSize: 12 }}>V</div>
           <b style={{ fontSize: 13, color: '#242424', marginRight: 8 }}>{report.name}</b>
           <div className="pbi-cmd-divider" />
         </>
       )}
       {publishedMode !== 'paginated' && (
         <>
           <button className={`pbi-cmd-btn ${viewMode === 'fitPage' ? 'active' : ''}`} onClick={() => setViewMode('fitPage')}>
             <Scaling size={15} /> Fit to page
           </button>
           <button className={`pbi-cmd-btn ${viewMode === 'fitWidth' ? 'active' : ''}`} onClick={() => setViewMode('fitWidth')}>
             <MonitorUp size={15} /> Fit to width
           </button>
           <button className={`pbi-cmd-btn ${viewMode === 'actual' ? 'active' : ''}`} onClick={() => setViewMode('actual')}>
             <Expand size={15} /> Actual size
           </button>
           <div className="pbi-cmd-divider" />
         </>
       )}
       <button className={`pbi-cmd-btn ${full ? 'active' : ''}`} onClick={toggleFullScreen}>
         {full ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
         {full ? 'Exit full screen' : 'Full screen'}
       </button>
     </div>
   )}
  {publishedMode==='paginated'?<PaginatedReportViewer reportId={reportId} project={project} filters={combinedFilters} cloudMode={cloudMode||WORKSPACE_ONLY} initialDefinitionId={initialPaginatedId} isViewer={isViewer || !canExport}/>:<div className="viewerBody">
   {/* Left Pages Side Panel */}
   <nav className={`viewerPagesPanel${pagesPanelCollapsed?' collapsed':''}`}>
     <div className="viewerPagesPanelHeader">
       {!pagesPanelCollapsed&&<span className="viewerPagesPanelTitle">Pages</span>}
       <button className="viewerPagesPanelToggle" onClick={()=>setPagesPanelCollapsed(c=>!c)} title={pagesPanelCollapsed?'Show pages':'Hide pages'}>
         {pagesPanelCollapsed?<ChevronRight size={14}/>:<ChevronLeft size={14}/>}
       </button>
     </div>
     {!pagesPanelCollapsed&&(
       <div className="viewerPagesPanelList">
         {pages.map((p:any,i:number)=>(
           <button key={p.id} className={'viewerPagesPanelItem'+(i===pageIndex?' active':'')} onClick={()=>setPageIndex(i)} title={p.name}>
             <span className="viewerPagesPanelDot"/>
             <span className="viewerPagesPanelName">{p.name}</span>
           </button>
         ))}
       </div>
     )}
   </nav>
   {/* Main canvas */}
   <main className="viewerStage" ref={stageRef} style={{position:"relative"}}>
     {(visualLoading||visualLoadError)&&(
       <div className={"viewerPageLoadNotice "+(visualLoadError?"error":"")} role="status">
         {visualLoading?(
           <>
             <span className="viewerSpinner"/>
             <div className="viewerPageLoadNoticeContent">
               <b>Loading visual data…</b>
               <span>Preparing {queryVisualIds.length} visual{queryVisualIds.length===1?"":"s"} on this page</span>
             </div>
           </>
         ):(
           <>
             <div className="viewerPageLoadNoticeContent">
               <b>Page data could not be loaded</b>
               <span>{visualLoadError}</span>
             </div>
             <button onClick={()=>setVisualReloadKey(key=>key+1)}>Try again</button>
           </>
         )}
       </div>
     )}
     <div className="viewerScaleFrame" style={{width:width*scale,height:effectiveHeight*scale}}>
    <div className={'viewerPage '+(pixelLayout?'pixelPublishedPage':'legacyPublishedPage')} data-page-id={String(page.id||'')} style={{width,height:effectiveHeight,background:s.background||'#f5f7fb',transform:`scale(${scale})`,transformOrigin:'top left'}}>
     {s.backgroundImage&&<div className="viewerPageBg" style={{backgroundImage:`url(${s.backgroundImage})`,backgroundSize:s.backgroundImageFit||'cover',opacity:(s.backgroundImageOpacity??24)/100}}/>}
     <div className="viewerPageLayer">
      {s.header?.visible!==false&&<div className="viewerDashboardHeader" style={{background:s.header?.background||'#fff','--viewer-header-bg':s.header?.background||'#fff','--viewer-header-height':`${s.header?.height||84}px`,'--viewer-header-pad-top':`${s.header?.paddingTop??12}px`,'--viewer-header-pad-bottom':`${s.header?.paddingBottom??12}px`,'--viewer-header-pad-left':`${s.header?.paddingLeft??24}px`,'--viewer-header-pad-right':`${s.header?.paddingRight??24}px`,'--viewer-header-radius':`${s.header?.borderRadius??14}px`,'--viewer-header-title-size':`${s.header?.fontSize||28}px`,'--viewer-header-title-color':s.header?.titleColor||'#111827','--viewer-header-subtitle-size':`${s.header?.subtitleFontSize||12}px`,'--viewer-header-subtitle-color':s.header?.subtitleColor||'#475569'} as any}><div className="viewerDashboardHeaderCopy" style={{textAlign:s.header?.alignment||'left'}}><h1 style={{color:s.header?.titleColor||'#111827'}}>{s.header?.title||''}</h1><p style={{color:s.header?.subtitleColor||'#475569'}}>{s.header?.subtitle||''}</p></div>{s.header?.showGeneratedInfo!==false&&<div className="viewerReportMeta" style={{background:s.header?.generatedInfoBackground||'#f8fbff'}}><CalendarDays size={20}/><div><small>REPORT GENERATED</small><b>{new Date(item.updated_at||item.published_at).toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'})}</b><span>{new Date(item.updated_at||item.published_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</span></div></div>}</div>}
      <div className={'viewerGrid '+(pixelLayout?'pixelLayout':'legacyLayout')}>{visibleVisuals.map((v:Visual,index:number)=><div key={v.id} className={`viewerVisualWrapper ${v.geometryVersion===2?'canvasObject':''}`} style={v.geometryVersion===2?{position:'absolute',left:v.x,top:v.y,width:v.w,height:v.h,zIndex:v.zIndex??index,transform:`rotate(${v.rotation||0}deg)`,transformOrigin:'center',display:'flex',flexDirection:'column',boxSizing:'border-box',overflow:'hidden'}:{gridColumn:`${v.x+1} / span ${v.w}`,gridRow:`${v.y+1} / span ${v.h}`}}><ViewerVisual v={v} result={visualResults[v.id]||(visualLoadError?{rows:[],error:visualLoadError}:undefined)} loading={!['textbox','button','image','shape'].includes(v.type)&&visualLoading} selected={buttonSelections[(v.format?.buttonSelectionGroup||'default').trim()||'default']===v.id} onCrossFilter={f=>setInteractionFilters(f?[f]:[])} onAction={executeAction}/></div>)}{visibleVisuals.length===0&&<div className="viewerEmptyPage"><b>No visible visuals on this published page</b><span>Open this page in Report Designer, verify visual visibility, save the report, and publish again.</span></div>}</div>
     </div>
    </div>
    </div>
   </main>
  </div>}
   {/* Embed Dialog */}
   {embedModal && (
     <div className="modalShade" onMouseDown={() => setEmbedModal(null)}>
       <div className="modalCard" onMouseDown={e => e.stopPropagation()} style={{ maxWidth: 580 }}>
         <div className="modalHead">
           <div>
             <span className="eyebrow">EMBED REPORT</span>
             <h3>{embedModal === 'portal' ? 'Embed in website or portal' : embedModal === 'web' ? 'Publish to web (public)' : embedModal === 'sharepoint' ? 'SharePoint Online' : 'Developer Playground'}</h3>
           </div>
           <button onClick={() => setEmbedModal(null)}>×</button>
         </div>
         <p style={{ margin: '8px 0 14px', fontSize: 13, color: '#616161' }}>
           {embedModal === 'portal' ? 'Copy the HTML iframe code below to embed this interactive report in your website, portal, or wiki.' : 'Use this link to securely view this report in a browser.'}
         </p>
         <div style={{ position: 'relative' }}>
           <textarea 
             readOnly 
             rows={4} 
             value={embedModal === 'portal' ? embedIframe : embedUrl}
             style={{ width: '100%', padding: '10px 12px', border: '1px solid #cbd5e1', borderRadius: 6, fontSize: 12, fontFamily: 'monospace', background: '#f8fafc', boxSizing: 'border-box' }}
           />
         </div>
         <div className="dialogActions" style={{ marginTop: 14 }}>
           <button className="primary" onClick={() => { navigator.clipboard.writeText(embedModal === 'portal' ? embedIframe : embedUrl); setCopied(true); setTimeout(() => setCopied(false), 2000); }}>
             {copied ? '✓ Copied' : 'Copy code'}
           </button>
           <button onClick={() => setEmbedModal(null)}>Close</button>
         </div>
       </div>
     </div>
   )}

   {/* QR Code Dialog */}
   {qrModalOpen && (
     <div className="modalShade" onMouseDown={() => setQrModalOpen(false)}>
       <div className="modalCard" onMouseDown={e => e.stopPropagation()} style={{ maxWidth: 380, textAlign: 'center' }}>
         <div className="modalHead">
           <div>
             <span className="eyebrow">MOBILE ACCESS</span>
             <h3>Report QR Code</h3>
           </div>
           <button onClick={() => setQrModalOpen(false)}>×</button>
         </div>
         <p style={{ margin: '8px 0 16px', fontSize: 13, color: '#616161' }}>
           Scan with any mobile device camera to open this report.
         </p>
         <div style={{ padding: 20, background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, display: 'inline-block' }}>
           <img 
             src={`https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(window.location.href)}`} 
             alt="Report QR Code"
             style={{ width: 180, height: 180, display: 'block' }}
           />
         </div>
         <div className="dialogActions" style={{ marginTop: 18, justifyContent: 'center' }}>
           <button className="primary" onClick={() => { navigator.clipboard.writeText(window.location.href); alert('Report URL copied to clipboard.'); }}>
             Copy link
           </button>
           <button onClick={() => setQrModalOpen(false)}>Close</button>
         </div>
       </div>
     </div>
   )}

   {/* Save As Dialog */}
   {saveAsModalOpen && (
     <div className="modalShade" onMouseDown={() => setSaveAsModalOpen(false)}>
       <div className="modalCard" onMouseDown={e => e.stopPropagation()} style={{ maxWidth: 440 }}>
         <div className="modalHead">
           <div>
             <span className="eyebrow">SAVE REPORT</span>
             <h3>Save a copy</h3>
           </div>
           <button onClick={() => setSaveAsModalOpen(false)}>×</button>
         </div>
         <p style={{ margin: '8px 0 14px', fontSize: 13, color: '#616161' }}>Enter a name for the new report copy:</p>
         <input 
           type="text" 
           value={saveAsName} 
           onChange={e => setSaveAsName(e.target.value)} 
           style={{ width: '100%', padding: '9px 12px', border: '1px solid #cbd5e1', borderRadius: 6, fontSize: 13, boxSizing: 'border-box' }}
         />
         <div className="dialogActions" style={{ marginTop: 18 }}>
           <span className="dialogSpacer" />
           <button onClick={() => setSaveAsModalOpen(false)}>Cancel</button>
           <button className="primary" onClick={() => { alert(`Report copy "${saveAsName}" saved.`); setSaveAsModalOpen(false); }}>Save</button>
         </div>
       </div>
     </div>
   )}

   {/* Settings Dialog */}
   {settingsModalOpen && (
     <div className="modalShade" onMouseDown={() => setSettingsModalOpen(false)}>
       <div className="modalCard" onMouseDown={e => e.stopPropagation()} style={{ maxWidth: 480 }}>
         <div className="modalHead">
           <div>
             <span className="eyebrow">SETTINGS</span>
             <h3>Report Settings</h3>
           </div>
           <button onClick={() => setSettingsModalOpen(false)}>×</button>
         </div>
         <div style={{ display: 'flex', flexDirection: 'column', gap: 10, margin: '14px 0', fontSize: 13 }}>
           <div><small style={{ color: '#64748b' }}>Name:</small> <b style={{ display: 'block' }}>{report.name}</b></div>
           <div><small style={{ color: '#64748b' }}>Published At:</small> <span style={{ display: 'block' }}>{new Date(item.published_at || item.updated_at).toLocaleString()}</span></div>
           <div><small style={{ color: '#64748b' }}>Pages Count:</small> <span style={{ display: 'block' }}>{pages.length} page{pages.length === 1 ? '' : 's'}</span></div>
           <div><small style={{ color: '#64748b' }}>Access Role:</small> <span style={{ display: 'block', fontWeight: 600, color: '#166534' }}>{effectiveRole || 'Viewer'}</span></div>
         </div>
         <div className="dialogActions">
           <span className="dialogSpacer" />
           <button className="primary" onClick={() => setSettingsModalOpen(false)}>Close</button>
         </div>
       </div>
     </div>
   )}
   {automationMode&&<ReportAutomationDialog mode={automationMode} reportId={reportId} reportName={report.name} project={project} pageId={page?.id} filters={combinedFilters} workspaceId={item?.workspace_id} onClose={()=>setAutomationMode(null)}/>}
 </div>
}
