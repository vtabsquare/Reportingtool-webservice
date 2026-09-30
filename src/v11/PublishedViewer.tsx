import{useEffect,useMemo,useRef,useState}from'react';
import{createPortal}from'react-dom';
import{ChevronLeft,ChevronRight,RefreshCcw,Maximize2,Minimize2,Home,CalendarDays,ShieldCheck,MonitorUp,Expand,Scaling,Eraser,BarChart3,PieChart,Table2,LayoutGrid,Filter,TrendingUp,MousePointerClick,FileDown,Presentation,Mail,FileText}from'lucide-react';
import Chart from'../components/Chart';
import PaginatedReportViewer from'./PaginatedReportViewer';
import{api,apiDownload,apiDownloadPost}from'../api';
import{richTextHtml}from'../richText';
import{resolveActionButtonLabel,resolveActionCommands,visualIsHidden}from'../buttonActions';
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
    .select('id,name,published_at,updated_at,project_json')
    .eq('id',reportId)
    .single();
  if(error)throw error;

  // Supabase RLS is the single source of truth. If this row was returned, the
  // signed-in owner, direct grantee, workspace member, or service account is
  // authorized. A second client-side grants check would incorrectly reject
  // workspace access that is valid under RLS.
  return{...data,project:parseProjectJson(data.project_json)};
}

type VisualQueryResult={rows:any[];error?:string};
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
    const failed=visuals.filter(node=>node.dataset.exportState==='error');
    if(failed.length){const names=failed.map(node=>node.dataset.visualTitle||'Visual').join(', ');throw new Error(`Cannot export ${pageName} because these visuals did not load: ${names}. Refresh the report and try again.`)}
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
   useCORS:true,
   allowTaint:false,
   logging:false,
   imageTimeout:8000,
   removeContainer:true,
   onclone:documentClone=>{
     const clone=documentClone.querySelector<HTMLElement>('.viewerPage');if(!clone)return;
     clone.style.transform='none';clone.style.transformOrigin='top left';clone.style.margin='0';clone.style.boxShadow='none';clone.style.borderRadius='0';clone.style.width=`${width}px`;clone.style.height=`${height}px`;
     makeCloneColorsCanvasSafe(documentClone,clone);
     for(const image of Array.from(clone.querySelectorAll<HTMLImageElement>('img'))){image.crossOrigin='anonymous';image.referrerPolicy='no-referrer'}
   }
 });
 return canvas.toDataURL('image/png');
}
function ViewerVisual({v,result,loading,onCrossFilter,onAction}:{v:Visual,result?:VisualQueryResult,loading:boolean,onCrossFilter:(f:VisualFilter|null)=>void,onAction:(v:Visual)=>void}){
 const rows=result?.rows||[],err=result?.error||'';
 const[focus,setFocus]=useState(false),[slicerSelected,setSlicerSelected]=useState<string[]>([]),[slicerSearch,setSlicerSearch]=useState('');
 useEffect(()=>{const reset=()=>{setSlicerSelected([]);setSlicerSearch('')};window.addEventListener('vtab-reset-state',reset);return()=>window.removeEventListener('vtab-reset-state',reset)},[]);
 const f:any=v.format||{};const bg=f.background||'#fff';const dark=/^#0|^#1/.test(bg.toLowerCase());const accent=f.accent||({kpi:'#2563eb',card:'#16a34a',bar:'#2563eb',column:'#0ea5e9',line:'#16a34a',area:'#10b981',pie:'#f59e0b',donut:'#8b5cf6',gauge:'#16a34a',table:'#2563eb',matrix:'#4f46e5',slicer:'#e11d48'} as any)[v.type]||'#2563eb';
 const transparency=f.backgroundEnabled===false?100:Math.max(0,Math.min(100,f.backgroundTransparency||0));
 const edges=f.borderEdges||{top:true,right:true,bottom:true,left:true};
 const border=f.borderVisible?`${f.borderWidth??1}px ${f.borderStyle||'solid'} ${f.borderColor||'#c8c8c8'}`:'0';
 const radius=`${f.cornerRadii?.topLeft??f.cornerRadius??0}px ${f.cornerRadii?.topRight??f.cornerRadius??0}px ${f.cornerRadii?.bottomRight??f.cornerRadius??0}px ${f.cornerRadii?.bottomLeft??f.cornerRadius??0}px`;
 const background=`color-mix(in srgb, ${bg} ${100-transparency}%, transparent)`;
 const shadow=f.shadow?`0 ${f.shadowOffset??12}px 32px color-mix(in srgb, ${f.shadowColor||'#0f172a'} 16%, transparent)`:'none';
 const content=v.type==='textbox'?<div className="viewerTextBox" style={{fontSize:f.fontSize||18,color:f.labelColor||'#111827',fontFamily:f.fontFamily||'inherit',fontWeight:f.textFontWeight||400,fontStyle:f.textItalic?'italic':'normal',textDecoration:f.textUnderline?'underline':'none',textAlign:f.textAlign||'left',lineHeight:f.textLineHeight||1.45,whiteSpace:f.textWrap===false?'nowrap':'pre-wrap',overflowWrap:f.textWrap===false?'normal':'anywhere',display:'flex',flexDirection:'column',justifyContent:f.textVerticalAlign==='bottom'?'flex-end':f.textVerticalAlign==='middle'?'center':'flex-start'}} dangerouslySetInnerHTML={{__html:richTextHtml(v.richText,v.text)}}/>:v.type==='button'?<div className="viewerActionButtonWrap"><button className="viewerActionButton" style={{background:f.buttonBackground||accent,color:f.buttonTextColor||'#fff',fontSize:f.buttonFontSize||12,borderRadius:f.buttonCornerRadius??6,border:f.buttonBorderVisible?`1px solid ${f.buttonBorderColor||'#1d4ed8'}`:'none'}} onClick={()=>onAction(v)}><MousePointerClick size={16}/>{v.buttonLabel||'Action'}</button></div>:v.type==='slicer'?(()=>{
   const field=v.bindings.axis?.[0]||'',mode=v.slicerStyle||'list';
   const options=rows.map(r=>String(r[field]??'')).filter((x,i,a)=>x&&a.indexOf(x)===i).filter(x=>!slicerSearch||x.toLowerCase().includes(slicerSearch.toLowerCase()));
   const apply=(next:string[])=>{setSlicerSelected(next);onCrossFilter(!next.length?null:{field,operator:next.length===1?'equals':'in',value:next.length===1?next[0]:next})};
   const choose=(value:string)=>apply(f.slicerSingleSelect?[value]:slicerSelected.includes(value)?slicerSelected.filter(x=>x!==value):[...slicerSelected,value]);
   return <div className="viewerSlicerContents">{mode!=='dropdown'&&f.slicerSearch!==false&&<input className="slicerDropdown viewerSlicerSearch" aria-label="Search slicer values" placeholder="Search" value={slicerSearch} onChange={e=>setSlicerSearch(e.target.value)}/>} {mode==='dropdown'?<select aria-label={v.title||field||'Report filter'} className="slicerDropdown viewerSlicerDropdown" value={slicerSelected[0]||''} onChange={e=>apply(e.target.value?[e.target.value]:[])}><option value="">All</option>{options.map(value=><option key={value} value={value}>{value}</option>)}</select>:<div className={'slicerList slicer-'+mode+' orientation-'+(f.slicerOrientation||'vertical')}>{f.slicerSelectAll&&<button className={slicerSelected.length===options.length?'active':''} onClick={()=>apply(slicerSelected.length===options.length?[]:options)}>Select all</button>}{options.map(value=><button key={value} className={slicerSelected.includes(value)?'active':''} style={{color:f.tableTextColor,fontSize:f.tableFontSize}} onClick={()=>choose(value)}>{value}</button>)}</div>}</div>
 })():<Chart visual={v} rows={rows} onPointClick={(field,value)=>onCrossFilter({field,operator:'equals',value})}/>;
 const narrative=visualExportNarrative(v,rows);
 const card=<div className={`viewerVisual viewerVisual-${v.type}`} data-export-state={loading?'loading':err?'error':'ready'} data-visual-title={v.title||v.type} data-export-narrative={JSON.stringify(narrative)} data-export-insights={JSON.stringify(narrative.points)} style={{background,border:'0',borderTop:edges.top?border:'0',borderRight:edges.right?border:'0',borderBottom:edges.bottom?border:'0',borderLeft:edges.left?border:'0',borderRadius:radius,boxShadow:shadow,fontFamily:f.fontFamily||'Segoe UI','--viewer-accent':accent,'--published-background':background,'--published-border-top':edges.top?border:'0','--published-border-right':edges.right?border:'0','--published-border-bottom':edges.bottom?border:'0','--published-border-left':edges.left?border:'0','--published-radius':radius,'--published-shadow':shadow,'--published-title-color':f.titleColor||(dark?'#fff':'#111827'),'--published-title-size':`${f.titleFontSize||14}px`,'--published-title-weight':f.titleFontWeight||700,'--published-callout-size':`${f.fontSize||28}px`,'--published-pad-top':`${f.paddingTop??f.padding??8}px`,'--published-pad-right':`${f.paddingRight??f.padding??8}px`,'--published-pad-bottom':`${f.paddingBottom??f.padding??8}px`,'--published-pad-left':`${f.paddingLeft??f.padding??8}px`} as any}>
   {f.showTitle!==false&&<div className="viewerVisualTitle" style={{color:f.titleColor||(dark?'#fff':'#111827'),fontSize:f.titleFontSize||14,fontWeight:f.titleFontWeight||700,fontStyle:f.titleFontStyle||'normal',textDecoration:f.titleUnderline?'underline':'none',whiteSpace:f.titleWrap===false?'nowrap':'normal'}}><div className="viewerVisualTitleLabel"><div style={{textAlign:f.titleAlignment||'left'}}><span>{v.title}</span>{f.subtitleVisible&&f.subtitle&&<small style={{color:f.subtitleColor,fontSize:f.subtitleFontSize,fontWeight:f.subtitleFontWeight,fontStyle:f.subtitleFontStyle,textDecoration:f.subtitleUnderline?'underline':'none',textAlign:f.subtitleAlignment||f.titleAlignment||'left',whiteSpace:f.subtitleWrap===false?'nowrap':'normal'}}>{f.subtitle}</small>}</div></div>{f.visualHeader!==false&&<button className="viewerVisualFocus" onClick={()=>setFocus(true)} title="Focus visual"><Maximize2 size={14}/></button>}</div>}
   <div className="viewerVisualBody" style={{paddingTop:f.paddingTop??f.padding??8,paddingRight:f.paddingRight??f.padding??8,paddingBottom:f.paddingBottom??f.padding??8,paddingLeft:f.paddingLeft??f.padding??8}}>{loading?<div className="viewerVisualLoading" role="status"><span className="viewerSpinner"/><b>Loading visual data…</b></div>:err?<div className="viewerError">{err}</div>:content}</div>
 </div>;
 return <>{card}{focus&&createPortal(<div className="visualFocusBackdrop" onMouseDown={()=>setFocus(false)}><div className="visualFocusPanel viewerFocusPanel" onMouseDown={e=>e.stopPropagation()}><div className="visualFocusHeader"><div><small>FOCUS MODE</small><b>{v.title}</b></div><button onClick={()=>setFocus(false)}>Close</button></div><div className="visualFocusBody">{content}</div></div></div>,document.body)}</>
}
export default function PublishedViewer({reportId,initialItem,embedded=false,cloudMode=false,initialPaginatedId}:{reportId:string,initialItem?:any,embedded?:boolean,cloudMode?:boolean,initialPaginatedId?:string}){
 const[item,setItem]=useState<any>((initialItem && initialItem.project)?initialItem:null),[error,setError]=useState(''),[pageIndex,setPageIndex]=useState(0),[full,setFull]=useState(!embedded),[viewMode,setViewMode]=useState<'fitWidth'|'fitPage'|'actual'>('fitPage'),[scale,setScale]=useState(1),[interactionFilters,setInteractionFilters]=useState<VisualFilter[]>([]),[runtimeHidden,setRuntimeHidden]=useState<Record<string,boolean>>({}),[authRequired,setAuthRequired]=useState(false),[signedIn,setSignedIn]=useState(true),[login,setLogin]=useState({email:'',password:''}),[exporting,setExporting]=useState<''|'pdf'|'pptx'>(''),[visualResults,setVisualResults]=useState<Record<string,VisualQueryResult>>({}),[visualLoading,setVisualLoading]=useState(false),[visualLoadError,setVisualLoadError]=useState(''),[visualReloadKey,setVisualReloadKey]=useState(0);
 const[publishedMode,setPublishedMode]=useState<'interactive'|'paginated'>(initialPaginatedId?'paginated':'interactive');
 const stageRef=useRef<HTMLElement|null>(null);
 const actionPageHistoryRef=useRef<number[]>([]),runtimeVisibilityDefaultsRef=useRef<Record<string,boolean>>({});
 const load=()=>{
  if(initialItem && initialItem.project){setItem(initialItem);setError('');return;}
  if(WORKSPACE_ONLY){
   fetchReportFromSupabase(reportId).then(x=>{setItem(x);setError('')}).catch(e=>setError(e.message||String(e)));
   return;
  }
  api<any>(`/published/${reportId}`).then(x=>{setItem(x);setError('')}).catch(e=>setError(e.message||String(e)))
 };
 useEffect(()=>{
  if(initialItem && initialItem.project){setItem(initialItem);setError('');return;}
  if(WORKSPACE_ONLY){load();return;}
  api<any>('/auth/status').then(s=>{setAuthRequired(!!s.required);if(s.required){api('/auth/me').then(()=>{setSignedIn(true);load()}).catch(()=>setSignedIn(false))}else load()})
 },[reportId,initialItem?.id]);
 const project=item?.project,report=project?.report,pages=report?.pages||[],page=pages[pageIndex]||pages[0],s=page?.settings||{},paginatedReports=project?.paginatedReports||[];
 const visibleVisuals=useMemo<Visual[]>(()=>page?.visuals?.filter((v:Visual)=>v.visible!==false&&!v.hidden&&!runtimeHidden[v.id])||[],[page,runtimeHidden]);
 const queryVisualIds=useMemo(()=>visibleVisuals.filter(v=>!['textbox','button'].includes(v.type)).map(v=>v.id),[visibleVisuals]);
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
 const effectiveHeight=pixelLayout?height:Math.max(height,contentHeight);
 useEffect(()=>{
   if(!item||!page)return;
   const stage=stageRef.current;if(!stage)return;
   const compute=()=>{
     const rect=stage.getBoundingClientRect();
     const availW=Math.max(320,rect.width-12),availH=Math.max(320,rect.height-12);
     let next=1;
     // Match Power BI's page-view behavior: fit modes may reduce a report to
     // fit the viewport, but must not enlarge it beyond its authored pixels.
     if(viewMode==='fitWidth')next=Math.min(1,availW/width);
     else if(viewMode==='fitPage')next=Math.min(1,availW/width,availH/effectiveHeight);
     else next=1;
     setScale(Math.max(.1,next));
   };
   compute();const ro=new ResizeObserver(compute);ro.observe(stage);window.addEventListener('resize',compute);return()=>{ro.disconnect();window.removeEventListener('resize',compute)};
 },[width,effectiveHeight,viewMode,full,item?.id,page?.id]);
 useEffect(()=>{const stage=stageRef.current;if(stage)stage.scrollTo({top:0,left:0,behavior:'instant' as ScrollBehavior})},[pageIndex,viewMode,full,item?.id]);
 useEffect(()=>{for(const reportPage of pages)for(const visual of reportPage.visuals||[])if(Object.prototype.hasOwnProperty.call(runtimeVisibilityDefaultsRef.current,visual.id))visual.hidden=runtimeVisibilityDefaultsRef.current[visual.id];setRuntimeHidden({});setInteractionFilters([])},[page?.id]);
 const doLogin=async()=>{try{const r=await api<any>('/auth/login',{method:'POST',body:JSON.stringify(login)});localStorage.setItem('vtab_workspace_token',r.token);setSignedIn(true);load()}catch(e:any){alert(e.message)}};
 if(authRequired&&!signedIn)return <div className="workspaceLogin"><div className="workspaceLoginCard"><div className="brandMark">V</div><h2>Sign in to VTAB Workspace</h2><p>This published report requires a workspace account.</p><input placeholder="Email" value={login.email} onChange={e=>setLogin({...login,email:e.target.value})}/><input type="password" placeholder="Password" value={login.password} onChange={e=>setLogin({...login,password:e.target.value})}/><button className="primary" onClick={doLogin}>Sign In</button></div></div>;
 if(error)return <div className="viewerLoading"><b>Published report could not be opened</b><span>{error}</span><button onClick={()=>location.href='/?workspace=1'}>Open Workspace</button></div>;
 if(!item)return <div className="viewerLoading">Opening published report…</div>;
 if(!page)return <div className="viewerLoading">This published report has no pages.</div>;
 const exportFile=async(fmt:'pdf'|'pptx')=>{
  if(exporting)return;const originalPage=pageIndex;setExporting(fmt);
  try{
   const rendered=[] as Array<{name:string,image:string,insights:string[],narratives:ExportNarrative[]}>;
   for(let index=0;index<pages.length;index++){
    const pageDefinition=pages[index],pageSettings=pageDefinition.settings||{},pageWidth=pageSettings.pageWidth||1600,pageHeight=pageSettings.pageHeight||900;
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
 return <div className={'publishedViewer '+(full?'viewerFull':'')}>
  <header className="viewerTopbar"><div className="viewerBrand"><span>V</span><div><b>VTAB Workspace</b><small>Published Analytics</small></div></div><div className="viewerReportName"><small>PUBLISHED REPORT</small><b>{report.name}</b></div><div className="viewerActions"><span><ShieldCheck size={14}/>Governed</span><span><CalendarDays size={14}/>{new Date(item.updated_at||item.published_at).toLocaleString()}</span>{paginatedReports.length>0&&project.paginatedPublishMode!=='separate'&&<div className="publishedContentSwitch" aria-label="Published content"><button className={publishedMode==='interactive'?'active':''} onClick={()=>setPublishedMode('interactive')}><BarChart3 size={15}/>Dashboard</button><button className={publishedMode==='paginated'?'active':''} onClick={()=>setPublishedMode('paginated')}><FileText size={15}/>Paginated report</button></div>}{interactionFilters.length>0&&<button onClick={()=>setInteractionFilters([])}><Eraser size={15}/>Clear Selection</button>}<button onClick={load}><RefreshCcw size={15}/>Refresh</button><button disabled={!!exporting} onClick={()=>exportFile('pdf')}><FileDown size={15}/>{exporting==='pdf'?'Preparing…':'PDF'}</button><button disabled={!!exporting} onClick={()=>exportFile('pptx')}><Presentation size={15}/>{exporting==='pptx'?'Preparing…':'PPT'}</button><button onClick={shareEmail}><Mail size={15}/>Share</button><div className="viewerViewModes"><button className={viewMode==='fitPage'?'active':''} onClick={()=>setViewMode('fitPage')} title="Show the complete report page"><Scaling size={15}/>Full Report</button><button className={viewMode==='fitWidth'?'active':''} onClick={()=>setViewMode('fitWidth')} title="Fit report to browser width"><MonitorUp size={15}/>Fit Width</button><button className={viewMode==='actual'?'active':''} onClick={()=>setViewMode('actual')} title="Use report design size"><Expand size={15}/>Actual</button></div><button onClick={()=>setFull(x=>!x)}>{full?<Minimize2 size={15}/>:<Maximize2 size={15}/>}{full?'Exit Full Screen':'Full Screen'}</button><button onClick={()=>location.href='/?workspace=1'}><Home size={15}/>Workspace</button></div></header>
  {publishedMode==='paginated'?<PaginatedReportViewer reportId={reportId} project={project} filters={combinedFilters} cloudMode={cloudMode||WORKSPACE_ONLY} initialDefinitionId={initialPaginatedId}/>:<><main className="viewerStage" ref={stageRef}>
   {(visualLoading||visualLoadError)&&<div className={'viewerPageLoadNotice '+(visualLoadError?'error':'')} role="status">{visualLoading?<><span className="viewerSpinner"/><b>Preparing {queryVisualIds.length} visual{queryVisualIds.length===1?'':'s'}…</b><span>The report will appear as soon as the page data is ready.</span></>:<><b>Page data could not be loaded.</b><span>{visualLoadError}</span><button onClick={()=>setVisualReloadKey(key=>key+1)}>Try again</button></>}</div>}
   <div className="viewerScaleFrame" style={{width:width*scale,height:effectiveHeight*scale}}>
   <div className={'viewerPage '+(pixelLayout?'pixelPublishedPage':'legacyPublishedPage')} data-page-id={String(page.id||'')} style={{width,height:effectiveHeight,background:s.background||'#f5f7fb',transform:`scale(${scale})`}}>
    {s.backgroundImage&&<div className="viewerPageBg" style={{backgroundImage:`url(${s.backgroundImage})`,backgroundSize:s.backgroundImageFit||'cover',opacity:(s.backgroundImageOpacity??24)/100}}/>}
    <div className="viewerPageLayer">
     {s.header?.visible!==false&&<div className="viewerDashboardHeader" style={{background:s.header?.background||'#fff','--viewer-header-bg':s.header?.background||'#fff','--viewer-header-height':`${s.header?.height||84}px`,'--viewer-header-pad-top':`${s.header?.paddingTop??12}px`,'--viewer-header-pad-bottom':`${s.header?.paddingBottom??12}px`,'--viewer-header-pad-left':`${s.header?.paddingLeft??24}px`,'--viewer-header-pad-right':`${s.header?.paddingRight??24}px`,'--viewer-header-radius':`${s.header?.borderRadius??14}px`,'--viewer-header-title-size':`${s.header?.fontSize||28}px`,'--viewer-header-title-color':s.header?.titleColor||'#111827','--viewer-header-subtitle-size':`${s.header?.subtitleFontSize||12}px`,'--viewer-header-subtitle-color':s.header?.subtitleColor||'#475569'} as any}><div className="viewerDashboardHeaderCopy" style={{textAlign:s.header?.alignment||'left'}}><h1 style={{color:s.header?.titleColor||'#111827'}}>{s.header?.title||''}</h1><p style={{color:s.header?.subtitleColor||'#475569'}}>{s.header?.subtitle||''}</p></div>{s.header?.showGeneratedInfo!==false&&<div className="viewerReportMeta" style={{background:s.header?.generatedInfoBackground||'#f8fbff'}}><CalendarDays size={20}/><div><small>REPORT GENERATED</small><b>{new Date(item.updated_at||item.published_at).toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'})}</b><span>{new Date(item.updated_at||item.published_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</span></div></div>}</div>}
     <div className={'viewerGrid '+(pixelLayout?'pixelLayout':'legacyLayout')}>{visibleVisuals.map((v:Visual,index:number)=><div key={v.id} style={v.geometryVersion===2?{position:'absolute',left:v.x,top:v.y,width:v.w,height:v.h,zIndex:v.zIndex??index,transform:`rotate(${v.rotation||0}deg)`,transformOrigin:'center'}:{gridColumn:`${v.x+1} / span ${v.w}`,gridRow:`${v.y+1} / span ${v.h}`}}><ViewerVisual v={v} result={visualResults[v.id]||(visualLoadError?{rows:[],error:visualLoadError}:undefined)} loading={!['textbox','button'].includes(v.type)&&visualLoading} onCrossFilter={f=>setInteractionFilters(f?[f]:[])} onAction={executeAction}/></div>)}{visibleVisuals.length===0&&<div className="viewerEmptyPage"><b>No visible visuals on this published page</b><span>Open this page in Report Designer, verify visual visibility, save the report, and publish again.</span></div>}</div>
    </div>
   </div>
   </div>
  </main>
  <footer className="viewerFooter"><button onClick={()=>setPageIndex(i=>Math.max(0,i-1))} disabled={pageIndex===0}><ChevronLeft size={15}/>Previous</button><div className="viewerPages">{pages.map((p:any,i:number)=><button key={p.id} className={i===pageIndex?'active':''} onClick={()=>setPageIndex(i)}>{p.name}</button>)}</div><span>Page {pageIndex+1} of {pages.length}</span><button onClick={()=>setPageIndex(i=>Math.min(pages.length-1,i+1))} disabled={pageIndex===pages.length-1}>Next<ChevronRight size={15}/></button></footer></>}
 </div>
}
