import {useEffect,useRef,useState,useCallback} from 'react';
import type {MouseEvent as ReactMouseEvent,SyntheticEvent} from 'react';
import {createPortal} from 'react-dom';
import {
  Plus,Trash2,Copy,Filter,BarChart3,LineChart,Table2,Gauge,PanelRight,Type,Palette,Hash,Settings2,
  Layers3,Sparkles,ChevronLeft,ChevronRight,ChevronDown,Eraser,Heading1,PaintBucket,ArrowUpDown,SlidersHorizontal,Image as ImageIcon,Upload,RotateCcw,MoreHorizontal,Download,ArrowUpAZ,ArrowDownAZ,PanelLeftClose,PanelLeftOpen,PanelRightClose,PanelRightOpen,Move,Maximize2,GitBranch,ArrowDownCircle,ArrowUpCircle,ArrowDown,ChevronsDown,MessageSquareText,Eye,FileJson,FileSpreadsheet,Clipboard,LayoutDashboard,TextCursorInput,MousePointerClick,Navigation,EyeOff,CalendarDays,GripVertical,X,Info,Search,MapPinned,LocateFixed
} from 'lucide-react';
import Chart from '../components/Chart';
import FormattingWorkspace from '../components/FormattingWorkspace';
import CanvasObjectInteractionManager from '../components/CanvasObjectInteractionManager';
import {useStudio} from '../store';
import {api} from '../api';
import {CURRENCIES,DEFAULT_NUMBER_FORMAT} from '../formatting';
import {extractRichTextRuns,richTextHtml,sanitizeRichText} from '../richText';
import {resolveActionButtonLabel,resolveActionCommands} from '../buttonActions';
import {createPaginatedReport,ensurePaginatedReports} from '../paginated';
import {resolveConditionalFormat} from '../conditionalFormatting';
import {removeReportPage} from '../pageManagement';
import {parseSpatialFile} from '../mapSpatial';
import {inferMapRole} from '../mapGeography';
import type {NumberFormat,Page,PageSettings,Visual,VisualActionStep,VisualFilter,VisualFormat,VisualType} from '../types';

const visualTypes:VisualType[]=['textbox','image','shape','button','kpi','card','multirowcard','bar','column','stackedbar','stackedcolumn','line','area','combo','pie','donut','treemap','funnel','waterfall','scatter','bubble','radar','heatmap','histogram','boxplot','gauge','progress','map','table','matrix','slicer'];
const visualLabels:Record<string,string>={
 kpi:'KPI',card:'Card',multirowcard:'Multi Card',bar:'Bar',column:'Column',stackedbar:'Stacked Bar',
 stackedcolumn:'Stacked Col',line:'Line',area:'Area',combo:'Combo',pie:'Pie',donut:'Donut',
 treemap:'Treemap',funnel:'Funnel',waterfall:'Waterfall',scatter:'Scatter',bubble:'Bubble',
 radar:'Radar',heatmap:'Heatmap',histogram:'Histogram',boxplot:'Box Plot',gauge:'Gauge',
 progress:'Progress',map:'Map',table:'Table',matrix:'Matrix',slicer:'Slicer',textbox:'Text Box',button:'Button',image:'Image',shape:'Shape'
};
const visualColor:Record<string,string>={
 kpi:'#f59e0b',card:'#fb7185',multirowcard:'#f472b6',bar:'#38bdf8',column:'#22d3ee',stackedbar:'#0ea5e9',
 stackedcolumn:'#06b6d4',line:'#34d399',area:'#10b981',combo:'#a78bfa',pie:'#f97316',donut:'#fb923c',
 treemap:'#84cc16',funnel:'#eab308',waterfall:'#14b8a6',scatter:'#8b5cf6',bubble:'#c084fc',
 radar:'#6366f1',heatmap:'#ef4444',histogram:'#64748b',boxplot:'#94a3b8',gauge:'#22c55e',
 progress:'#2dd4bf',map:'#0ea5e9',table:'#60a5fa',matrix:'#818cf8',slicer:'#f43f5e',textbox:'#334155',button:'#2563eb',image:'#0ea5e9',shape:'#7c3aed'
};

const COMMON_FORMAT_PAINTER_KEYS:Array<keyof VisualFormat>=[
  'accent','fontSize','showTitle','background','fontFamily','titleFontSize','titleColor','titleFontWeight','titleAlignment','titleFontStyle','titleUnderline','titleWrap',
  'subtitle','subtitleVisible','subtitleColor','subtitleFontSize','subtitleFontWeight','subtitleAlignment','subtitleFontStyle','subtitleUnderline','subtitleWrap',
  'labelFontSize','labelColor','borderVisible','borderColor','borderWidth','borderStyle','borderEdges','cornerRadius','cornerRadii','cornerLinked','shadow','shadowColor','shadowOffset',
  'backgroundTransparency','padding','paddingTop','paddingRight','paddingBottom','paddingLeft','responsive','visualHeader'
];


type VisualWellKey='axis'|'values'|'target'|'tooltips'|'legend'|'x'|'size'|'min'|'max'|'location'|'latitude'|'longitude'|'geometry'|'detail'|'color'|'label'|'path'|'country'|'region'|'postalCode';
type VisualProfile={w:number,h:number,wells:Array<{key:VisualWellKey,title:string,accept:'field'|'measure'|'value'}>,dataLabels?:boolean,legend?:boolean,axes?:boolean,tooltips?:boolean,numberFormat?:boolean,dataColor?:boolean};
const VISUAL_PROFILES:Record<VisualType,VisualProfile>={
  textbox:{w:6,h:3,wells:[]},button:{w:3,h:2,wells:[]},image:{w:4,h:4,wells:[]},shape:{w:3,h:3,wells:[]},
  kpi:{w:3,h:3,wells:[{key:'axis',title:'Trend / Category',accept:'field'},{key:'values',title:'Value',accept:'value'},{key:'target',title:'Comparison / Target',accept:'value'},{key:'tooltips',title:'Tooltips',accept:'value'}],tooltips:true,numberFormat:true,dataColor:true},
  card:{w:3,h:3,wells:[{key:'values',title:'Values',accept:'value'},{key:'target',title:'Comparison / Reference label',accept:'value'}],numberFormat:true,dataColor:true},
  multirowcard:{w:6,h:4,wells:[{key:'values',title:'Values',accept:'value'}],numberFormat:true,dataColor:true},
  progress:{w:4,h:3,wells:[{key:'values',title:'Value',accept:'value'},{key:'min',title:'Minimum value',accept:'value'},{key:'max',title:'Maximum value',accept:'value'},{key:'target',title:'Target value',accept:'value'},{key:'tooltips',title:'Tooltips',accept:'value'}],numberFormat:true,dataColor:true,tooltips:true},
  gauge:{w:4,h:4,wells:[{key:'values',title:'Value',accept:'value'},{key:'min',title:'Minimum value',accept:'value'},{key:'max',title:'Maximum value',accept:'value'},{key:'target',title:'Target value',accept:'value'},{key:'tooltips',title:'Tooltips',accept:'value'}],numberFormat:true,dataColor:true,tooltips:true},
  slicer:{w:3,h:5,wells:[{key:'axis',title:'Field',accept:'field'}]},
  map:{w:7,h:6,wells:[{key:'location',title:'Location',accept:'field'},{key:'latitude',title:'Latitude',accept:'field'},{key:'longitude',title:'Longitude',accept:'field'},{key:'detail',title:'Detail / value',accept:'value'},{key:'size',title:'Bubble size',accept:'value'},{key:'tooltips',title:'Tooltips',accept:'value'}],legend:true,tooltips:true,numberFormat:true,dataColor:true},
  table:{w:8,h:6,wells:[{key:'axis',title:'Columns / Categories',accept:'field'},{key:'values',title:'Values',accept:'value'},{key:'tooltips',title:'Additional values',accept:'value'}],numberFormat:true},
  matrix:{w:9,h:6,wells:[{key:'axis',title:'Rows',accept:'field'},{key:'legend',title:'Columns / Series',accept:'field'},{key:'values',title:'Values',accept:'value'}],numberFormat:true},
  pie:{w:5,h:5,wells:[{key:'axis',title:'Legend / Category',accept:'field'},{key:'values',title:'Values',accept:'value'},{key:'tooltips',title:'Tooltips',accept:'value'}],dataLabels:true,legend:true,tooltips:true,numberFormat:true,dataColor:true},
  donut:{w:5,h:5,wells:[{key:'axis',title:'Legend / Category',accept:'field'},{key:'values',title:'Values',accept:'value'},{key:'tooltips',title:'Tooltips',accept:'value'}],dataLabels:true,legend:true,tooltips:true,numberFormat:true,dataColor:true},
  treemap:{w:6,h:5,wells:[{key:'axis',title:'Group / Category',accept:'field'},{key:'values',title:'Values',accept:'value'},{key:'tooltips',title:'Tooltips',accept:'value'}],dataLabels:true,tooltips:true,numberFormat:true,dataColor:true},
  funnel:{w:5,h:5,wells:[{key:'axis',title:'Stage / Category',accept:'field'},{key:'values',title:'Values',accept:'value'},{key:'tooltips',title:'Tooltips',accept:'value'}],dataLabels:true,tooltips:true,numberFormat:true,dataColor:true},
  waterfall:{w:6,h:5,wells:[{key:'axis',title:'Category',accept:'field'},{key:'legend',title:'Breakdown',accept:'field'},{key:'values',title:'Y-axis',accept:'value'},{key:'tooltips',title:'Tooltips',accept:'value'}],dataLabels:true,axes:true,legend:true,tooltips:true,numberFormat:true,dataColor:true},
  histogram:{w:6,h:5,wells:[{key:'axis',title:'Values',accept:'field'},{key:'values',title:'Frequency',accept:'value'}],dataLabels:true,axes:true,numberFormat:true,dataColor:true},
  boxplot:{w:6,h:5,wells:[{key:'axis',title:'Category',accept:'field'},{key:'values',title:'Numeric field',accept:'value'}],axes:true,numberFormat:true,dataColor:true},
  scatter:{w:6,h:5,wells:[{key:'axis',title:'Values',accept:'field'},{key:'x',title:'X Axis',accept:'value'},{key:'values',title:'Y Axis',accept:'value'},{key:'legend',title:'Legend',accept:'field'},{key:'size',title:'Size',accept:'value'},{key:'tooltips',title:'Tooltips',accept:'value'}],dataLabels:true,axes:true,legend:true,tooltips:true,numberFormat:true,dataColor:true},
  bubble:{w:6,h:5,wells:[{key:'axis',title:'Category / X',accept:'field'},{key:'values',title:'Y Value',accept:'value'},{key:'tooltips',title:'Tooltips',accept:'value'}],dataLabels:true,axes:true,tooltips:true,numberFormat:true,dataColor:true},
  heatmap:{w:6,h:5,wells:[{key:'axis',title:'Columns',accept:'field'},{key:'legend',title:'Rows',accept:'field'},{key:'values',title:'Values',accept:'value'}],axes:true,legend:true,numberFormat:true,dataColor:true},
  radar:{w:6,h:5,wells:[{key:'axis',title:'Category',accept:'field'},{key:'values',title:'Values',accept:'value'}],legend:true,numberFormat:true,dataColor:true},
  combo:{w:7,h:5,wells:[{key:'axis',title:'X Axis',accept:'field'},{key:'values',title:'Values',accept:'value'},{key:'target',title:'Secondary value',accept:'value'},{key:'legend',title:'Legend / Series',accept:'field'},{key:'tooltips',title:'Tooltips',accept:'value'}],dataLabels:true,legend:true,axes:true,tooltips:true,numberFormat:true,dataColor:true},
  bar:{w:6,h:5,wells:[{key:'axis',title:'Y Axis / Category',accept:'field'},{key:'values',title:'X Axis / Values',accept:'value'},{key:'legend',title:'Legend / Series',accept:'field'},{key:'tooltips',title:'Tooltips',accept:'value'}],dataLabels:true,legend:true,axes:true,tooltips:true,numberFormat:true,dataColor:true},
  stackedbar:{w:6,h:5,wells:[{key:'axis',title:'Y Axis / Category',accept:'field'},{key:'values',title:'X Axis / Values',accept:'value'},{key:'legend',title:'Legend / Stack',accept:'field'},{key:'tooltips',title:'Tooltips',accept:'value'}],dataLabels:true,legend:true,axes:true,tooltips:true,numberFormat:true,dataColor:true},
  column:{w:6,h:5,wells:[{key:'axis',title:'X Axis / Category',accept:'field'},{key:'values',title:'Y Axis / Values',accept:'value'},{key:'legend',title:'Legend / Series',accept:'field'},{key:'tooltips',title:'Tooltips',accept:'value'}],dataLabels:true,legend:true,axes:true,tooltips:true,numberFormat:true,dataColor:true},
  stackedcolumn:{w:6,h:5,wells:[{key:'axis',title:'X Axis / Category',accept:'field'},{key:'values',title:'Y Axis / Values',accept:'value'},{key:'legend',title:'Legend / Stack',accept:'field'},{key:'tooltips',title:'Tooltips',accept:'value'}],dataLabels:true,legend:true,axes:true,tooltips:true,numberFormat:true,dataColor:true},
  line:{w:7,h:5,wells:[{key:'axis',title:'X Axis / Time',accept:'field'},{key:'values',title:'Y Axis / Values',accept:'value'},{key:'legend',title:'Legend / Series',accept:'field'},{key:'tooltips',title:'Tooltips',accept:'value'}],dataLabels:true,legend:true,axes:true,tooltips:true,numberFormat:true,dataColor:true},
  area:{w:7,h:5,wells:[{key:'axis',title:'X Axis / Time',accept:'field'},{key:'values',title:'Y Axis / Values',accept:'value'},{key:'legend',title:'Legend / Series',accept:'field'},{key:'tooltips',title:'Tooltips',accept:'value'}],dataLabels:true,legend:true,axes:true,tooltips:true,numberFormat:true,dataColor:true}
};
const visualProfile=(type:VisualType)=>VISUAL_PROFILES[type];
const categoryScrollTypes=new Set<VisualType>(['bar','column','stackedbar','stackedcolumn','line','area','combo','waterfall']);
function sanitizeBindingsForType(type:VisualType,bindings:Visual['bindings']){
  const allowed=new Set(visualProfile(type).wells.map(x=>x.key));
  const next:Visual['bindings']={};
  for(const key of ['axis','values','target','tooltips','legend','x','size','min','max','location','latitude','longitude','geometry','detail','color','label','path','country','region','postalCode'] as VisualWellKey[]){if(allowed.has(key))(next as any)[key]=[...(((bindings as any)?.[key])||[])];}
  if(allowed.has('axis')&&bindings?.hierarchy)next.hierarchy=structuredClone(bindings.hierarchy);
  return next;
}
function DataWells({visual,addBinding,removeBinding,moveBinding,updateVisual,model}:{visual:Visual,addBinding:(k:VisualWellKey,x:string)=>void,removeBinding:(k:VisualWellKey,x:string)=>void,moveBinding?:(k:VisualWellKey,x:string,direction:-1|1)=>void,updateVisual?:(fn:(v:Visual)=>void)=>void,model?:any}){
  const[,refresh]=useState(0);
  const move=(k:VisualWellKey,x:string,direction:-1|1)=>{if(moveBinding){moveBinding(k,x,direction);return}const items=[...((visual.bindings as any)[k]||[])];const from=items.indexOf(x),to=from+direction;if(from<0||to<0||to>=items.length)return;[items[from],items[to]]=[items[to],items[from]];(visual.bindings as any)[k]=items;refresh(n=>n+1)};
  const isNumericField=(field:string)=>{const core=field.split('::')[0];const typ=String(model?.columnTypes?.[core]||'').toLowerCase();return /^(u?int\d*|integer|bigint|smallint|tinyint|float\d*|double|double precision|decimal|numeric|number|real|money|currency)$/.test(typ)||/(amount|revenue|cost|qty|quantity|price|points|number|count|total|target|latitude|longitude|salary|age|score|rate|percent|ratio|value|weight|height|budget|spend|profit|loss|sales|units|days)/i.test(core.split('.').slice(-1)[0])};
  return <>{visualProfile(visual.type).wells.map(w=><Well key={w.key} title={w.title} items={(visual.bindings as any)[w.key]||[]} accept={w.accept} onDrop={x=>addBinding(w.key,x)} onRemove={x=>removeBinding(w.key,x)} onMove={(x,d)=>move(w.key,x,d)} onRename={updateVisual ? (x,name)=>updateVisual(v=>{const names={...(v.format.fieldDisplayNames||{})};if(name.trim())names[x]=name.trim();else delete names[x];v.format.fieldDisplayNames=names}) : undefined} displayNames={(visual.format as any).fieldDisplayNames} visualType={visual.type} wellKey={w.key} isNumericField={isNumericField} isMeasureField={(f)=>!!(model?.measures?.[f.split('::')[0]])}/>)}</>;
}
let reportFieldDragPayload='';
let reportFieldDragCleanup:(()=>void)|undefined;
let reportFieldDragGhost:HTMLDivElement|undefined;
let reportFieldLastDropRaw='';
let reportFieldLastDropAt=0;
const clearReportFieldDragPayload=()=>window.setTimeout(()=>{reportFieldDragPayload=''},250);
const reportFieldDragLabel=(payload:string)=>payload.split(':').slice(1).join(':').split('.').slice(-1)[0]||payload;
const moveReportFieldDragGhost=(x:number,y:number)=>{if(reportFieldDragGhost)reportFieldDragGhost.style.transform=`translate(${x+14}px,${y+14}px)`};
const endReportFieldDragVisual=()=>{reportFieldDragGhost?.remove();reportFieldDragGhost=undefined;document.body.classList.remove('reportFieldDragging')};
const finishReportFieldPointerDrop=(e:PointerEvent|MouseEvent)=>{
  if(!reportFieldDragPayload)return;
  const target=(document.elementFromPoint(e.clientX,e.clientY) as HTMLElement|null)?.closest('[data-report-field-drop="true"]');
  if(!target)return;
  e.preventDefault();e.stopPropagation();
  target.dispatchEvent(new CustomEvent('vtab-report-field-drop',{bubbles:true,detail:{raw:reportFieldDragPayload}}));
};
const beginReportFieldDrag=(payload:string,e?:{clientX:number;clientY:number;preventDefault?:()=>void;stopPropagation?:()=>void})=>{
  reportFieldDragPayload=payload;
  if(typeof window==='undefined')return;
  e?.preventDefault?.();e?.stopPropagation?.();reportFieldDragCleanup?.();endReportFieldDragVisual();
  reportFieldDragGhost=document.createElement('div');reportFieldDragGhost.className='reportFieldDragGhost';reportFieldDragGhost.textContent=reportFieldDragLabel(payload);document.body.appendChild(reportFieldDragGhost);document.body.classList.add('reportFieldDragging');moveReportFieldDragGhost(e?.clientX??0,e?.clientY??0);
  const move=(ev:PointerEvent|MouseEvent)=>moveReportFieldDragGhost(ev.clientX,ev.clientY);
  const finish=(ev:PointerEvent|MouseEvent)=>{finishReportFieldPointerDrop(ev);reportFieldDragCleanup?.();clearReportFieldDragPayload()};
  window.addEventListener('pointermove',move,true);window.addEventListener('mousemove',move,true);window.addEventListener('pointerup',finish,true);window.addEventListener('mouseup',finish,true);
  reportFieldDragCleanup=()=>{window.removeEventListener('pointermove',move,true);window.removeEventListener('mousemove',move,true);window.removeEventListener('pointerup',finish,true);window.removeEventListener('mouseup',finish,true);endReportFieldDragVisual();reportFieldDragCleanup=undefined};
};
const visualIcon=(t:VisualType)=>{
 const common={viewBox:'0 0 32 32',width:20,height:20,fill:'none',stroke:'currentColor',strokeWidth:1.75,strokeLinecap:'square' as const,strokeLinejoin:'miter' as const};
 const svg=(children:any)=><svg {...common}>{children}</svg>;
 const icons:Record<VisualType,any>={
  textbox:<TextCursorInput size={20}/>,button:<MousePointerClick size={20}/>,image:<ImageIcon size={20}/>,shape:svg(<><rect x="5" y="6" width="22" height="20" rx="3"/><circle cx="16" cy="16" r="6"/></>),
  kpi:svg(<><path d="M5 7h22v18H5zM8 21l5-6 4 3 6-8"/><path d="M21 10h3v3"/></>),
  card:svg(<><rect x="5" y="7" width="22" height="18"/><path d="M9 12h7M9 17h14M9 21h9"/></>),
  multirowcard:svg(<><rect x="4" y="5" width="24" height="22"/><path d="M8 10h5M8 15h16M8 20h5M16 10h8M16 20h8"/></>),
  bar:svg(<><path d="M5 6v21h23"/><rect x="7" y="8" width="14" height="4"/><rect x="7" y="15" width="20" height="4"/><rect x="7" y="22" width="10" height="4"/></>),
  column:svg(<><path d="M4 27h24"/><rect x="6" y="15" width="5" height="12"/><rect x="14" y="8" width="5" height="19"/><rect x="22" y="12" width="5" height="15"/></>),
  stackedbar:svg(<><path d="M4 6v21h24"/><path d="M7 8h7v4H7zM14 8h9v4h-9zM7 15h11v4H7zM18 15h8v4h-8zM7 22h5v4H7zM12 22h9v4h-9z"/></>),
  stackedcolumn:svg(<><path d="M4 27h24"/><path d="M6 18h6v9H6zM6 11h6v7H6zM14 14h6v13h-6zM14 6h6v8h-6zM22 20h6v7h-6zM22 13h6v7h-6z"/></>),
  line:svg(<><path d="M4 26V6M4 26h24M7 21l6-7 5 4 8-10"/><circle cx="7" cy="21" r="1.5"/><circle cx="13" cy="14" r="1.5"/><circle cx="18" cy="18" r="1.5"/><circle cx="26" cy="8" r="1.5"/></>),
  area:svg(<><path d="M4 26V6M4 26h24M7 21l6-7 5 4 8-10v18H7z" fill="currentColor" fillOpacity=".18"/><path d="M7 21l6-7 5 4 8-10"/></>),
  combo:svg(<><path d="M4 27h24M6 18h5v9H6zM14 12h5v15h-5zM22 16h5v11h-5z"/><path d="M6 11l7 4 6-8 8 3"/></>),
  pie:svg(<><path d="M14 4a12 12 0 1 0 12 12H14z"/><path d="M18 4.7A12 12 0 0 1 27.3 14H18z"/></>),
  donut:svg(<><path d="M14 4a12 12 0 1 0 12 12H14z"/><path d="M18 4.7A12 12 0 0 1 27.3 14H18z"/><circle cx="15" cy="16" r="5"/></>),
  treemap:svg(<><rect x="4" y="5" width="24" height="22"/><path d="M15 5v22M15 15h13M4 18h11"/></>),
  funnel:svg(<><path d="M4 6h24l-3 5H7zM8 13h16l-3 5H11zM12 20h8l-2 6h-4z"/></>),
  waterfall:svg(<><path d="M4 27h24M6 8h5v7H6zM14 13h5v7h-5zM22 18h5v9h-5zM11 15h3M19 20h3"/></>),
  scatter:svg(<><path d="M5 26V6M5 26h22"/><circle cx="10" cy="20" r="1.7"/><circle cx="16" cy="12" r="2"/><circle cx="23" cy="17" r="1.5"/><circle cx="25" cy="8" r="1.4"/></>),
  bubble:svg(<><path d="M5 26V6M5 26h22"/><circle cx="11" cy="19" r="3"/><circle cx="18" cy="11" r="4"/><circle cx="25" cy="18" r="2"/></>),
  radar:svg(<><path d="M16 4l11 8-4 13H9L5 12zM16 4v21M5 12l18 13M27 12L9 25"/><path d="M16 9l7 5-3 7h-8l-3-7z"/></>),
  heatmap:svg(<>{[5,13,21].flatMap((x,i)=>[5,13,21].map((y,j)=><rect key={`${i}-${j}`} x={x} y={y} width="6" height="6" fill="currentColor" fillOpacity={(i+j+2)/7}/>))}</>),
  histogram:svg(<><path d="M4 27h24"/><rect x="6" y="21" width="4" height="6"/><rect x="10" y="15" width="4" height="12"/><rect x="14" y="8" width="4" height="19"/><rect x="18" y="11" width="4" height="16"/><rect x="22" y="18" width="4" height="9"/></>),
  boxplot:svg(<><path d="M4 27h24M9 8v17M7 8h4M7 25h4M6 14h6v7H6zM22 5v19M20 5h4M20 24h4M19 10h6v8h-6z"/></>),
  gauge:svg(<><path d="M5 24a11 11 0 0 1 22 0M16 21l7-8"/><circle cx="16" cy="21" r="2"/></>),
  progress:svg(<><rect x="4" y="10" width="24" height="12"/><path d="M7 13h13v6H7z" fill="currentColor" fillOpacity=".25"/></>),
  map:<MapPinned size={20}/>,
  table:svg(<><rect x="4" y="5" width="24" height="22"/><path d="M4 11h24M4 17h24M4 23h24M12 5v22M20 5v22"/></>),
  matrix:svg(<><rect x="4" y="5" width="24" height="22"/><path d="M4 12h24M4 19h24M13 5v22M21 5v22"/><path d="M5 6h22v5H5z" fill="currentColor" fillOpacity=".18"/></>),
  slicer:svg(<><path d="M4 6h24l-9 10v8l-6 3V16z"/><path d="M22 21h6M25 18v6"/></>)
 };
 const icon=icons[t];
 return <span className="visualGlyph professionalVisualGlyph" style={{'--visual-color':visualColor[t]||'#2563eb'} as any}>{icon}</span>;
}

const defaultPageSettings=():PageSettings=>({
  background:'#ffffff',
  showNavigation:false,
  themeId:'light-professional',
  backgroundImageFit:'cover',
  backgroundImageOpacity:24,
  pageWidth:1920,
  pageHeight:1080,
  pageSizePreset:'Full HD 16:9',
  pageAlignment:'center',
  pageVerticalAlignment:'top',
  showGrid:true,
  snapToGrid:true,
  allowOverlap:false,
  layoutMode:'guided',
  autoFitHeight:true,
  footerGap:96,
  navigationPosition:'outside',
  navigationTopMargin:16,
  navigationBottomMargin:24,
  header:{
    visible:false,
    title:'Dashboard Title',
    subtitle:'Add a subtitle or reporting period',
    fontSize:28,
    subtitleFontSize:12,
    titleColor:'#0f172a',
    subtitleColor:'#475569',
    alignment:'left',
    background:'#ffffff',
    height:84,
    paddingTop:12,
    paddingBottom:12,
    paddingLeft:24,
    paddingRight:24,
    borderRadius:14,
    showGeneratedInfo:true,
    generatedInfoBackground:'#f8fbff'
  }
});

const REPORT_THEMES=[
  {id:'vtab-midnight',name:'VTAB Midnight',preview:['#081321','#0d1d2d','#22d3ee','#8b5cf6'],page:'#081321',header:'#0b1725',visual:'#0d1724',accent:'#22d3ee',title:'#f1f7ff',label:'#cbd5e1'},
  {id:'executive-blue',name:'Executive Blue',preview:['#07152b','#102a56','#3b82f6','#60a5fa'],page:'#07152b',header:'#0b2145',visual:'#0d2345',accent:'#60a5fa',title:'#eff6ff',label:'#dbeafe'},
  {id:'graphite',name:'Graphite',preview:['#101317','#1c2128','#a3e635','#64748b'],page:'#101317',header:'#171b21',visual:'#1a2027',accent:'#a3e635',title:'#f8fafc',label:'#cbd5e1'},
  {id:'emerald',name:'Emerald Intelligence',preview:['#061a18','#0b2b28','#34d399','#14b8a6'],page:'#061a18',header:'#09231f',visual:'#0b2523',accent:'#34d399',title:'#ecfdf5',label:'#d1fae5'},
  {id:'violet',name:'Violet AI',preview:['#120a25','#241247','#a78bfa','#ec4899'],page:'#120a25',header:'#1d1037',visual:'#20143a',accent:'#a78bfa',title:'#faf5ff',label:'#ede9fe'},
  {id:'light-professional',name:'Light Professional',preview:['#f5f7fb','#ffffff','#2563eb','#0f172a'],page:'#eef2f7',header:'#ffffff',visual:'#ffffff',accent:'#2563eb',title:'#0f172a',label:'#334155'}
];
function applyThemeToPage(page:Page,themeId:string){
  // IMPORTANT: do not call pageDefaults() here. pageDefaults may itself migrate
  // an older theme via applyThemeToPage(), which would recurse indefinitely.
  page.filters=page.filters||[];
  page.settings=page.settings||defaultPageSettings();
  page.settings.header=page.settings.header||defaultPageSettings().header;
  const theme=REPORT_THEMES.find(t=>t.id===themeId)||REPORT_THEMES[0];
  page.settings!.themeId=theme.id;
  page.settings!.background=theme.page;
  page.settings!.header.background=theme.header;
  page.settings!.header.titleColor=theme.title;
  page.settings!.header.subtitleColor=theme.label;
  for(const visual of page.visuals){
    formatDefaults(visual);
    visual.format.background=theme.visual;
    visual.format.accent=theme.accent;
    visual.format.titleColor=theme.title;
    visual.format.labelColor=theme.label;
    visual.format.borderColor=theme.id==='light-professional'?'#d8e0ea':'#23394f';
  }
}
function uploadBackgroundImage(file:File,done:(dataUrl:string)=>void){
  const maxBytes=8*1024*1024;
  if(file.size>maxBytes){window.alert('Please choose an image smaller than 8 MB.');return}
  if(!file.type.startsWith('image/')){window.alert('Please choose a PNG, JPG, WEBP or other image file.');return}
  const reader=new FileReader();
  reader.onload=()=>done(String(reader.result||''));
  reader.readAsDataURL(file);
}

function pageDefaults(page:Page){
  page.filters=page.filters||[];
  for(const visual of page.visuals||[])formatDefaults(visual);
  page.settings=page.settings||defaultPageSettings();
  page.settings.header=page.settings.header||defaultPageSettings().header;
  if(!(page.settings as any).v5Migrated&&!(page.visuals||[]).length){page.settings.background='#ffffff';page.settings.header.visible=false;page.settings.showNavigation=false;(page.settings as any).v5Migrated=true}
  if(!(page.settings as any).v5CanvasMigrated&&!(page.visuals||[]).length){if(['#eef2f7','#f3f6fa'].includes(String(page.settings.background).toLowerCase()))page.settings.background='#ffffff';page.settings.header.visible=false;page.settings.showNavigation=false;(page.settings as any).v5CanvasMigrated=true}
  page.settings.themeId=page.settings.themeId||'light-professional';
  // One-time safe migration for older empty report pages. Do the assignment
  // directly rather than calling applyThemeToPage() from inside pageDefaults().
  if(page.settings.themeId==='vtab-midnight'&&!(page.visuals||[]).length){
    const theme=REPORT_THEMES.find(t=>t.id==='light-professional')!;
    page.settings.themeId=theme.id;
    page.settings.background='#ffffff';
    page.settings.header.background=theme.header;
    page.settings.header.titleColor=theme.title;
    page.settings.header.subtitleColor=theme.label;
    page.settings.header.visible=false;
    page.settings.showNavigation=false;
  }
  page.settings.backgroundImageFit=page.settings.backgroundImageFit||'cover';
  page.settings.backgroundImageOpacity=page.settings.backgroundImageOpacity??24;
  page.settings.pageWidth=page.settings.pageWidth||1920;
  page.settings.pageHeight=page.settings.pageHeight||1080;
  if((page.settings.pageSizePreset as any)==='16:9')page.settings.pageSizePreset='Full HD 16:9';
  page.settings.pageSizePreset=page.settings.pageSizePreset||'Full HD 16:9';
  const fixedPageSizes:Record<string,[number,number]>={
    'HD 16:9':[1280,720],'Full HD 16:9':[1920,1080],'QHD 16:9':[2560,1440],
    '16:10':[1920,1200],'4:3':[960,720],Letter:[816,1056],Tooltip:[320,240],
    'A4 Landscape':[1123,794],'A4 Portrait':[794,1123]
  };
  const fixedSize=fixedPageSizes[page.settings.pageSizePreset];
  if(fixedSize){
    [page.settings.pageWidth,page.settings.pageHeight]=fixedSize;
    // Fixed presets must retain their real aspect ratio. Older projects could be
    // saved as 1920 x 720 and then shrink to their lowest visual.
    page.settings.autoFitHeight=false;
  }
  page.settings.pageAlignment=page.settings.pageAlignment||'center';
  page.settings.showGrid=page.settings.showGrid!==false;
  page.settings.snapToGrid=page.settings.snapToGrid!==false;
  page.settings.allowOverlap=page.settings.allowOverlap===true;
  page.settings.layoutMode=page.settings.layoutMode||'guided';
  page.settings.autoFitHeight=page.settings.autoFitHeight===true;
  page.settings.footerGap=page.settings.footerGap===undefined||page.settings.footerGap===96?32:page.settings.footerGap;
  page.settings.navigationPosition=page.settings.navigationPosition||'outside';
  page.settings.navigationTopMargin=page.settings.navigationTopMargin??16;
  page.settings.navigationBottomMargin=page.settings.navigationBottomMargin??24;
  if(!page.settings.autoFitHeight){
    const bodyHeight=Math.max(30,(page.settings.pageHeight||1080)-(page.settings.header.visible?(page.settings.header.height||84):0));
    for(const visual of page.visuals||[]){
      visual.w=Math.max(40,Math.min(page.settings.pageWidth||1920,visual.w||40));
      visual.h=Math.max(30,Math.min(bodyHeight,visual.h||30));
      visual.x=Math.max(0,Math.min((page.settings.pageWidth||1920)-visual.w,visual.x||0));
      visual.y=Math.max(0,Math.min(bodyHeight-visual.h,visual.y||0));
    }
  }
  page.settings.header.subtitleFontSize=page.settings.header.subtitleFontSize??12;
  page.settings.header.height=page.settings.header.height??84;
  page.settings.header.paddingTop=page.settings.header.paddingTop??12;
  page.settings.header.paddingBottom=page.settings.header.paddingBottom??12;
  page.settings.header.paddingLeft=page.settings.header.paddingLeft??24;
  page.settings.header.paddingRight=page.settings.header.paddingRight??24;
  page.settings.header.borderRadius=page.settings.header.borderRadius??14;
  page.settings.header.showGeneratedInfo=page.settings.header.showGeneratedInfo!==false;
  page.settings.header.generatedInfoBackground=page.settings.header.generatedInfoBackground||'#f8fbff';
  const pageWidth=page.settings.pageWidth||1920;
  for(const[visualIndex,visual]of(page.visuals||[]).entries()){
    if(visual.geometryVersion!==2){const column=(pageWidth-11*16)/12;visual.x=Math.round((visual.x||0)*(column+16));visual.y=Math.round((visual.y||0)*66);visual.w=Math.max(40,Math.round((visual.w||2)*column+Math.max(0,(visual.w||2)-1)*16));visual.h=Math.max(30,Math.round((visual.h||2)*50+Math.max(0,(visual.h||2)-1)*16));visual.geometryVersion=2}
    visual.rotation=visual.rotation||0;visual.zIndex=visualIndex;visual.visible=visual.visible!==false;visual.locked=visual.locked===true;
  }
  for(const visual of page.visuals||[])if(visual.type==='button'&&visual.action?.dynamicLabel!==false)visual.buttonLabel=resolveActionButtonLabel(visual,page,[page]);
  return page;
}
function formatDefaults(v:Visual){
  v.format=v.format||({} as VisualFormat);
  v.format.accent=v.format.accent||'#118dff';v.format.fontSize=v.format.fontSize||12;
  if(v.format.showTitle===undefined)v.format.showTitle=true;if(v.format.dataLabels===undefined)v.format.dataLabels=false;
  v.format.background=v.format.background||'#ffffff';v.format.fontFamily=v.format.fontFamily||'Segoe UI';v.format.fieldFormats=v.format.fieldFormats||{};v.format.displayUnits=v.format.displayUnits||'auto';v.format.displayUnitDecimals=v.format.displayUnitDecimals??2;
  v.format.titleFontFamily=v.format.titleFontFamily||v.format.fontFamily||'Segoe UI';v.format.titleFontSize=v.format.titleFontSize||12;v.format.titleColor=v.format.titleColor||'#242424';if(v.format.titleBold===undefined)v.format.titleBold=v.format.titleFontWeight===undefined?true:v.format.titleFontWeight>=600;v.format.titleFontWeight=v.format.titleBold?700:400;v.format.subtitle=v.format.subtitle||'';if(v.format.subtitleVisible===undefined)v.format.subtitleVisible=false;v.format.subtitleFontFamily=v.format.subtitleFontFamily||v.format.titleFontFamily;v.format.subtitleColor=v.format.subtitleColor||'#616161';v.format.subtitleFontSize=v.format.subtitleFontSize||10;if(v.format.subtitleBold===undefined)v.format.subtitleBold=(v.format.subtitleFontWeight||400)>=600;
  v.format.titleAlignment=v.format.titleAlignment||'left';v.format.titleFontStyle=v.format.titleFontStyle||'normal';v.format.titleUnderline=!!v.format.titleUnderline;if(v.format.titleWrap===undefined)v.format.titleWrap=true;v.format.subtitleFontWeight=v.format.subtitleFontWeight||400;v.format.subtitleAlignment=v.format.subtitleAlignment||v.format.titleAlignment;v.format.subtitleFontStyle=v.format.subtitleFontStyle||'normal';v.format.subtitleUnderline=!!v.format.subtitleUnderline;if(v.format.subtitleWrap===undefined)v.format.subtitleWrap=true;
  v.format.labelFontSize=v.format.labelFontSize||10;v.format.labelColor=v.format.labelColor||'#242424';v.format.labelPosition=v.format.labelPosition||'top';
  v.format.axisFontSize=v.format.axisFontSize||9;v.format.axisColor=v.format.axisColor||'#616161';if(v.format.axisTitleVisible===undefined)v.format.axisTitleVisible=false;v.format.xAxisTitle=v.format.xAxisTitle||'';v.format.yAxisTitle=v.format.yAxisTitle||'';v.format.gridLineColor=v.format.gridLineColor||'#e6e6e6';v.format.gridLineStyle=v.format.gridLineStyle||'dotted';if(v.format.zoomSlider===undefined)v.format.zoomSlider=false;v.format.referenceLineLabel=v.format.referenceLineLabel||'Reference';v.format.referenceLineColor=v.format.referenceLineColor||'#d13438';if(v.format.visualHeader===undefined)v.format.visualHeader=true;if(v.format.responsive===undefined)v.format.responsive=true;v.format.altText=v.format.altText||'';v.format.markerShape=v.format.markerShape||'circle';v.format.lineWidth=v.format.lineWidth||2;if(v.format.smoothLines===undefined)v.format.smoothLines=true;v.format.barRadius=v.format.barRadius??0;v.format.barWidth=v.format.barWidth||42;v.format.padding=v.format.padding??8;v.format.chartOpacity=v.format.chartOpacity??100;if(v.format.legendVisible===undefined)v.format.legendVisible=true;v.format.legendPosition=v.format.legendPosition||'bottom';v.format.legendColor=v.format.legendColor||v.format.axisColor;v.format.legendFontSize=v.format.legendFontSize||10;v.format.visibleCategoryCount=v.format.visibleCategoryCount||12;
  if(v.format.borderVisible===undefined)v.format.borderVisible=false;v.format.borderColor=v.format.borderColor||'#c8c8c8';v.format.borderWidth=v.format.borderWidth??1;v.format.borderStyle=v.format.borderStyle||'solid';v.format.borderEdges=v.format.borderEdges||{top:true,right:true,bottom:true,left:true};v.format.cornerRadius=v.format.cornerRadius??0;v.format.cornerLinked=v.format.cornerLinked!==false;v.format.cornerRadii=v.format.cornerRadii||{topLeft:v.format.cornerRadius,topRight:v.format.cornerRadius,bottomRight:v.format.cornerRadius,bottomLeft:v.format.cornerRadius};
  if(v.format.shadow===undefined)v.format.shadow=false;v.format.backgroundTransparency=v.format.backgroundTransparency??0;if(v.format.gridLines===undefined)v.format.gridLines=true;
  if(v.format.showDataPoints===undefined)v.format.showDataPoints=true;v.format.dataPointSize=v.format.dataPointSize||7;if(v.format.tooltipEnabled===undefined)v.format.tooltipEnabled=true;v.format.tooltipBackground=v.format.tooltipBackground||'#0a1421';v.format.tooltipColor=v.format.tooltipColor||'#dce8f5';
  if(v.format.indicatorEnabled===undefined)v.format.indicatorEnabled=false;v.format.favorableDirection=v.format.favorableDirection||'up';
  v.format.positiveColor=v.format.positiveColor||'#34d399';v.format.negativeColor=v.format.negativeColor||'#fb7185';v.format.neutralColor=v.format.neutralColor||'#94a3b8';
  v.format.textFontWeight=v.format.textFontWeight||400;v.format.textItalic=!!v.format.textItalic;v.format.textUnderline=!!v.format.textUnderline;v.format.textAlign=v.format.textAlign||'left';v.format.textVerticalAlign=v.format.textVerticalAlign||'top';if(v.format.textWrap===undefined)v.format.textWrap=true;v.format.textLineHeight=v.format.textLineHeight||1.45;
  v.format.imageFit=v.format.imageFit||'contain';v.format.imageOpacity=v.format.imageOpacity??100;
  const savedShapeOutlineWidth=v.format.shapeStrokeWidth;
  v.format.shapeType=v.format.shapeType||'rectangle';
  if(v.format.shapeFillVisible===undefined)v.format.shapeFillVisible=true;
  v.format.shapeFill=v.format.shapeFill||'#dbeafe';v.format.shapeFillTransparency=v.format.shapeFillTransparency??0;
  // Existing reports that stored a non-zero outline width retain that outline.
  // Newly inserted shapes explicitly opt out of an outline in newVisual().
  if(v.format.shapeStrokeVisible===undefined)v.format.shapeStrokeVisible=(savedShapeOutlineWidth??0)>0;
  v.format.shapeStroke=v.format.shapeStroke||'#2563eb';v.format.shapeStrokeWidth=v.format.shapeStrokeWidth??2;v.format.shapeStrokeStyle=v.format.shapeStrokeStyle||'solid';v.format.shapeCornerRadius=v.format.shapeCornerRadius??18;
  if(v.type==='shape'){v.format.showTitle=false;v.format.visualHeader=false;v.format.backgroundEnabled=false;v.format.borderVisible=false;v.format.padding=0;v.format.paddingTop=0;v.format.paddingRight=0;v.format.paddingBottom=0;v.format.paddingLeft=0}
  if(v.type==='map'){
    v.format.mapMode=v.format.mapMode==='filled'?'filled':'bubble';v.format.mapStyle=v.format.mapStyle||'light';v.format.mapGeographyScope=v.format.mapGeographyScope||'auto';v.format.mapDefaultCountry=v.format.mapDefaultCountry||'India';if(v.format.mapAutoFit===undefined)v.format.mapAutoFit=true;if(v.format.mapNavigation===undefined)v.format.mapNavigation=true;if(v.format.mapClustering===undefined)v.format.mapClustering=true;
    v.format.mapClusterRadius=v.format.mapClusterRadius??45;v.format.mapMarkerSize=v.format.mapMarkerSize??9;v.format.mapMarkerMinSize=v.format.mapMarkerMinSize??5;v.format.mapMarkerMaxSize=v.format.mapMarkerMaxSize??24;v.format.mapMarkerOpacity=v.format.mapMarkerOpacity??85;v.format.mapMarkerColor=v.format.mapMarkerColor||v.format.accent;
    v.format.mapBorderColor=v.format.mapBorderColor||'#ffffff';v.format.mapBorderWidth=v.format.mapBorderWidth??1;v.format.mapFillColor=v.format.mapFillColor||v.format.accent;v.format.mapFillOpacity=v.format.mapFillOpacity??78;v.format.mapMissingColor=v.format.mapMissingColor||'#e8eef4';v.format.mapColorScale=['rules','threshold'].includes(v.format.mapColorScale||'')?'rules':'measure';v.format.mapMinColor=v.format.mapMinColor||'#d64550';v.format.mapMidColor=v.format.mapMidColor||'#facc15';v.format.mapMaxColor=v.format.mapMaxColor||'#1aab40';v.format.mapRuleLow=v.format.mapRuleLow??0;v.format.mapRuleHigh=v.format.mapRuleHigh??100;v.format.mapRuleLowColor=v.format.mapRuleLowColor||'#d64550';v.format.mapRuleMidColor=v.format.mapRuleMidColor||'#facc15';v.format.mapRuleHighColor=v.format.mapRuleHighColor||'#1aab40';
    v.format.mapHeatColor=v.format.mapHeatColor||'#ef4444';v.format.mapHeatRadius=v.format.mapHeatRadius??24;v.format.mapHeatIntensity=v.format.mapHeatIntensity??1;v.format.mapHeatOpacity=v.format.mapHeatOpacity??80;v.format.mapLineColor=v.format.mapLineColor||v.format.accent;v.format.mapLineWidth=v.format.mapLineWidth??3;v.format.mapLineOpacity=v.format.mapLineOpacity??90;
    if(v.format.mapLabels===undefined)v.format.mapLabels=true;if(v.format.mapCountryLabels===undefined)v.format.mapCountryLabels=true;v.format.mapLabelColor=v.format.mapLabelColor||'#1f2937';v.format.mapLabelSize=v.format.mapLabelSize??11;if(v.format.mapAllowOverlap===undefined)v.format.mapAllowOverlap=false;v.format.mapSourceCrs=v.format.mapSourceCrs||'EPSG:4326';
  }
  v.format.cardsPerRow=v.format.cardsPerRow||2;if(v.format.cardAutoFit===undefined)v.format.cardAutoFit=true;v.format.cardMinWidth=v.format.cardMinWidth||150;v.format.cardMinHeight=v.format.cardMinHeight||92;v.format.cardGapX=v.format.cardGapX??10;v.format.cardGapY=v.format.cardGapY??10;v.format.cardPadding=v.format.cardPadding??12;v.format.cardHorizontalAlign=v.format.cardHorizontalAlign||'left';v.format.cardVerticalAlign=v.format.cardVerticalAlign||'middle';v.format.cardTitlePosition=v.format.cardTitlePosition||'top';v.format.cardValuePosition=v.format.cardValuePosition||'middle';v.format.cardIconPosition=v.format.cardIconPosition||'left';v.format.cardIconSize=v.format.cardIconSize||34;
  return v;
}
async function queryVisual(v:Visual,project:any,roleId?:string|null,extraFilters:VisualFilter[]=[]){
  if(v.type==='map'&&v.format.mapCustomGeometry?.features?.length&&!['location','latitude','longitude','geometry','detail','color','label','path','country','region','postalCode','size','tooltips','values'].some(key=>((v.bindings as any)[key]||[]).length))return {rows:[]};
  let measures=v.type==='slicer'?[]:Array.from(new Set([...(v.bindings.values||[]),...(v.bindings.target||[]),...(v.bindings.tooltips||[]),...((v.bindings as any).min||[]),...((v.bindings as any).max||[]),...((v.bindings as any).x||[]),...((v.bindings as any).size||[])]));
  const activeAxis = v.type === 'table'
    ? (v.bindings.axis || []).filter(Boolean)
    : v.bindings.axis ? [v.bindings.axis[v.drillLevel || 0] || v.bindings.axis[0]].filter(Boolean) : [];
  // For table: axis fields with aggregation suffix (::sum etc.) act as measures; plain fields are dimensions
  let axisDimensions = activeAxis;
  if (v.type === 'table') {
    const isMeasureField = (f: string) => f.includes('::') || !!(project?.model?.measures && (project.model.measures[f] || project.model.measures[f.split('.').slice(-1)[0]]));
    const axisWithAgg = activeAxis.filter(isMeasureField);
    axisDimensions = activeAxis.filter(f => !isMeasureField(f));
    measures = Array.from(new Set([...measures, ...axisWithAgg]));
  }
  let dimensions=Array.from(new Set([...axisDimensions,...(v.bindings.legend||[]),...(v.type==='scatter'?(v.bindings.axis||[]):[])]));
  if(v.type==='map'){
    const mapFields=['location','latitude','longitude','geometry','detail','color','label','path','country','region','postalCode'].flatMap(key=>(v.bindings as any)[key]||[]);
    const flexible=[...(v.bindings.size||[]),...(v.bindings.tooltips||[]),...(v.bindings.values||[])];
    const isMeasure=(field:string)=>field.includes('::')||!!(project?.model?.measures?.[field]||project?.model?.measures?.[field.split('.').slice(-1)[0]]);
    const allMapFields = [...mapFields, ...flexible];
    dimensions=Array.from(new Set(allMapFields.filter(field=>!isMeasure(field))));
    measures=Array.from(new Set(allMapFields.filter(field=>isMeasure(field))));
  }
  const configuredFilters=[...(v.filters||[]),...(v.drillFilters||[]),...extraFilters];
  const filters=configuredFilters.filter(f=>{
    if (f.operator === 'in' && (!Array.isArray(f.value) || f.value.length === 0)) return false;
    if (f.operator === 'top_n' && (!f.value || !f.rankingField)) return false;
    if (f.operator !== 'is_blank' && f.operator !== 'is_not_blank' && f.operator !== 'top_n' && (f.value === '' || f.value === null || f.value === undefined)) return false;
    return true;
  });
  let sort = v.sort || [];
  const axisDim = activeAxis[0] || '';
  if (!sort.length && axisDim.includes('::')) {
    sort = [{ field: axisDim, direction: 'asc' as const }];
  }
  const defaultLimit=(v.type==='map'||v.type==='table'||v.type==='matrix')?5000:(v.type==='histogram'?2000:500);
  const limit=defaultLimit;
  const result=await api<any>('/query-snapshot',{method:'POST',body:JSON.stringify({project,dimensions,measures,filters,sort,limit,roleId,distinct:v.type==='slicer'})});
  return result;
}

function downloadCsv(rows:any[],title:string){
  if(!rows.length){window.alert('No data is available to export.');return}
  const cols=Object.keys(rows[0]);
  const esc=(x:any)=>`"${String(x??'').replace(/"/g,'""')}"`;
  const csv=[cols.map(esc).join(','),...rows.map(row=>cols.map(c=>esc(row[c])).join(','))].join('\r\n');
  const blob=new Blob([csv],{type:'text/csv;charset=utf-8;'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url;a.download=(title||'visual-data').replace(/[^\w\-]+/g,'_')+'.csv';
  document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url);
}



function downloadJson(rows:any[],title:string){const blob=new Blob([JSON.stringify(rows,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=(title||'visual-data').replace(/[^\w\-]+/g,'_')+'.json';document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url)}
function downloadExcel(rows:any[],title:string){if(!rows.length){window.alert('No data is available to export.');return}const cols=Object.keys(rows[0]);const esc=(x:any)=>String(x??'').replace(/\t/g,' ').replace(/\r?\n/g,' ');const tsv=[cols.join('\t'),...rows.map(r=>cols.map(c=>esc(r[c])).join('\t'))].join('\r\n');const blob=new Blob([tsv],{type:'application/vnd.ms-excel;charset=utf-8;'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=(title||'visual-data').replace(/[^\w\-]+/g,'_')+'.xls';document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url)}

function ShapeArtwork({format}:{format:VisualFormat}){
  const type=format.shapeType||'rectangle';
  const fillVisible=format.shapeFillVisible!==false&&type!=='line';
  const strokeVisible=format.shapeStrokeVisible??((format.shapeStrokeWidth??0)>0);
  const fill=format.shapeFill||'#dbeafe',fillOpacity=1-Math.max(0,Math.min(100,format.shapeFillTransparency??0))/100;
  const stroke=format.shapeStroke||'#2563eb',strokeWidth=Math.max(0,format.shapeStrokeWidth??2),strokeStyle=format.shapeStrokeStyle||'solid';
  const shadow=format.shadow?`drop-shadow(0 ${format.shadowOffset??8}px 10px color-mix(in srgb, ${format.shadowColor||'#000000'} 24%, transparent))`:'none';
  const surfaceStyle={background:fillVisible?`color-mix(in srgb, ${fill} ${Math.round(fillOpacity*100)}%, transparent)`:'transparent',border:strokeVisible&&strokeWidth>0?`${strokeWidth}px ${strokeStyle} ${stroke}`:'none',borderRadius:type==='ellipse'?'50%':type==='roundedRectangle'?`${Math.max(0,format.shapeCornerRadius??18)}px`:'0',filter:shadow} as const;
  if(type==='rectangle'||type==='roundedRectangle'||type==='ellipse')return <div className={`shapeArtwork shapeArtwork-${type}`} style={surfaceStyle} aria-hidden="true"/>;
  const dash=strokeStyle==='dashed'?'10 6':strokeStyle==='dotted'?'2 5':undefined;
  const common={fill:fillVisible?fill:'none',fillOpacity,stroke:strokeVisible&&strokeWidth>0?stroke:'none',strokeWidth,strokeDasharray:dash,strokeLinejoin:'round' as const,vectorEffect:'non-scaling-stroke' as const};
  return <svg className={`shapeArtwork shapeArtwork-${type}`} style={{filter:shadow}} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">{type==='line'?<line x1="0" y1="50" x2="100" y2="50" {...common}/>:type==='triangle'?<polygon points="50,0 100,100 0,100" {...common}/>:<polygon points="50,0 100,50 50,100 0,50" {...common}/>}</svg>;
}

function RichTextBox({v,selected,onSelect,onChange,style,designerHandle,menuNode,responsiveSizeClass}:{v:Visual;selected:boolean;onSelect:(additive?:boolean)=>void;onChange:(fn:(v:Visual)=>void)=>void;style:any;designerHandle:any;menuNode:any;responsiveSizeClass:string}){
  const[editing,setEditing]=useState(false);
  const editorRef=useRef<HTMLDivElement|null>(null);
  const selectionRef=useRef<Range|null>(null);
  const initialHtml=richTextHtml(v.richText,v.text);
  useEffect(()=>{if(!editing&&editorRef.current&&editorRef.current.innerHTML!==initialHtml)editorRef.current.innerHTML=initialHtml},[initialHtml,editing]);
  useEffect(()=>{if(!selected)setEditing(false)},[selected]);
  const rememberSelection=()=>{const selection=window.getSelection(),editor=editorRef.current;if(selection?.rangeCount&&editor?.contains(selection.anchorNode))selectionRef.current=selection.getRangeAt(0).cloneRange()};
  // Persist the current value without replacing the live contentEditable DOM.
  // Replacing innerHTML on every input moves the caret to the start, which makes
  // subsequent characters appear in reverse order.
  const save=()=>{const editor=editorRef.current;if(!editor)return;rememberSelection();const html=sanitizeRichText(editor.innerHTML);const plain=editor.innerText.replace(/\u00a0/g,' ');const runs=extractRichTextRuns(editor);onChange(x=>{x.richText=html;x.richTextRuns=runs;x.text=plain})};
  const command=(name:string,value?:string)=>{const editor=editorRef.current;if(!editor)return;editor.focus();const selection=window.getSelection();if(selectionRef.current&&selection){selection.removeAllRanges();selection.addRange(selectionRef.current)}document.execCommand(name,false,value);save()};
  const link=()=>{const url=window.prompt('Link URL','https://');if(url)command('createLink',url)};
  const beginEdit=(event:ReactMouseEvent)=>{event.preventDefault();event.stopPropagation();onSelect(false);setEditing(true);setTimeout(()=>{if(editorRef.current){editorRef.current.focus();const sel=window.getSelection();if(sel&&editorRef.current.childNodes.length>0){sel.selectAllChildren(editorRef.current);sel.collapseToEnd()}}},50)};
  const stopPointer=(event:SyntheticEvent)=>event.stopPropagation();
  const stopWhenEditing=(event:SyntheticEvent)=>{if(editing)event.stopPropagation()};
  return <div role="group" aria-label={v.format.altTextEnabled&&v.format.altText?v.format.altText:v.title} onMouseDown={event=>onSelect(event.ctrlKey||event.metaKey||event.shiftKey)} onDoubleClick={beginEdit} className={'visualCard premiumVisualCard textBoxVisual '+responsiveSizeClass+(selected?' selected':'')+(editing?' textEditing':'')+(v.hidden?' authorHidden':'')} style={{...style,display:'flex',flexDirection:'column'}}>
    {!editing&&designerHandle}
    {v.format.showTitle&&<div className="visualTitle visualMoveZone"><div className="visualTitleText"><span>{v.title}</span>{v.format.subtitleVisible&&v.format.subtitle&&<small style={{color:v.format.subtitleColor,fontSize:v.format.subtitleFontSize}}>{v.format.subtitle}</small>}</div>{menuNode}</div>}
    {!v.format.showTitle&&v.format.visualHeader!==false&&<div className="visualHeaderOnly">{menuNode}</div>}
    {editing&&<div className="richTextToolbar" role="toolbar" aria-label="Text formatting" onMouseDown={event=>{if((event.target as HTMLElement).closest('button'))event.preventDefault();event.stopPropagation()}} onPointerDown={stopPointer} onClick={stopPointer}>
      <select aria-label="Font" defaultValue={v.format.fontFamily||'Segoe UI'} onChange={event=>command('fontName',event.target.value)}><option>Segoe UI</option><option>Aptos</option><option>Arial</option><option>Georgia</option><option>Inter</option><option>Roboto</option></select>
      <select aria-label="Text size" defaultValue="3" onChange={event=>command('fontSize',event.target.value)}><option value="1">10</option><option value="2">12</option><option value="3">14</option><option value="4">18</option><option value="5">24</option><option value="6">32</option><option value="7">48</option></select>
      <input aria-label="Text color" title="Text color" type="color" defaultValue={v.format.labelColor||'#242424'} onChange={event=>command('foreColor',event.target.value)}/>
      <button title="Bold" onClick={()=>command('bold')}><b>B</b></button><button title="Italic" onClick={()=>command('italic')}><i>I</i></button><button title="Underline" onClick={()=>command('underline')}><u>U</u></button>
      <span className="richTextDivider"/>
      <button title="Align left" onClick={()=>command('justifyLeft')}>≡</button><button className="alignCenterIcon" title="Align center" onClick={()=>command('justifyCenter')}>≡</button><button className="alignRightIcon" title="Align right" onClick={()=>command('justifyRight')}>≡</button>
      <button title="Bulleted list" onClick={()=>command('insertUnorderedList')}>• List</button><button title="Numbered list" onClick={()=>command('insertOrderedList')}>1. List</button><button title="Link" onClick={link}>↗</button>
      <button className="richTextDone" onClick={()=>{save();setEditing(false)}}>Done</button>
    </div>}
    <div className={'textBoxEditor align-'+(v.format.textVerticalAlign||'top')} style={{paddingTop:v.format.paddingTop??v.format.padding??8,paddingRight:v.format.paddingRight??v.format.padding??8,paddingBottom:v.format.paddingBottom??v.format.padding??8,paddingLeft:v.format.paddingLeft??v.format.padding??8}}>
      <div ref={editorRef} className="textBoxContent customScrollbar" contentEditable={editing} suppressContentEditableWarning role="textbox" aria-multiline="true" data-placeholder="Double-click to add text" style={{userSelect:'text',WebkitUserSelect:'text',fontSize:v.format.fontSize||18,color:v.format.labelColor||'#111827',fontFamily:v.format.fontFamily||'inherit',fontWeight:v.format.textFontWeight||400,fontStyle:v.format.textItalic?'italic':'normal',textDecoration:v.format.textUnderline?'underline':'none',textAlign:v.format.textAlign||'left',whiteSpace:v.format.textWrap===false?'pre':'pre-wrap',overflowWrap:v.format.textWrap===false?'normal':'anywhere',lineHeight:v.format.textLineHeight||1.45}} onInput={save} onBlur={save} onPaste={event=>{event.preventDefault();document.execCommand('insertText',false,event.clipboardData.getData('text/plain'))}} onMouseDown={stopWhenEditing} onPointerDown={stopWhenEditing} onMouseUp={rememberSelection} onKeyUp={rememberSelection} onKeyDown={stopPointer}/>
    </div>
  </div>;
}

function VisualCard({v,onSelect,selected,actionSelected,roleId,extraFilters,onSlicer,onChange,onDuplicate,onDelete,onAction,model,project,activeInteractionFilter,onDrillThrough,onCategoriesLoad}:{v:Visual,onSelect:(additive?:boolean)=>void,selected:boolean,actionSelected?:boolean,roleId?:string|null,extraFilters:VisualFilter[],onSlicer:(f:VisualFilter|null)=>void,onChange:(fn:(v:Visual)=>void)=>void,onDuplicate:()=>void,onDelete:()=>void,onAction:(v:Visual)=>void,model:any,project:any,activeInteractionFilter?:VisualFilter,onDrillThrough?:(pageId:string, filter:VisualFilter)=>void,onCategoriesLoad?:(id:string,cats:string[])=>void}){
  const[rows,setRows]=useState<any[]>([]),[err,setErr]=useState(''),[menu,setMenu]=useState(false),[menuAnchor,setMenuAnchor]=useState<DOMRect|null>(null),[focus,setFocus]=useState(false),[showData,setShowData]=useState(false),[slicerSelected,setSlicerSelected]=useState<string[]>([]),[slicerSearch,setSlicerSearch]=useState(''),[slicerDropdownOpen,setSlicerDropdownOpen]=useState(false),[conditionalValues,setConditionalValues]=useState<Record<string,any>>({});formatDefaults(v);
  const slicerDropdownRef=useRef<HTMLDivElement|null>(null);
  const capability=visualProfile(v.type);
  const hasDataBindings=v.type==='map'?!!((v.bindings.location||[]).length+(v.bindings.country||[]).length+(v.bindings.region||[]).length+(v.bindings.postalCode||[]).length+Math.min((v.bindings.latitude||[]).length,(v.bindings.longitude||[]).length)+(v.bindings.geometry||[]).length+(v.format.mapCustomGeometry?.features?.length||0)):v.type==='slicer'?!!(v.bindings.axis||[]).length:['table','matrix'].includes(v.type)?!!((v.bindings.axis||[]).length+(v.bindings.values||[]).length):!!(v.bindings.values||[]).length;
  // The caller excludes this slicer's own interaction filter while preserving report/page/other-slicer context.
  const slicerExtraFilters=extraFilters; // the caller already removes this slicer's own filter; keep page/report/other-slicer context
  useEffect(()=>{if(v.type==='textbox'||v.type==='button'||v.type==='image'||v.type==='shape'){setRows([]);setErr('');return}if(!hasDataBindings){setRows([]);return}
    queryVisual(v,project,roleId,slicerExtraFilters).then(r=>{setRows(r.rows);setErr('')}).catch(e=>setErr(e.message));
  },[JSON.stringify(v.bindings),JSON.stringify(v.filters),JSON.stringify(v.sort),JSON.stringify(v.drillFilters),v.drillLevel,JSON.stringify(slicerExtraFilters),JSON.stringify(project?.model?.measures||{}),v.type,roleId]);
  useEffect(()=>{
    if(!activeInteractionFilter) setSlicerSelected([]);
    else if(activeInteractionFilter.operator==='in') setSlicerSelected(activeInteractionFilter.value as string[]);
    else if(activeInteractionFilter.operator==='equals') setSlicerSelected([activeInteractionFilter.value as string]);
  },[activeInteractionFilter]);
  const closeMenu=()=>{setMenu(false);setMenuAnchor(null)};
  useEffect(()=>{if(!menu)return;const close=(event:Event)=>{const target=event.target as HTMLElement|null;if(target?.closest('.visualContextMenu,.visualMenuButton'))return;closeMenu()};const reposition=()=>closeMenu();document.addEventListener('pointerdown',close);window.addEventListener('resize',reposition);window.addEventListener('scroll',reposition,true);return()=>{document.removeEventListener('pointerdown',close);window.removeEventListener('resize',reposition);window.removeEventListener('scroll',reposition,true)}},[menu]);
  useEffect(()=>{if(!slicerDropdownOpen)return;const close=(event:PointerEvent)=>{if(!slicerDropdownRef.current?.contains(event.target as Node))setSlicerDropdownOpen(false)};const escape=(event:KeyboardEvent)=>{if(event.key==='Escape')setSlicerDropdownOpen(false)};document.addEventListener('pointerdown',close);document.addEventListener('keydown',escape);return()=>{document.removeEventListener('pointerdown',close);document.removeEventListener('keydown',escape)}},[slicerDropdownOpen]);
  useEffect(()=>{
    const visualMeasures=v.type==='map'?[]:(v.format.conditionalFormatRules||[]).filter(rule=>rule.enabled!==false&&rule.measure).map(rule=>rule.measure);
    const tableMeasures=Object.values(v.format.tableConditionalRules||{}).filter(rule=>rule.enabled!==false&&rule.formatBy==='fieldValue'&&rule.colorMeasure).map(rule=>rule.colorMeasure!);
    const measures=Array.from(new Set([...visualMeasures,...tableMeasures]));
    if(!measures.length){setConditionalValues({});return}
    const filters=[...(v.filters||[]),...(v.drillFilters||[]),...extraFilters].filter(f=>f.operator!=='top_n'&&!(f.operator==='in'&&(!Array.isArray(f.value)||!f.value.length)));
    let active=true;
    api<any>('/query-snapshot',{method:'POST',body:JSON.stringify({project,dimensions:[],measures,filters,sort:[],limit:1,roleId})}).then(result=>{if(active)setConditionalValues(result.rows?.[0]||{})}).catch(()=>{if(active)setConditionalValues({})});
    return()=>{active=false};
  },[JSON.stringify(v.format.conditionalFormatRules||[]),JSON.stringify(v.format.tableConditionalRules||{}),JSON.stringify(v.filters||[]),JSON.stringify(v.drillFilters||[]),JSON.stringify(extraFilters),JSON.stringify(project?.model?.measures||{}),roleId]);
  useEffect(()=>{
    if(rows.length>0&&onCategoriesLoad){
      const axis=v.bindings.axis?.[v.drillLevel||0]||v.bindings.axis?.slice(-1)[0]||v.bindings.legend?.[0];
      if(axis){
        const cats=Array.from(new Set(rows.map(r=>String(r[axis]||''))));
        onCategoriesLoad(v.id,cats);
      }
    }
  },[rows,v.bindings,v.id,onCategoriesLoad]);

  // Hooks must be called unconditionally
  const isSlicer = v.type === 'slicer';
  const slicerAxis = v.bindings.axis?.[0]||'';
  const slicerOptions = isSlicer ? rows.map(r=>String(r[slicerAxis])).filter((x,i,a)=>x&&a.indexOf(x)===i).filter(option=>!slicerSearch||option.toLowerCase().includes(slicerSearch.toLowerCase())) : [];
  
  useEffect(() => {
    if (v.type === 'slicer' && v.format.slicerSingleSelect) {
      if (slicerSelected.length !== 1 && slicerOptions.length > 0) {
        setSlicerSelected([slicerSelected[0] || slicerOptions[0]]);
        onSlicer({field:slicerAxis,operator:'equals',value:slicerSelected[0] || slicerOptions[0]});
      }
    }
  }, [v.type, v.format.slicerSingleSelect, slicerOptions.length, slicerSelected, slicerAxis, onSlicer]);

  // Maps own their per-region/per-bubble color pipeline. Generic visual-level
  // conditional formatting is intentionally ignored for maps so it cannot
  // conflict with Color grading or a bound color-returning measure.
  const displayFormat={...v.format,...(v.type==='map'?{}:resolveConditionalFormat(v.format.conditionalFormatRules,conditionalValues))};
  const displayVisual={...v,format:displayFormat};
  const bg=displayFormat.background||'#0d1724', trans=displayFormat.backgroundEnabled===false?100:Math.max(0,Math.min(100,displayFormat.backgroundTransparency||0));
  const titleBg=displayFormat.titleBackground||'#ffffff',titleTrans=displayFormat.titleBackgroundEnabled===false?100:Math.max(0,Math.min(100,displayFormat.titleBackgroundTransparency||0));
  const responsiveSizeClass=displayFormat.responsive===false?' visualFixed':(v.w<=260||v.h<=130?' visualCompact':v.w>=900?' visualWide':' visualStandard');
  const edges=displayFormat.borderEdges||{top:true,right:true,bottom:true,left:true};
  const border=displayFormat.borderVisible?`${displayFormat.borderWidth||1}px ${displayFormat.borderStyle||'solid'} ${displayFormat.borderColor||'#1f334a'}`:'0';
  const visualRadius=`${displayFormat.cornerRadii?.topLeft??displayFormat.cornerRadius??12}px ${displayFormat.cornerRadii?.topRight??displayFormat.cornerRadius??12}px ${displayFormat.cornerRadii?.bottomRight??displayFormat.cornerRadius??12}px ${displayFormat.cornerRadii?.bottomLeft??displayFormat.cornerRadius??12}px`;
  const style:any={
    border:'0',borderTop:edges.top?border:'0',borderRight:edges.right?border:'0',borderBottom:edges.bottom?border:'0',borderLeft:edges.left?border:'0',
    background:`color-mix(in srgb, ${bg} ${100-trans}%, transparent)`,visibility:v.hidden?'hidden':'visible',padding:0,fontFamily:`${displayFormat.fontFamily||'Aptos'}, 'Segoe UI Variable', 'Segoe UI', sans-serif`,borderRadius:visualRadius,boxShadow:displayFormat.shadow?`0 ${displayFormat.shadowOffset??12}px 32px color-mix(in srgb, ${displayFormat.shadowColor||'#0f172a'} 16%, transparent)`:'none',
    '--visual-background':`color-mix(in srgb, ${bg} ${100-trans}%, transparent)`,'--visual-title-background':`color-mix(in srgb, ${titleBg} ${100-titleTrans}%, transparent)`,'--visual-border-top':edges.top?border:'none','--visual-border-right':edges.right?border:'none','--visual-border-bottom':edges.bottom?border:'none','--visual-border-left':edges.left?border:'none','--visual-radius':visualRadius,'--visual-shadow':displayFormat.shadow?`0 ${displayFormat.shadowOffset??12}px 32px color-mix(in srgb, ${displayFormat.shadowColor||'#0f172a'} 16%, transparent)`:'none','--visual-title-color':displayFormat.titleColor||'#0f172a','--visual-padding-top':`${displayFormat.paddingTop??displayFormat.padding??8}px`,'--visual-padding-right':`${displayFormat.paddingRight??displayFormat.padding??8}px`,'--visual-padding-bottom':`${displayFormat.paddingBottom??displayFormat.padding??8}px`,'--visual-padding-left':`${displayFormat.paddingLeft??displayFormat.padding??8}px`
  };
  Object.assign(style,{'--visual-title-font':displayFormat.titleFontFamily||displayFormat.fontFamily||'Segoe UI','--visual-title-size':`${displayFormat.titleFontSize||12}px`,'--visual-title-weight':displayFormat.titleBold===false?400:(displayFormat.titleFontWeight||700),'--visual-title-align':displayFormat.titleAlignment||'left','--visual-title-style':displayFormat.titleFontStyle||'normal','--visual-title-decoration':displayFormat.titleUnderline?'underline':'none','--visual-title-wrap':displayFormat.titleWrap===false?'nowrap':'normal','--visual-subtitle-font':displayFormat.subtitleFontFamily||displayFormat.titleFontFamily||displayFormat.fontFamily||'Segoe UI','--visual-subtitle-size':`${displayFormat.subtitleFontSize||10}px`,'--visual-subtitle-color':displayFormat.subtitleColor||'#616161','--visual-subtitle-weight':displayFormat.subtitleBold?(displayFormat.subtitleFontWeight||700):400,'--visual-subtitle-align':displayFormat.subtitleAlignment||displayFormat.titleAlignment||'left','--visual-subtitle-style':displayFormat.subtitleFontStyle||'normal','--visual-subtitle-decoration':displayFormat.subtitleUnderline?'underline':'none','--visual-subtitle-wrap':displayFormat.subtitleWrap===false?'nowrap':'normal'});
  const titleTextStyle:any={fontFamily:displayFormat.titleFontFamily||displayFormat.fontFamily||'Segoe UI',fontSize:displayFormat.titleFontSize||12,color:displayFormat.titleColor||'#242424',fontWeight:displayFormat.titleBold===false?400:(displayFormat.titleFontWeight||700),fontStyle:displayFormat.titleFontStyle||'normal',textDecoration:displayFormat.titleUnderline?'underline':'none',whiteSpace:displayFormat.titleWrap===false?'nowrap':'normal',textAlign:displayFormat.titleAlignment||'left'};
  const subtitleTextStyle:any={fontFamily:displayFormat.subtitleFontFamily||displayFormat.titleFontFamily||displayFormat.fontFamily||'Segoe UI',fontSize:displayFormat.subtitleFontSize||10,color:displayFormat.subtitleColor||'#616161',fontWeight:displayFormat.subtitleBold?(displayFormat.subtitleFontWeight||700):400,fontStyle:displayFormat.subtitleFontStyle||'normal',textDecoration:displayFormat.subtitleUnderline?'underline':'none',whiteSpace:displayFormat.subtitleWrap===false?'nowrap':'normal',textAlign:displayFormat.subtitleAlignment||displayFormat.titleAlignment||'left'};
  const axisSortField=(v.bindings.axis||[]).slice(-1)[0]||'';
  const valueSortField=v.bindings.values?.[0]||'';
  const drillUp = () => {
    const level = v.drillLevel || 0;
    if (level > 0) {
      onChange(x => {
        x.drillLevel = level - 1;
        if (x.drillFilters && x.drillFilters.length > 0) x.drillFilters = x.drillFilters.slice(0, -1);
      });
    }
  };
  const drillDown = () => {
    const axis = v.bindings.axis || [];
    const level = v.drillLevel || 0;
    if (level < axis.length - 1) {
      onChange(x => { x.drillLevel = level + 1; });
    }
  };
    
const handlePointClick = (field: string, value: any) => {
      const axis = v.bindings.axis || [];
      const level = v.drillLevel || 0;
      // Only drill when the user has enabled drill mode (↓ arrow toggled on), just like Power BI.
      // When drill mode is off, clicks cross-filter other visuals on the page instead.
      if (v.drillModeActive && axis.length > 1 && level < axis.length - 1) {
        onChange(x => {
          x.drillLevel = level + 1;
          x.drillFilters = [...(x.drillFilters || []), { field, operator: 'equals', value }];
        });
      } else {
        onSlicer({ field, operator: 'equals', value });
      }
    };
    const setSort=(field:string,direction:'asc'|'desc')=>{if(field)onChange(x=>x.sort=[{field,direction}]);closeMenu()};
    const clearFilter=()=>{onChange(x=>x.filters=[]);closeMenu()};
    const drillPath = (v.drillFilters || []).map((f, i) => <span key={i} style={{cursor: "pointer", color: "#2563eb"}} onClick={() => onChange(x => { x.drillLevel = i; x.drillFilters = x.drillFilters!.slice(0, i); })}> {f.value} &gt; </span>);
    const targetPages = activeInteractionFilter ? (project.report.pages||[]).filter((p:Page) => p.id !== project.report.activePageId && p.drillThroughFields?.includes(activeInteractionFilter.field)) : [];
    const portalStyle:React.CSSProperties=(()=>{
      if(!menuAnchor)return{position:'fixed',right:10,top:50,zIndex:100000};
      const estimatedHeight=420,spaceBelow=window.innerHeight-menuAnchor.bottom,spaceAbove=menuAnchor.top;
      const position:React.CSSProperties={position:'fixed',zIndex:100000,maxHeight:Math.max(120,Math.min(estimatedHeight,Math.max(spaceBelow,spaceAbove)-16))};
      if(menuAnchor.right<250)position.left=Math.max(8,menuAnchor.left);else position.right=Math.max(8,window.innerWidth-menuAnchor.right);
      if(spaceBelow<280&&spaceAbove>spaceBelow)position.bottom=Math.max(8,window.innerHeight-menuAnchor.top+4);else position.top=Math.max(8,menuAnchor.bottom+4);
      return position;
    })();
    const menuNode=<div className="visualHeaderActions">
      {(v.bindings.axis?.length||0)>1&&v.format.headerDrillIcon!==false&&<div className="drillControls" title="Drill controls">
        <button disabled={(v.drillLevel||0)<=0} onMouseDown={e=>e.stopPropagation()} onClick={e=>{e.stopPropagation();drillUp()}} title="Drill up"><ArrowUpCircle size={15}/></button>
        <button className={v.drillModeActive ? 'active' : ''} onMouseDown={e=>e.stopPropagation()} onClick={e=>{e.stopPropagation();onChange(x=>{x.drillModeActive = !x.drillModeActive})}} title={v.drillModeActive ? "Click to turn off Drill down" : "Click to turn on Drill down"} style={{color: v.drillModeActive ? '#2563eb' : 'inherit', background: v.drillModeActive ? '#e2e8f0' : 'transparent', borderRadius: '4px'}}><ArrowDown size={15}/></button>
        <button disabled={(v.drillLevel||0)>=(v.bindings.axis?.length||1)-1} onMouseDown={e=>e.stopPropagation()} onClick={e=>{e.stopPropagation();drillDown()}} title="Expand all down one level in the hierarchy"><ChevronsDown size={15}/></button>
      </div>}
    {targetPages.length > 0 && activeInteractionFilter && onDrillThrough && <div className="drillControls" style={{padding: '0 6px', gap: '4px'}}>
      <span style={{fontSize: 9}}>Drill:</span>
      {targetPages.map((p:Page) => <button key={p.id} onMouseDown={e=>e.stopPropagation()} onClick={e=>{e.stopPropagation(); onDrillThrough(p.id, activeInteractionFilter);}} style={{padding:'2px 4px', fontSize:10, background:'#e2e8f0', color:'#0f172a', borderRadius:4, width:'auto', height:'auto'}}>{p.name}</button>)}
    </div>}
    <div className="visualMenuWrap">
    {v.format.headerFocusIcon!==false&&<button className="visualMenuButton" title="Focus mode" onClick={e=>{e.preventDefault();e.stopPropagation();setFocus(true)}}><Maximize2 size={15}/></button>}
    {v.format.headerMoreIcon!==false&&<button className="visualMenuButton" title="More options" onClick={e=>{e.preventDefault();e.stopPropagation();onSelect(false);if(menu)closeMenu();else{setMenuAnchor(e.currentTarget.getBoundingClientRect());setMenu(true)}}}><MoreHorizontal size={17}/></button>}
    {menu&&menuAnchor&&createPortal(<div className="visualContextMenu visualContextMenuPortal" style={portalStyle} onPointerDown={e=>e.stopPropagation()} onMouseDown={e=>e.stopPropagation()} onClick={e=>e.stopPropagation()}>
      {axisSortField&&<button onClick={()=>setSort(axisSortField,'asc')}><ArrowUpAZ size={14}/>Sort category ascending</button>}
      {axisSortField&&<button onClick={()=>setSort(axisSortField,'desc')}><ArrowDownAZ size={14}/>Sort category descending</button>}
      {valueSortField&&<button onClick={()=>setSort(valueSortField,'asc')}><ArrowUpAZ size={14}/>Sort value ascending</button>}
      {valueSortField&&<button onClick={()=>setSort(valueSortField,'desc')}><ArrowDownAZ size={14}/>Sort value descending</button>}
      {!!v.sort?.length&&<button onClick={()=>{onChange(x=>x.sort=[]);closeMenu()}}><RotateCcw size={14}/>Clear sort</button>}
      <button onClick={()=>{setFocus(true);closeMenu()}}><Maximize2 size={14}/>Focus mode</button>
      <button onClick={()=>{setShowData(true);closeMenu()}}><Eye size={14}/>Show underlying data</button>
      <button onClick={()=>{downloadCsv(rows,v.title);closeMenu()}}><Download size={14}/>Export CSV</button>
      <button onClick={()=>{downloadExcel(rows,v.title);closeMenu()}}><FileSpreadsheet size={14}/>Export Excel</button>
      <button onClick={()=>{downloadJson(rows,v.title);closeMenu()}}><FileJson size={14}/>Export JSON</button>
      <button onClick={()=>{navigator.clipboard?.writeText(JSON.stringify(v,null,2));closeMenu()}}><Clipboard size={14}/>Copy visual specification</button>
      <button onClick={()=>{onDuplicate();closeMenu()}}><Copy size={14}/>Duplicate visual</button>
      <hr style={{margin:'4px 0',borderColor:'var(--glass-border)',borderBottom:'none'}}/>
      <button className="danger" onClick={()=>{if(onDelete)onDelete();closeMenu()}}><Trash2 size={14}/>Delete visual</button>
      <button onClick={()=>{onChange(x=>x.format.showTitle=!x.format.showTitle);closeMenu()}}><Type size={14}/>{v.format.showTitle?'Hide':'Show'} title</button>
      {capability.legend&&<button onClick={()=>{onChange(x=>x.format.legendVisible=x.format.legendVisible===false?true:false);closeMenu()}}><Layers3 size={14}/>{v.format.legendVisible===false?'Show':'Hide'} legend</button>}
      {capability.dataLabels&&<button onClick={()=>{onChange(x=>x.format.dataLabels=!x.format.dataLabels);closeMenu()}}><Hash size={14}/>{v.format.dataLabels?'Hide':'Show'} data labels</button>}
      <button onClick={()=>{onSlicer(null);clearFilter()}}><Eraser size={14}/>Clear selection / filter</button>
    </div>,document.body)}
    </div>
  </div>;
  const designerHandle=null;
  if(v.type==='textbox')return <RichTextBox v={displayVisual} selected={selected} onSelect={onSelect} onChange={onChange} style={style} designerHandle={designerHandle} menuNode={menuNode} responsiveSizeClass={responsiveSizeClass}/>;
  if(v.type==='image')return <div role="img" aria-label={displayFormat.altText||v.imageName||v.title} onMouseDown={e=>onSelect(e.ctrlKey||e.metaKey||e.shiftKey)} className={'visualCard mediaVisual imageVisual '+responsiveSizeClass+(selected?' selected':'')+(v.hidden?' authorHidden':'')} style={{...style,display:'flex',flexDirection:'column'}}>
    {displayFormat.showTitle&&<div className="visualTitle visualMoveZone"><div className="visualTitleText"><span style={titleTextStyle}>{v.title}</span>{displayFormat.subtitleVisible&&displayFormat.subtitle&&<small style={subtitleTextStyle}>{displayFormat.subtitle}</small>}</div>{displayFormat.visualHeader!==false&&menuNode}</div>}
    {!displayFormat.showTitle&&displayFormat.visualHeader!==false&&<div className="visualHeaderOnly">{menuNode}</div>}
    <div className="mediaVisualBody">{v.imageSrc?<img src={v.imageSrc} alt={displayFormat.altText||v.imageName||''} draggable={false} style={{objectFit:displayFormat.imageFit||'contain',opacity:(displayFormat.imageOpacity??100)/100}}/>:<div className="mediaVisualEmpty"><ImageIcon size={28}/><span>Select this visual and choose an image</span></div>}</div>
  </div>;
  if(v.type==='shape')return <div role="img" aria-label={displayFormat.altText||`${displayFormat.shapeType||'rectangle'} shape`} onMouseDown={e=>onSelect(e.ctrlKey||e.metaKey||e.shiftKey)} className={'shapeObject '+responsiveSizeClass+(v.hidden?' authorHidden':'')} style={{visibility:v.hidden?'hidden':'visible'}}><ShapeArtwork format={displayFormat}/></div>;
  if(v.type==='button')return <div role="group" aria-label={v.format.altTextEnabled&&v.format.altText?v.format.altText:(v.buttonLabel||'Action Button')} onMouseDown={e=>onSelect(e.ctrlKey||e.metaKey||e.shiftKey)} className={'visualCard buttonVisualContainer '+responsiveSizeClass+(selected?' selected':'')+(v.hidden?' authorHidden':'')+(v.format.showTitle?' buttonTitleVisible':' buttonTitleHidden')} style={{...style,display:'flex',flexDirection:'column'}}>
    {displayFormat.showTitle&&<div className="visualTitle visualMoveZone"><div className="visualTitleText"><span style={titleTextStyle}>{v.title}</span>{displayFormat.subtitleVisible&&displayFormat.subtitle&&<small style={subtitleTextStyle}>{displayFormat.subtitle}</small>}</div>{displayFormat.visualHeader!==false&&menuNode}</div>}
    {!displayFormat.showTitle&&displayFormat.visualHeader!==false&&<div className="visualHeaderOnly">{menuNode}</div>}
    <button type="button" aria-pressed={displayFormat.buttonSelectionEnabled!==false?actionSelected:undefined} title="Click to select and run the action. Ctrl+click only selects the visual." onClick={e=>{e.stopPropagation();onSelect(e.ctrlKey||e.metaKey||e.shiftKey);if(!e.ctrlKey&&!e.metaKey&&!e.shiftKey&&(displayFormat.buttonSelectionEnabled!==false||(v.action&&v.action.type!=='none')))onAction(v)}} className={'reportActionButton authoringActionButton buttonVisualOnly'+(actionSelected?' actionSelected':'')} style={{flex:1,background:actionSelected?(displayFormat.buttonSelectedBackground||'#16a34a'):(displayFormat.buttonBackground||'#6b7280'),color:actionSelected?(displayFormat.buttonSelectedTextColor||'#ffffff'):(displayFormat.buttonTextColor||'#ffffff'),fontSize:displayFormat.buttonFontSize||12,borderRadius:displayFormat.buttonCornerRadius??6,border:displayFormat.buttonBorderVisible?'1px solid '+(actionSelected?(displayFormat.buttonSelectedBorderColor||'#15803d'):(displayFormat.buttonBorderColor||'#4b5563')):'none'}}><MousePointerClick size={16}/>{v.buttonLabel||'Action Button'}</button>
  </div>;

  if(v.type==='slicer'){
    const axis=v.bindings.axis?.[0]||'';
    const mode=v.slicerStyle||'list';
    const allOptions=rows.map(r=>String(r[axis])).filter((x,i,a)=>x&&a.indexOf(x)===i);
    const options=allOptions.filter(option=>!slicerSearch||option.toLowerCase().includes(slicerSearch.toLowerCase()));
    const apply=(next:string[], isSelectAll?: boolean)=>{
      setSlicerSelected(next);
      if (isSelectAll || !next.length) {
        onSlicer(null);
      } else {
        onSlicer({field:axis,operator:next.length===1?'equals':'in',value:next.length===1?next[0]:next});
      }
    };
    const choose=(val:string)=>{const single=v.format.slicerSingleSelect||!v.format.slicerMultiSelect;const next=single?(slicerSelected.includes(val)?[]:[val]):slicerSelected.includes(val)?slicerSelected.filter(x=>x!==val):[...slicerSelected,val];apply(next);if(single)setSlicerDropdownOpen(false)};
    const clearSlicer=()=>{setSlicerSelected([]);setSlicerSearch('');setSlicerDropdownOpen(false);onSlicer(null)};

    const tilesPerRow=v.format.tilesPerRow||3;
    const tilesPerColumn=v.format.tilesPerColumn||0;
    const gridStyle:any={gridTemplateColumns:`repeat(${tilesPerRow}, 1fr)`};
    if(tilesPerColumn>0)gridStyle.gridTemplateRows=`repeat(${tilesPerColumn}, 1fr)`;
    const allSelected=Boolean(v.format.slicerSelectAll&&!v.format.slicerSingleSelect&&v.format.slicerMultiSelect&&allOptions.length>1&&allOptions.every(option=>slicerSelected.includes(option)));
    const slicerStyle:any={...style,'--slicer-font':displayFormat.tableFontFamily||'Segoe UI','--slicer-text':displayFormat.tableTextColor||'#242424','--slicer-size':`${displayFormat.tableFontSize||11}px`,'--slicer-weight':displayFormat.tableTextBold?700:400,'--slicer-style':displayFormat.tableTextItalic?'italic':'normal','--slicer-wrap':displayFormat.tableTextWrap?'normal':'nowrap','--slicer-align':displayFormat.tableTextAlign||'left','--slicer-bg':displayFormat.tableBackground||'#ffffff','--slicer-alt':displayFormat.tableAlternatingRows===false?(displayFormat.tableBackground||'#ffffff'):(displayFormat.tableAlternateColor||'#f8fafc'),'--slicer-row-padding':`${displayFormat.tableRowPadding??8}px`};
    const selectionLabel=!slicerSelected.length||allSelected?'All':slicerSelected.length===1?slicerSelected[0]:slicerSelected.length<=2?slicerSelected.join(', '):'(Multiple items)';
    const dropdown=<div className="slicerDropdownShell" ref={slicerDropdownRef}>
      <button type="button" className="slicerDropdownTrigger" aria-haspopup="listbox" aria-expanded={slicerDropdownOpen} onMouseDown={e=>e.stopPropagation()} onClick={e=>{e.stopPropagation();setSlicerDropdownOpen(open=>!open)}}><span>{selectionLabel}</span><ChevronDown size={15}/></button>
      {slicerDropdownOpen&&<div className="slicerDropdownMenu" role="listbox" aria-multiselectable={!v.format.slicerSingleSelect} onMouseDown={e=>e.stopPropagation()}>
        {v.format.slicerSearch&&<div className="slicerSearchRow"><Search size={14}/><input value={slicerSearch} onChange={e=>setSlicerSearch(e.target.value)} placeholder="Search values" aria-label="Search slicer values" autoFocus/>{slicerSearch&&<button type="button" title="Clear search" onClick={()=>setSlicerSearch('')}><X size={13}/></button>}</div>}
        <div className="slicerDropdownOptions customScrollbar">
          {v.format.slicerSelectAll&&!v.format.slicerSingleSelect&&<label className="slicerListItem slicerSelectAll"><input type="checkbox" checked={allSelected} onChange={e=>{e.stopPropagation();apply(allSelected?[]:allOptions,!allSelected)}}/><span>Select all</span></label>}
          {options.map(val=><label key={val} className={'slicerListItem'+(slicerSelected.includes(val)?' active':'')}><input type={(v.format.slicerSingleSelect||!v.format.slicerMultiSelect)?'radio':'checkbox'} checked={slicerSelected.includes(val)} onChange={e=>{e.stopPropagation();choose(val)}}/><span>{val}</span></label>)}
          {!options.length&&<div className="slicerNoResults">No matching values</div>}
        </div>
      </div>}
    </div>;
    return <div role="group" aria-label={v.format.altTextEnabled&&v.format.altText?v.format.altText:v.title} onMouseDown={e=>onSelect(e.ctrlKey||e.metaKey||e.shiftKey)} className={'visualCard slicerVisual '+responsiveSizeClass+(selected?' selected':'')+(menu?' menuOpen':'')+(slicerDropdownOpen?' slicerDropdownOpen':'')} style={{...slicerStyle,overflow:slicerDropdownOpen?'visible':undefined}}>
      {designerHandle}
      {displayFormat.showTitle&&<div className="visualTitle visualMoveZone"><div className="visualTitleText"><span style={titleTextStyle}>{v.title}</span>{displayFormat.subtitleVisible&&displayFormat.subtitle&&<small style={subtitleTextStyle}>{displayFormat.subtitle}</small>}</div><div className="slicerHeaderActions">{!!slicerSelected.length&&<button className="slicerClearButton" title="Clear slicer" onClick={e=>{e.stopPropagation();clearSlicer()}}><Eraser size={14}/></button>}{displayFormat.visualHeader!==false&&menuNode}</div></div>}
      {!v.format.showTitle&&v.format.visualHeader!==false&&<div className="visualHeaderOnly">{!!slicerSelected.length&&<button className="slicerClearButton" title="Clear slicer" onClick={e=>{e.stopPropagation();clearSlicer()}}><Eraser size={14}/></button>}{menuNode}</div>}
      {mode!=='dropdown'&&v.format.slicerSearch&&<div className="slicerSearchRow slicerInlineSearch"><Search size={14}/><input value={slicerSearch} onChange={e=>setSlicerSearch(e.target.value)} onMouseDown={e=>e.stopPropagation()} placeholder="Search values" aria-label="Search slicer values"/>{slicerSearch&&<button type="button" title="Clear search" onClick={()=>setSlicerSearch('')}><X size={13}/></button>}</div>}
      {mode==='dropdown'?dropdown:mode==='list'?<div className={'slicerList slicer-list orientation-'+(v.format.slicerOrientation||'vertical')} style={{'--slicer-text':v.format.tableTextColor||'#242424','--slicer-size':`${v.format.tableFontSize||11}px`,'--slicer-bg':v.format.tableBackground||'#ffffff','--slicer-alt':v.format.tableAlternatingRows===false?(v.format.tableBackground||'#ffffff'):(v.format.tableAlternateColor||'#f8fafc'),textAlign:v.format.tableTextAlign} as any}>{v.format.slicerSelectAll&&!v.format.slicerSingleSelect&&<label className="slicerListItem"><input type="checkbox" checked={allSelected} onChange={e=>{e.stopPropagation();apply(allSelected?[]:allOptions, !allSelected)}}/><span>Select all</span></label>}{options.map(val=><label key={val} className="slicerListItem"><input type={(v.format.slicerSingleSelect||!v.format.slicerMultiSelect)?'radio':'checkbox'} checked={slicerSelected.includes(val)} onChange={e=>{e.stopPropagation();choose(val)}}/><span>{val}</span></label>)}</div>:<div className={'slicerList slicer-'+mode+' orientation-'+(v.format.slicerOrientation||'vertical')} style={{...(mode==='button'?gridStyle:{}),'--slicer-text':v.format.tableTextColor||'#242424','--slicer-size':`${v.format.tableFontSize||11}px`,'--slicer-bg':v.format.tableBackground||'#ffffff','--slicer-alt':v.format.tableAlternateColor||'#f8fafc',textAlign:v.format.tableTextAlign} as any}>{v.format.slicerSelectAll&&!v.format.slicerSingleSelect&&<button className={allSelected?'active':''} style={{borderRadius:v.format.slicerCornerRadius??6}} onClick={e=>{e.stopPropagation();apply(allSelected?[]:allOptions, !allSelected)}}>Select all</button>}{options.map(val=><button key={val} className={slicerSelected.includes(val)?'active':''} style={{borderRadius:v.format.slicerCornerRadius??6}} onClick={e=>{e.stopPropagation();choose(val)}}>{val}</button>)}</div>}
    </div>
  }
  const card=<div role="group" aria-label={displayFormat.altTextEnabled&&displayFormat.altText?displayFormat.altText:v.title} onMouseDown={e=>onSelect(e.ctrlKey||e.metaKey||e.shiftKey)} className={'visualCard premiumVisualCard '+responsiveSizeClass+(selected?' selected':'')+(menu?' menuOpen':'')} style={{...style, display:'flex', flexDirection:'column'}}>{designerHandle}{displayFormat.showTitle&&<div className="visualTitle visualMoveZone"><div className="visualTitleText">{drillPath.length>0&&<span className="drillPath">{drillPath}</span>}<span style={titleTextStyle}>{v.title}</span>{displayFormat.subtitleVisible&&displayFormat.subtitle&&<small style={subtitleTextStyle}>{displayFormat.subtitle}</small>}</div>{displayFormat.visualHeader!==false&&menuNode}</div>}{!displayFormat.showTitle&&displayFormat.visualHeader!==false&&<div className="visualHeaderOnly">{menuNode}</div>}<div className="visualBody" style={{paddingTop:displayFormat.paddingTop??displayFormat.padding??8,paddingRight:displayFormat.paddingRight??displayFormat.padding??8,paddingBottom:displayFormat.paddingBottom??displayFormat.padding??8,paddingLeft:displayFormat.paddingLeft??displayFormat.padding??8, flex:1, minHeight:0, display:'flex', flexDirection:'column'}}>{err?<div className="empty compact">{err}</div>:!hasDataBindings?<div className="visualEmpty"><Sparkles size={20}/><b>Add data to this visual</b><span>Choose a field in Data or drag it to a field well.</span></div>:<Chart visual={displayVisual} rows={rows} conditionalValues={conditionalValues} onPointClick={handlePointClick}/>}</div></div>;
  const overlay=(focus||showData)&&createPortal(<div className="visualFocusBackdrop" onMouseDown={()=>{setFocus(false);setShowData(false)}}><div className="visualFocusPanel" onMouseDown={e=>e.stopPropagation()}><div className="visualFocusHeader"><div><small>{showData?'UNDERLYING DATA':'FOCUS MODE'}</small><b>{drillPath.length>0&&<span className="drillPath" style={{marginRight:8}}>{drillPath}</span>}{v.title}</b></div><button onClick={()=>{setFocus(false);setShowData(false)}}>Close</button></div><div className="visualFocusBody">{err?<div className="empty compact">{err}</div>:showData?<div className="underlyingDataTable"><table><thead><tr>{rows.length&&Object.keys(rows[0]).map(c=><th key={c}>{c}</th>)}</tr></thead><tbody>{rows.slice(0,500).map((r,i)=><tr key={i}>{Object.keys(r).map(c=><td key={c}>{String(r[c]??'')}</td>)}</tr>)}</tbody></table></div>:<Chart visual={displayVisual} rows={rows} conditionalValues={conditionalValues} onPointClick={handlePointClick}/>}</div></div></div>,document.body);
  return <>{card}{overlay}</>;
}

function Fields({project,onCollapse,onAutoBind,selectedBindings}:{project:any,onCollapse?:()=>void,onAutoBind?:(payload:string)=>void,selectedBindings?:Visual['bindings']}){
  const{setView}=useStudio();const[search,setSearch]=useState('');const start=(e:any,payload:string)=>beginReportFieldDrag(payload,e);
  const hierarchies=project.model.hierarchies||[];
  const boundFields=new Set(['axis','values','target','tooltips','legend','min','max'].flatMap(k=>(selectedBindings as any)?.[k]||[]));
  const isNumericCol=(t:string,c:string)=>{
    const typ=String(project.model.columnTypes?.[`${t}.${c}`]||'').toLowerCase();
    return /^(u?int\d*|integer|bigint|smallint|tinyint|float\d*|double|double precision|decimal|numeric|number|real|money|currency)$/.test(typ)
      ||/(amount|revenue|cost|qty|quantity|price|points|number|count|total|target|latitude|longitude|salary|age|score|rate|percent|ratio|value|weight|height|budget|spend|profit|loss|sales|units|days)/i.test(c);
  };
  const measures=Object.keys(project.model.measures||{}).filter(m=>m.toLowerCase().includes(search.toLowerCase()));
  return <div className="fieldsPane advancedFields"><div className="paneTitle"><span>Data</span><small>{Object.keys(project.model.tables).length} tables</small>{onCollapse&&<button className="dockCollapseButton" title="Collapse Data pane" onClick={onCollapse} aria-label="Action"><PanelRightClose size={14}/></button>}</div><input className="fieldSearch" placeholder="Search data" value={search} onChange={e=>setSearch(e.target.value)}/>{Object.entries<any>(project.model.tables).filter(([t,x])=>{const query=search.toLowerCase();if(!query)return true;if(t.toLowerCase().includes(query))return true;if(hierarchies.some((h:any)=>h.table===t&&h.name.toLowerCase().includes(query)))return true;if(Object.keys(x.columns).some(c=>(t+c).toLowerCase().includes(query)))return true;return false;}).map(([t,x])=>{const query=search.toLowerCase();const tableMatches=t.toLowerCase().includes(query);return <details key={t} open={!!search}><summary><span className="tableGlyph">T</span><b className="tableName">{t}</b></summary>{hierarchies.filter((h:any)=>h.table===t&&(tableMatches||!search||h.name.toLowerCase().includes(query))).map((h:any)=><div onPointerDown={e=>start(e,'hierarchy:'+h.id)} onMouseDown={e=>start(e,'hierarchy:'+h.id)} className="field hierarchyField" key={h.id}><GitBranch size={13}/><div><b>{h.name}</b><small>{h.levels.map((l:any)=>l.name).join(' › ')}</small></div></div>)}{Object.keys(x.columns).filter(c=>tableMatches||!search||(t+c).toLowerCase().includes(query)).map(c=>{const numeric=isNumericCol(t,c);const colType=project.model.columnTypes?.[`${t}.${c}`];const isDate=colType==='date'||colType==='datetime'||colType==='timestamp';const prefix=numeric?'numericField:':'field:';const payload=prefix+t+'.'+c;const typeLabel=isDate?'D':numeric?'#':'Aa';const isBound=boundFields.has(t+'.'+c);const cls='field'+(numeric?' numericField':'')+(isBound?' boundField':'');
if (isDate) {
  const parts = ['Year', 'Quarter', 'Month', 'Day'];
  return (
    <details key={c} className="dateHierarchyDetails">
      <summary>
        <ChevronRight size={14} className="date-caret" />
        <div className={cls} onClick={(e)=>{e.preventDefault();onAutoBind?.(payload)}} onPointerDown={e=>start(e,payload)} onMouseDown={e=>start(e,payload)}>
          <span className="fieldCheck">{isBound?'✓':''}</span>
          <span className="fieldType dateType">{typeLabel}</span>
          <span className="fieldName">{c}</span>
        </div>
      </summary>
      <details open className="dateHierarchyDetailsInner">
        <summary>
          <ChevronRight size={14} className="date-caret" />
          <div className="field hierarchyField" style={{border: 'none'}}>
            <GitBranch size={13} />
            <span className="fieldName">Date Hierarchy</span>
          </div>
        </summary>
        <div className="dateHierarchyChildren">
          {parts.map(p => {
             const subPayload = payload + '::' + p;
             const isSubBound = boundFields.has(t+'.'+c+'::'+p);
             const subCls = 'field' + (isSubBound ? ' boundField' : '');
             return <div role="button" tabIndex={0} key={p} className={subCls} onPointerDown={e=>start(e,subPayload)} onMouseDown={e=>start(e,subPayload)} onClick={()=>onAutoBind?.(subPayload)}>
               <span className="fieldCheck">{isSubBound?'✓':''}</span>
               <span className="fieldType" style={{opacity: 0}} />
               <span className="fieldName">{p}</span>
             </div>
           })}
        </div>
      </details>
    </details>
  )
}
return <div role="button" tabIndex={0} title="Click to add automatically, or drag to a field well" onClick={()=>onAutoBind?.(payload)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();onAutoBind?.(payload)}}} onPointerDown={e=>start(e,payload)} onMouseDown={e=>start(e,payload)} className={cls} key={c}><span className="fieldCheck">{isBound?'✓':''}</span><span className={'fieldType '+(isDate?'dateType':numeric?'numberType':'textType')}>{typeLabel}</span><span className="fieldName">{c}</span></div>
})}</details>})}<details open><summary><span className="measureGlyph">Σ</span><b>Measures</b><small>{Object.keys(project.model.measures||{}).length}</small></summary>{measures.map(m=>{const isBound=boundFields.has(m);return <div role="button" tabIndex={0} title="Click to add automatically, or drag to a field well" onClick={()=>onAutoBind?.('measure:'+m)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();onAutoBind?.('measure:'+m)}}} onPointerDown={e=>start(e,'measure:'+m)} onMouseDown={e=>start(e,'measure:'+m)} className={'field measure'+(isBound?' boundField':'')} key={m}><span className="fieldCheck">{isBound?'✓':''}</span><span>∑</span>{m}</div>})}{!Object.keys(project.model.measures||{}).length&&<div className="measuresEmptyState"><b>No measures yet</b><span>Create and validate a measure before adding it to a visual.</span><button onClick={()=>setView('measures')}>Create a measure</button></div>}</details></div>;
}
function Well({title,items,onDrop,onRemove,onMove,onRename,displayNames,accept,visualType,wellKey,isNumericField,isMeasureField}:{title:string,items:string[],onDrop:(v:string)=>void,onRemove:(v:string)=>void,onMove:(v:string,direction:-1|1)=>void,onRename?:(v:string,name:string)=>void,displayNames?:Record<string,string>,accept:'field'|'measure'|'value',visualType?:string,wellKey?:string,isNumericField?:(f:string)=>boolean,isMeasureField?:(f:string)=>boolean}){
  const ref=useRef<HTMLDivElement|null>(null);
  const [menu, setMenu] = useState<{x:string,rect:DOMRect}|null>(null);
  const [editing, setEditing] = useState<string|null>(null);
  const hint=accept==='measure'?'measure or numeric column':accept==='value'?'measure or numeric column':'field';
  const commit=(raw:string)=>{if(!raw)return;const now=Date.now();if(reportFieldLastDropRaw===raw&&now-reportFieldLastDropAt<180)return;reportFieldLastDropRaw=raw;reportFieldLastDropAt=now;const[prefix,...rest]=raw.split(':');const payload=rest.join(':');
    if(accept==='value'&&(prefix==='measure'||prefix==='numericField'||prefix==='field'))onDrop(payload);
    else if(accept==='field'&&(prefix==='field'||prefix==='numericField'))onDrop(payload);
    else if(accept==='field'&&prefix==='hierarchy')onDrop('@@HIERARCHY@@'+payload);
    else if(accept==='field'&&prefix==='measure')onDrop(payload);
    else if(accept==='measure'&&(prefix==='measure'||prefix==='numericField'))onDrop(payload);
  };
  useEffect(()=>{const el=ref.current;if(!el)return;const handler=(e:Event)=>{commit((e as CustomEvent<{raw:string}>).detail?.raw||'')};el.addEventListener('vtab-report-field-drop',handler);return()=>el.removeEventListener('vtab-report-field-drop',handler)});
  useEffect(() => {
    if(!menu)return;
    const close=()=>setMenu(null);
    document.addEventListener('pointerdown',close);
    return()=>document.removeEventListener('pointerdown',close);
  }, [menu]);
  const selectAggregation = (x: string, suffix: string) => {
    const core = x.split('::')[0];
    const newField = suffix ? `${core}::${suffix}` : core;
    onDrop(newField); 
    onRemove(x);
    setMenu(null);
  };
  // Show aggregation dropdown for: (a) value/measure wells, OR (b) table axis well with a numeric/integer column
  const showDropdownForField = (x: string): boolean => {
    if (accept === 'value' || accept === 'measure') return true;
    if (visualType === 'table' && wellKey === 'axis' && isNumericField) {
      return isNumericField(x);
    }
    return false;
  };
  // For table axis numeric fields: determine current state (no suffix = "do not summarise")
  const isTableAxisNumeric = (x: string) => visualType === 'table' && wellKey === 'axis' && isNumericField && isNumericField(x);
  const isTableMeasure = (x: string) => visualType === 'table' && isMeasureField && isMeasureField(x);
  return <div ref={ref} data-report-field-drop="true" className="well dropWell" onPointerUp={e=>{if(reportFieldDragPayload){e.preventDefault();commit(reportFieldDragPayload);clearReportFieldDragPayload()}}} onMouseUp={e=>{if(reportFieldDragPayload){e.preventDefault();commit(reportFieldDragPayload);clearReportFieldDragPayload()}}} onDragEnter={e=>{e.preventDefault();e.dataTransfer.dropEffect='copy'}} onDragOver={e=>{e.preventDefault();e.dataTransfer.dropEffect='copy'}} onDrop={e=>{e.preventDefault();commit(e.dataTransfer.getData('application/x-vtab-field')||e.dataTransfer.getData('text/plain')||reportFieldDragPayload);clearReportFieldDragPayload()}}>
    <div className="wellLabel"><span>{title}</span><small>{items.length}</small></div>
    {items.map((x,i)=>{
      const isAggr = accept==='value' || accept==='measure';
      const core = x.split('::')[0];
      const currentAgg = x.split('::')[1] || (isAggr ? 'sum' : '');
      const tableAxisNum = isTableAxisNumeric(x);
      const tableAxisAgg = x.split('::')[1];
      // Label: for table axis numeric, show aggregation prefix if set, otherwise show field name (Do not summarise)
      let fieldLabel = (tableAxisNum || isTableMeasure(x)) ? (tableAxisAgg && !isTableMeasure(x) ? `${tableAxisAgg} of ${core}` : core) : (x.includes('::') && !isMeasureField?.(x) ? `${currentAgg} of ${core}` : core); if (displayNames && displayNames[x]) fieldLabel = displayNames[x]; return <b key={x}>{editing===x ? <input type="text" autoFocus defaultValue={displayNames?.[x]||fieldLabel} placeholder={core} onKeyDown={e=>{if(e.key==="Enter"){onRename?.(x,e.currentTarget.value);setEditing(null)}}} onBlur={e=>{onRename?.(x,e.currentTarget.value);setEditing(null)}} onClick={e=>e.stopPropagation()} onDoubleClick={e=>e.stopPropagation()} style={{width:"100%",background:"transparent",border:"none",outline:"none",fontSize:11,margin:0,padding:0,color:"inherit"}} /> : <span onDoubleClick={(e)=>{e.stopPropagation();if(onRename)setEditing(x)}} style={{cursor:"text",flex:1,overflow:"hidden",textOverflow:"ellipsis",userSelect:"none"}}>{fieldLabel}</span>}<span className="wellItemActions"><button title="Field options" onClick={e=>{e.stopPropagation();setMenu({x,rect:e.currentTarget.getBoundingClientRect()})}}><ChevronDown size={12}/></button><button disabled={i===0} title="Move up" onClick={e=>{e.stopPropagation();onMove(x,-1)}}> </button><button disabled={i===items.length-1} title="Move down" onClick={e=>{e.stopPropagation();onMove(x,1)}}> </button><button title="Remove field" onClick={e=>{e.stopPropagation();onRemove(x)}}>x</button></span></b>; })} {!items.length&&<em>Drop {hint} here</em>} {menu && createPortal(<div className="fieldOptionsDropdown" style={{top: menu.rect.bottom + 300 > window.innerHeight ? menu.rect.top - 230 : menu.rect.bottom, left: menu.rect.left - 100}} onPointerDown={e=>e.stopPropagation()}> {onRename && <div style={{padding:'8px 12px', borderBottom:'1px solid #e2e8f0', marginBottom:4}}><label style={{display:'block', fontSize:11, color:'#64748b', marginBottom:4}}>Display name</label><input type="text" autoFocus defaultValue={displayNames?.[menu.x] || ''} placeholder={menu.x.split('::')[0]} onKeyDown={e=>{if(e.key==='Enter'){onRename(menu.x, e.currentTarget.value);setMenu(null);}}} onBlur={e=>{onRename(menu.x, e.currentTarget.value);}} style={{width:'100%', boxSizing:'border-box', border:'1px solid #cbd5e1', borderRadius:4, padding:'4px 8px', fontSize:12, outline:'none'}} /></div>} {showDropdownForField(menu.x) && <><div style={{padding:'4px 8px', fontSize:10, color:'#64748b', fontWeight:600}}>{isTableAxisNumeric(menu.x) || isTableMeasure(menu.x) ? 'SUMMARIZATION' : 'AGGREGATION'}</div>
         {(isTableAxisNumeric(menu.x) || isTableMeasure(menu.x)) && <button className={(!menu.x.includes('::') || isTableMeasure(menu.x))?'active':''} onClick={()=>selectAggregation(menu.x, '')}>Don&apos;t summarize</button>}
         <button disabled={isTableMeasure(menu.x)} className={(!isTableAxisNumeric(menu.x)&&!isTableMeasure(menu.x)&&(!menu.x.includes('::')||menu.x.endsWith('::sum')))||(isTableAxisNumeric(menu.x)&&menu.x.endsWith('::sum'))?'active':''} onClick={()=>selectAggregation(menu.x, 'sum')}>Sum</button>
         <button disabled={isTableMeasure(menu.x)} className={menu.x.endsWith('::average')?'active':''} onClick={()=>selectAggregation(menu.x, 'average')}>Average</button>
         <button disabled={isTableMeasure(menu.x)} className={menu.x.endsWith('::min')?'active':''} onClick={()=>selectAggregation(menu.x, 'min')}>Minimum</button>
         <button disabled={isTableMeasure(menu.x)} className={menu.x.endsWith('::max')?'active':''} onClick={()=>selectAggregation(menu.x, 'max')}>Maximum</button>
         <button disabled={isTableMeasure(menu.x)} className={menu.x.endsWith('::count')?'active':''} onClick={()=>selectAggregation(menu.x, 'count')}>Count</button>
         <button disabled={isTableMeasure(menu.x)} className={menu.x.endsWith('::count_distinct')?'active':''} onClick={()=>selectAggregation(menu.x, 'count_distinct')}>Count (Distinct)</button></>}</div>,
      document.body
    )}
  </div>;
}
function Section({title,icon,children,open=false}:{title:string,icon?:any,children:any,open?:boolean}){return <details className="formatSection" open={open} onToggle={e=>{if(e.currentTarget.open)requestAnimationFrame(()=>e.currentTarget.scrollIntoView({block:'nearest',behavior:'smooth'}))}}><summary>{icon}{title}<span>⌄</span></summary><div className="formatSectionBody">{children}</div></details>}
function Toggle({label,value,onChange}:{label:string,value:boolean,onChange:(v:boolean)=>void}){return <label className="switchRow"><span>{label}</span><input type="checkbox" checked={value} onChange={e=>onChange(e.target.checked)}/></label>}
function CustomActionSteps({visual,page,updateVisual}:{visual:Visual,page:Page,updateVisual:(fn:(v:Visual)=>void)=>void}){
  const steps=visual.action?.steps||[];
  const groups=Array.from(new Set(page.visuals.map(item=>item.groupId?.trim()).filter(Boolean) as string[]));
  const save=(next:VisualActionStep[])=>updateVisual(v=>v.action={...(v.action||{}),type:'custom',steps:next});
  const change=(index:number,changes:Partial<VisualActionStep>)=>save(steps.map((step,i)=>i===index?{...step,...changes}:step));
  return <div className="customActionSteps"><div className="formatHint">All configured steps run together from one button click.</div>{steps.map((step,index)=><div className="customActionStep" key={index}>
    <select aria-label="Operation" value={step.operation} onChange={e=>change(index,{operation:e.target.value as VisualActionStep['operation']})}><option value="show">Show</option><option value="hide">Hide</option><option value="toggle">Toggle</option></select>
    <select aria-label="Target type" value={step.targetType} onChange={e=>change(index,{targetType:e.target.value as VisualActionStep['targetType'],targetId:''})}><option value="visual">Visual</option><option value="group">Group</option></select>
    <select aria-label="Target" value={step.targetId} onChange={e=>change(index,{targetId:e.target.value})}><option value="">Select target</option>{step.targetType==='group'?groups.map(group=><option key={group} value={group}>{group}</option>):page.visuals.filter(item=>item.id!==visual.id).map(item=><option key={item.id} value={item.id}>{item.title||visualLabels[item.type]}</option>)}</select>
    <button title="Remove action" onClick={()=>save(steps.filter((_,i)=>i!==index))}>×</button>
  </div>)}{!steps.length&&<div className="customActionEmpty">No steps yet. Add a Show, Hide, or Toggle step.</div>}<button className="addActionStep" onClick={()=>save([...steps,{operation:'show',targetType:'visual',targetId:''}])}>+ Add action step</button></div>;
}
function ButtonActionEditor({visual,page,pages,updateVisual}:{visual:Visual,page:Page,pages:Page[],updateVisual:(fn:(v:Visual)=>void)=>void}){
  const action=visual.action||{type:'none'};
  const groups=Array.from(new Set(page.visuals.map(item=>item.groupId?.trim()).filter(Boolean) as string[]));
  const setAction=(changes:any)=>updateVisual(v=>v.action={...(v.action||{}),...changes});
  const visualAction=['toggleVisual','showVisual','hideVisual'].includes(action.type||'');
  const groupAction=['toggleGroup','showGroup','hideGroup'].includes(action.type||'');
  return <Section open title="Button action" icon={<MousePointerClick size={14}/>}>
    <Toggle label="Dynamic button label" value={action.dynamicLabel!==false} onChange={value=>setAction({dynamicLabel:value})}/>
    <label>Button label<input value={visual.buttonLabel||''} disabled={action.dynamicLabel!==false} onChange={e=>updateVisual(v=>v.buttonLabel=e.target.value)} placeholder="Used when dynamic label is off"/></label>
    <label>Action<select value={action.type||'none'} onChange={e=>setAction({type:e.target.value})}>
      <option value="none">No action</option><option value="navigate">Page navigation</option><option value="showVisual">Show visual</option><option value="hideVisual">Hide visual</option><option value="toggleVisual">Toggle visual</option><option value="showGroup">Show group</option><option value="hideGroup">Hide group</option><option value="toggleGroup">Toggle group</option><option value="custom">Custom multi-action</option><option value="back">Back / previous page</option><option value="resetState">Reset page state</option>
    </select></label>
    {action.type==='navigate'&&<><label>Target report ID (optional)<input value={action.targetReportId||''} onChange={e=>setAction({targetReportId:e.target.value.trim()||undefined})} placeholder="Leave blank for this report"/></label>{action.targetReportId?<label>Target page ID (optional)<input value={action.targetPageId||''} onChange={e=>setAction({targetPageId:e.target.value.trim()||undefined})} placeholder="Page ID in the target report"/></label>:<label>Target page<select value={action.targetPageId||''} onChange={e=>setAction({targetPageId:e.target.value||undefined})}><option value="">Select page</option>{pages.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}</>}
    {visualAction&&<label>Target visual<select value={action.targetVisualId||''} onChange={e=>setAction({targetVisualId:e.target.value||undefined})}><option value="">Select visual</option>{page.visuals.filter(item=>item.id!==visual.id).map(item=><option key={item.id} value={item.id}>{item.title||visualLabels[item.type]}</option>)}</select></label>}
    {groupAction&&<label>Target group<select value={action.targetGroupId||''} onChange={e=>setAction({targetGroupId:e.target.value||undefined})}><option value="">Select group</option>{groups.map(group=><option key={group} value={group}>{group}</option>)}</select>{action.targetGroupId&&<div style={{fontSize:11,color:'#64748b',marginTop:4}}>{page.visuals.filter(item=>(item.groupId?.trim()||'')===(action.targetGroupId?.trim()||'')&&item.groupId).length} visuals in this group</div>}</label>}
    {action.type==='custom'&&<CustomActionSteps visual={visual} page={page} updateVisual={updateVisual}/>} 
    <div className="buttonActionPreview"><small>Preview</small><b>{resolveActionButtonLabel(visual,page,pages)}</b></div>
  </Section>;
}
function ColorControl({value,onChange}:{value:string,onChange:(v:string)=>void}){return <div className="colorControl"><input type="color" value={value} onChange={e=>onChange(e.target.value)}/><input value={value} onChange={e=>onChange(e.target.value)}/></div>}
function topNRankingOptions(model:any,current=''){
  const fields=Object.entries<any>(model?.tables||{}).flatMap(([table,definition])=>Object.keys(definition.columns||{}).map(column=>`${table}.${column}`));
  const numeric=fields.filter(field=>/int|decimal|double|float|numeric|number|money|currency|real/i.test(String(model?.columnTypes?.[field]||'')));
  const aggregations=[['sum','Sum'],['avg','Average'],['min','Minimum'],['max','Maximum'],['count','Count'],['distinct_count','Distinct count']] as const;
  const options=[...Object.keys(model?.measures||{}).map(value=>({value,label:value})),...numeric.flatMap(field=>aggregations.map(([suffix,label])=>({value:`${field}::${suffix}`,label:`${label} of ${field.split('.').pop()}`})))];
  if(current&&!options.some(option=>option.value===current))options.unshift({value:current,label:current});
  return options;
}
function topNRankingLabel(value=''){
  const[field,suffix]=value.split('::'),labels:Record<string,string>={sum:'Sum',avg:'Average',min:'Minimum',max:'Maximum',count:'Count',distinct_count:'Distinct count'};
  return suffix?`${labels[suffix]||suffix} of ${field.split('.').pop()}`:value.split('.').pop()||value;
}
function NumberFormatting({visual,updateVisual}:{visual:Visual,updateVisual:(fn:(v:Visual)=>void)=>void}){
  const fields=Array.from(new Set([...(visual.type==='table'||visual.type==='matrix'?(visual.bindings.axis||[]):[]),...(visual.bindings.values||[])]));const[field,setField]=useState(fields[0]||'');useEffect(()=>{if(!fields.includes(field))setField(fields[0]||'')},[fields.join('|')]);
  if(!fields.length)return <div className="formatHint">Add a numeric measure to Values to configure business-number formatting.</div>;
  const f: NumberFormat={...DEFAULT_NUMBER_FORMAT,...(visual.format.fieldFormats||{})[field]};
  const set=(k:keyof NumberFormat,val:any)=>updateVisual(v=>{formatDefaults(v);v.format.fieldFormats=v.format.fieldFormats||{};v.format.fieldFormats[field]={...DEFAULT_NUMBER_FORMAT,...v.format.fieldFormats[field],[k]:val}});
  return <div className="numberFormatting"><label>Field / measure<select value={field} onChange={e=>setField(e.target.value)}>{fields.map(x=><option key={x}>{x}</option>)}</select></label>{(visual.type==='table'||visual.type==='matrix')&&<label>Date presentation<select value={f.dateFormat||'default'} onChange={e=>set('dateFormat',e.target.value)}><option value="default">Automatic</option><option value="dd/MM/yyyy">DD/MM/YYYY</option><option value="MM/dd/yyyy">MM/DD/YYYY</option><option value="yyyy-MM-dd">YYYY-MM-DD</option><option value="dd MMM yyyy">DD MMM YYYY</option></select></label>}<div className="segmentedFormat"><button className={f.style==='number'?'active':''} onClick={()=>set('style','number')}>123</button><button className={f.style==='currency'?'active':''} onClick={()=>set('style','currency')}>$</button><button className={f.style==='percentage'?'active':''} onClick={()=>set('style','percentage')}>%</button></div>{f.style==='currency'&&<label>Currency<select value={f.currency} onChange={e=>set('currency',e.target.value)}>{CURRENCIES.map(c=><option value={c.code} key={c.code}>{c.symbol} · {c.code}</option>)}</select></label>}<div className="twoCol"><label>Decimal places<input type="number" min="0" max="8" value={f.decimals} onChange={e=>set('decimals',+e.target.value)}/></label><label>Display units<select value={f.displayUnits} onChange={e=>set('displayUnits',e.target.value)}><option value="auto">Auto</option><option value="none">None</option><option value="thousand">Thousands (K)</option><option value="million">Millions (M)</option><option value="billion">Billions (B)</option><option value="trillion">Trillions (T)</option></select></label></div><Toggle label="Thousands separator" value={f.thousandsSeparator!==false} onChange={x=>set('thousandsSeparator',x)}/></div>;
}
function InlineFilterBuilder({model,onAdd}:{model:any,onAdd:(f:VisualFilter)=>void}){
  const fields=Object.entries<any>(model?.tables||{}).flatMap(([t,x])=>Object.keys(x.columns||{}).map(c=>`${t}.${c}`));
  const rankingFields=[...Object.keys(model?.measures||{}),...fields.filter(f=>/int|decimal|double|float|numeric|number|money|currency/i.test(String(model?.columnTypes?.[f]||'')))];
  const[field,setField]=useState(fields[0]||''),[operator,setOperator]=useState('equals'),[value,setValue]=useState(''),[rankingField,setRankingField]=useState(rankingFields[0]||'');
  const top=operator==='top_n';
  return <div className="inlineFilterBuilder"><select aria-label="Filter field" value={field} onChange={e=>setField(e.target.value)}>{fields.map(f=><option key={f}>{f}</option>)}</select><select aria-label="Filter type" value={operator} onChange={e=>{setOperator(e.target.value);setValue(e.target.value==='top_n'?'10':'')}}><option value="equals">Equals</option><option value="not_equals">Not equal</option><option value="contains">Contains</option><option value="gt">Greater than</option><option value="gte">Greater/equal</option><option value="lt">Less than</option><option value="lte">Less/equal</option><option value="top_n">Top N</option></select><input aria-label={top?'Number of items':'Filter value'} type={top?'number':'text'} min={top?1:undefined} max={top?5000:undefined} value={value} onChange={e=>setValue(e.target.value)} placeholder={top?'Number of items':'Filter value'}/>{top&&<select aria-label="Rank by" value={rankingField} onChange={e=>setRankingField(e.target.value)}><option value="">Rank by…</option>{rankingFields.map(f=><option key={f}>{f}</option>)}</select>}<button disabled={!field||value===''||(top&&!rankingField)} onClick={()=>{if(field&&value!==''&&(!top||rankingField)){onAdd({field,operator,value:top?Math.max(1,Math.min(5000,Number(value)||10)):value,rankingField:top?rankingField:undefined});setValue(top?'10':'')}}}><Plus size={12}/>Add</button></div>
}
function FilterCard({f,onRemove,onUpdate,model,allowTopN=false,contextFilters=[],implicit=false}: {f:VisualFilter,onRemove:()=>void,onUpdate:(f:VisualFilter)=>void,model?:any,allowTopN?:boolean,contextFilters?:VisualFilter[],implicit?:boolean}) {
  const hasValue = f.value!==undefined && f.value!=='' && (!Array.isArray(f.value) || f.value.length > 0);
  const [expanded,setExpanded]=useState(!hasValue&&!implicit);
  const [draft, setDraft] = useState({...f});
  
  useEffect(() => { setDraft({...f}) }, [f]);

  const operatorLabels:Record<string,string>={'equals':'is','not_equals':'is not','contains':'contains','gt':'is greater than','gte':'is greater than or equal to','lt':'is less than','lte':'is less than or equal to','is_blank':'is blank','is_not_blank':'is not blank','starts_with':'starts with','does_not_start_with':'does not start with'};
  const shortName = f.field.includes('.') ? f.field.split('.').slice(-1)[0] : f.field;
  const summary = f.operator==='top_n' ? `${(f.rankingDirection||'top')==='bottom'?'Bottom':'Top'} ${f.value||10}${f.rankingField ? ` by ${topNRankingLabel(f.rankingField)}` : ''}` : f.operator==='in' ? (Array.isArray(f.value)&&f.value.length ? `is ${f.value.length>1?'multiple':f.value[0]}` : 'is (All)') : (!f.value&&f.value!==0) ? 'is (All)' : `${operatorLabels[f.operator]||f.operator} ${f.value}`;
  
  const filterType = draft.operator === 'top_n' ? 'top_n' : (['in_last','in_next','is_in_this'].includes(draft.operator) ? 'relative' : (draft.operator === 'in' ? 'basic' : 'advanced'));
  const cleanKey = (f.field||'').replace(/^(field:|numericField:|hierarchy:|measure:)/, '');
  const colType = String(model?.columnTypes?.[cleanKey] || '').toLowerCase();
  const isDate = colType === 'date' || colType === 'datetime' || colType === 'timestamp' || colType.startsWith('date') || colType.startsWith('timestamp');
  const fields = Object.entries<any>(model?.tables||{}).flatMap(([t,x])=>Object.keys(x.columns||{}).map(c=>`${t}.${c}`));
  const rankingOptions=topNRankingOptions(model,draft.rankingField||'');
  const isNumeric=/int|decimal|double|float|numeric|number|money|currency|real/i.test(colType);
  const topNEligible=allowTopN&&!isDate&&!isNumeric;
  const topNValue=Number(draft.value),topNError=filterType==='top_n'?(!topNEligible?'Top N is available only for categorical visual-level fields.':!Number.isInteger(topNValue)||topNValue<1||topNValue>5000?'Enter a whole number from 1 to 5000.':!draft.rankingField?'Select a ranking measure.':''):'';

  const [distinctValues, setDistinctValues] = useState<{value:string}[]|null>(null);
  const [basicSearch, setBasicSearch] = useState('');
  const distinctContextFilters=contextFilters.filter(x=>x.field!==f.field&&!(x.operator==='in'&&(!Array.isArray(x.value)||x.value.length===0)));
  const distinctContextKey=JSON.stringify(distinctContextFilters);

  useEffect(() => {
    if(filterType!=='basic'||!model)return;
    let active=true;
    setDistinctValues(null);
    setBasicSearch('');
    api<any>('/query-snapshot', {
        method: 'POST',
        body: JSON.stringify({
          project: { model },
          dimensions: [f.field],
          measures: [],
          filters: distinctContextFilters,
          sort: [{field:f.field,direction:'asc'}],
          distinct: true,
          limit: 5000
        })
      }).then(res => {
        if(!active)return;
        const uniqueValues=Array.from(new Set((res.rows||[]).map((r:any)=>String(r[f.field]??'(Blank)')))) as string[];
        setDistinctValues(uniqueValues.map(value=>({value})));
      }).catch(() => {
        if(active)setDistinctValues([]);
      });
    return()=>{active=false};
  }, [filterType, f.field, model, distinctContextKey]);

  const handleToggleBasic = (val: string) => {
    let current = Array.isArray(draft.value) ? [...draft.value] : (typeof draft.value==='string'&&draft.value ? draft.value.split(',') : []);
    if (current.includes(val)) current = current.filter(x => x !== val);
    else current.push(val);
    setDraft({...draft, value: current});
  };

  const handleSelectAll = () => {
    if (!distinctValues) return;
    const all = distinctValues.map(v => v.value);
    const current = Array.isArray(draft.value) ? draft.value : [];
    if (current.length === all.length) setDraft({...draft, value: []});
    else setDraft({...draft, value: all});
  };

  const isDirty = JSON.stringify(draft) !== JSON.stringify(f);

  return (
    <div className={`pbFilterCard${hasValue?' pbFilterCardActive':''}`}>
      <div className="pbFilterCardHeader" onClick={()=>setExpanded(!expanded)}>
        <div className="pbFilterCardMeta">
          <span className="pbFilterCardField">{shortName}</span>
          <span className={`pbFilterCardSummary${hasValue?' pbFilterCardSummaryActive':''}`}>{summary}</span>
        </div>
        <div className="pbFilterCardActions">
          {!implicit&&<button className="pbFilterCardRemove" title="Remove filter" onClick={e=>{e.stopPropagation();onRemove()}}><X size={12}/></button>}
          <ChevronDown size={13} style={{transform:expanded?'rotate(180deg)':'none',transition:'0.2s',flexShrink:0,color:'#605e5c'}}/>
        </div>
      </div>
      {expanded && <div className="pbFilterCardBody">
        <label className="pbFilterLabel">Filter type <Info size={12}/></label>
        <select className="pbFilterSelect" value={filterType} onChange={e=>{
          const type = e.target.value;
          if (type === 'top_n') setDraft({...draft, operator: 'top_n', value: draft.value || 10, rankingDirection: draft.rankingDirection || 'top', rankingField: draft.rankingField || rankingOptions[0]?.value || '', condition: undefined, operator2: undefined, value2: undefined});
          else if (type === 'basic') setDraft({...draft, operator: 'in', value: [], condition: undefined, operator2: undefined, value2: undefined});
          else if (type === 'relative') setDraft({...draft, operator: 'in_last', value: '30', value2: 'days', condition: undefined, operator2: undefined, rankingField: undefined});
          else setDraft({...draft, operator: 'equals', value: '', rankingField: undefined});
        }}>
          <option value="basic">Basic filtering</option>
          <option value="advanced">Advanced filtering</option>
          {(topNEligible||f.operator==='top_n')&&<option value="top_n">Top N</option>}
          {isDate && <option value="relative">Relative date/time</option>}
        </select>
        
        {filterType === 'basic' && <>
          <div className="pbFilterSearchWrap">
             <Search size={12} className="pbFilterSearchIcon"/>
             <input type="text" className="pbFilterSearchInput" placeholder="Search" value={basicSearch} onChange={e=>setBasicSearch(e.target.value)} />
          </div>
          <div className="pbFilterList">
            <label className="pbFilterCheckboxItem"><input type="checkbox" checked={!!(distinctValues && Array.isArray(draft.value) && draft.value.length === distinctValues.length && distinctValues.length > 0)} onChange={handleSelectAll}/><span>Select all</span></label>
            {!distinctValues ? <div style={{padding:8,fontSize:12}}>Loading...</div> : distinctValues.filter(x => x.value.toLowerCase().includes(basicSearch.toLowerCase())).map(v => (
              <label key={v.value} className="pbFilterCheckboxItem"><input type="checkbox" checked={Array.isArray(draft.value) && draft.value.includes(v.value)} onChange={()=>handleToggleBasic(v.value)}/><span>{v.value}</span></label>
            ))}
          </div>

        </>}

        {filterType === 'advanced' && <>
          <label className="pbFilterLabel">Show items when the value:</label>
          <select className="pbFilterSelect" value={draft.operator} onChange={e=>setDraft({...draft,operator:e.target.value})}>
            {Object.entries(isDate ? {'equals':'is', 'not_equals':'is not', 'lt':'is before', 'lte':'is on or before', 'gt':'is after', 'gte':'is on or after', 'is_blank':'is blank', 'is_not_blank':'is not blank'} : operatorLabels).map(([k,v])=><option key={k} value={k}>{v}</option>)}
          </select>
          {!['is_blank','is_not_blank'].includes(draft.operator) && <input className="pbFilterInput" type={isDate?'datetime-local':'text'} value={draft.value||''} onChange={e=>setDraft({...draft,value:e.target.value})}/>}
          
          <div className="pbFilterConditionGroup">
            <label><input type="radio" name={`cond-${f.field}`} checked={draft.condition==='and'} onChange={()=>setDraft({...draft,condition:'and'})}/> And</label>
            <label><input type="radio" name={`cond-${f.field}`} checked={draft.condition==='or'} onChange={()=>setDraft({...draft,condition:'or'})}/> Or</label>
          </div>
          
          <select className="pbFilterSelect" value={draft.operator2||''} onChange={e=>setDraft({...draft,operator2:e.target.value})}>
            <option value="">(None)</option>
            {Object.entries(isDate ? {'equals':'is', 'not_equals':'is not', 'lt':'is before', 'lte':'is on or before', 'gt':'is after', 'gte':'is on or after', 'is_blank':'is blank', 'is_not_blank':'is not blank'} : operatorLabels).map(([k,v])=><option key={k} value={k}>{v}</option>)}
          </select>
          {draft.operator2 && !['is_blank','is_not_blank'].includes(draft.operator2) && <input className="pbFilterInput" type={isDate?'datetime-local':'text'} value={draft.value2||''} onChange={e=>setDraft({...draft,value2:e.target.value})}/>}
        </>}
        
        {filterType === 'relative' && <>
          <label className="pbFilterLabel">Show items when the value:</label>
          <div style={{display:'flex', gap: 8, alignItems: 'center'}}>
            <select className="pbFilterSelect" style={{flex: '0 0 40%', marginBottom: 0}} value={draft.operator} onChange={e=>setDraft({...draft,operator:e.target.value})}>
              <option value="in_last">is in the last</option>
              <option value="is_in_this">is in this</option>
              <option value="in_next">is in the next</option>
            </select>
            {draft.operator !== 'is_in_this' && <input className="pbFilterInput" type="number" style={{flex: '1 1 auto', marginBottom: 0, minWidth: 0}} value={draft.value||''} onChange={e=>setDraft({...draft,value:e.target.value})} min={1}/>}
          </div>
          <select className="pbFilterSelect" style={{marginTop: 8}} value={draft.value2||'days'} onChange={e=>setDraft({...draft,value2:e.target.value})}>
            <option value="days">days</option>
            <option value="weeks">weeks</option>
            <option value="months">months</option>
            <option value="years">years</option>
            <option value="hours">hours</option>
            <option value="minutes">minutes</option>
          </select>
        </>}

        {filterType === 'top_n' && <>
          <label className="pbFilterLabel">Show items</label>
          <div style={{display:'flex', gap: 8, alignItems: 'center'}}>
            <select
              className="pbFilterSelect"
              style={{flex: '0 0 40%', marginBottom: 0}}
              value={draft.rankingDirection || 'top'}
              onChange={e => setDraft({...draft, rankingDirection: e.target.value as 'top' | 'bottom'})}
            >
              <option value="top">Top</option>
              <option value="bottom">Bottom</option>
            </select>
            <input className="pbFilterInput" type="number" style={{flex: '1 1 auto', marginBottom: 0, minWidth: 0}} value={draft.value||''} onChange={e=>setDraft({...draft,value:e.target.value})} min={1}/>
          </div>
          <label className="pbFilterLabel" style={{marginTop: 4}}>By value</label>
          <select className="pbFilterSelect pbFilterDropzone" value={draft.rankingField||''} onChange={e=>setDraft({...draft,rankingField:e.target.value})}>
            <option value="" disabled>Select an option</option>
            {rankingOptions.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          {topNError&&<div className="schemaEmptyNote" role="alert">{topNError}</div>}
          {!topNError&&<small>Ranking is calculated after report, page, slicer, cross-filter, and other visual filters. Ties are resolved by {shortName} ascending so exactly N items are retained.</small>}
        </>}
        
        <div style={{display: 'flex', justifyContent: 'space-between', gap:8, marginTop: 8}}>
          {filterType==='top_n'&&<button className="schemaInlineReset" onClick={onRemove}>Clear filter</button>}
          <button className={`pbApplyFilterBtn ${isDirty&&!topNError ? 'active' : ''}`} disabled={!isDirty||!!topNError} onClick={()=>onUpdate(filterType==='top_n'?{...draft,value:Math.trunc(topNValue),rankingDirection:draft.rankingDirection||'top'}:draft)}>Apply filter</button>
        </div>
      </div>}
    </div>
  );
}
function FilterList({title,filters,onRemove,onUpdate,model,onAdd,allowTopN=false,search='',contextFilters=[],implicitStart=Number.POSITIVE_INFINITY}:{title:string,filters:VisualFilter[],onRemove:(i:number)=>void,onUpdate:(i:number,f:VisualFilter)=>void,model:any,onAdd:(f:VisualFilter)=>void,allowTopN?:boolean,search?:string,contextFilters?:VisualFilter[],implicitStart?:number}){
  const [open,setOpen]=useState(true);
  const sectionRef = useRef<HTMLDivElement>(null);

  const handleDrop = (raw: string) => {
    if (!raw) return;
    const cleanField = raw.replace(/^(field:|numericField:|hierarchy:|measure:)/, '');
    onAdd({ field: cleanField, operator: 'in', value: [] });
    clearReportFieldDragPayload();
  };

  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    const handler = (e: Event) => {
      const raw = (e as CustomEvent<{raw:string}>).detail?.raw || '';
      handleDrop(raw);
    };
    el.addEventListener('vtab-report-field-drop', handler);
    return () => el.removeEventListener('vtab-report-field-drop', handler);
  });

  return (
    <div className="pbFilterSection">
      <div className="pbFilterSectionHeader" onClick={()=>setOpen(o=>!o)}>
        <span className="pbFilterSectionTitle">{title}</span>
        <div style={{display:'flex',gap:4,alignItems:'center'}}>
          <ChevronDown size={13} style={{transform:open?'none':'rotate(-90deg)',transition:'0.2s',color:'#605e5c'}}/>
        </div>
      </div>
      {open && <div
        ref={sectionRef}
        className="pbFilterSectionBody"
        data-report-field-drop="true"
        onPointerUp={e=>{if(reportFieldDragPayload){e.preventDefault();handleDrop(reportFieldDragPayload)}}}
        onMouseUp={e=>{if(reportFieldDragPayload){e.preventDefault();handleDrop(reportFieldDragPayload)}}}
        onDragEnter={e=>{e.preventDefault();e.dataTransfer.dropEffect='copy'}}
        onDragOver={e=>{e.preventDefault();e.dataTransfer.dropEffect='copy'}}
        onDrop={e=>{
          e.preventDefault();
          const payload = e.dataTransfer.getData('application/x-vtab-field') || e.dataTransfer.getData('text/plain') || reportFieldDragPayload;
          handleDrop(payload);
        }}
      >
        {filters.map((f,index)=>({f,index})).filter(({f})=>!search||f.field.toLowerCase().includes(search.toLowerCase())).map(({f,index})=><FilterCard key={`${f.field}:${index}`} f={f} onRemove={()=>onRemove(index)} onUpdate={nx=>onUpdate(index,nx)} model={model} allowTopN={allowTopN} contextFilters={contextFilters} implicit={index>=implicitStart}/>)}
        <div className="pbEmptyDropzone">Add data fields here</div>
      </div>}
    </div>
  );
}
function visualDimensionFilterFields(visual:Visual|undefined,model:any){
  if(!visual)return [];
  const measureNames=new Set(Object.keys(model?.measures||{}));
  const cleanField=(raw:string)=>raw.replace(/^(field:|numericField:|hierarchy:|measure:)/,'').split('::')[0];
  const isMeasure=(raw:string,field:string)=>raw.startsWith('measure:')||measureNames.has(field)||measureNames.has(field.split('.').slice(-1)[0]);
  const dimensionWells=visualProfile(visual.type).wells.filter(w=>w.accept==='field').map(w=>w.key);
  return Array.from(new Set(dimensionWells.flatMap(key=>((visual.bindings as any)?.[key]||[]) as string[]).map(raw=>({raw,field:cleanField(raw)})).filter(({raw,field})=>field&&!field.startsWith('@@HIERARCHY@@')&&!isMeasure(raw,field)).map(({field})=>field)));
}
function FiltersDock({visual,updateVisual,page,updatePage,reportFilters,setReportFilters,model,onCollapse}:{visual:Visual|undefined,updateVisual:(fn:(v:Visual)=>void)=>void,page:Page,updatePage:(fn:(p:Page)=>void)=>void,reportFilters:VisualFilter[],setReportFilters:(x:VisualFilter[])=>void,model:any,onCollapse?:()=>void}){
  const [search,setSearch]=useState('');
  const explicitVisualFilters=visual?.filters||[];
  const implicitVisualFilters=visualDimensionFilterFields(visual,model).filter(field=>!explicitVisualFilters.some(f=>f.field===field)).map(field=>({field,operator:'in',value:[]} as VisualFilter));
  const visualFilters=[...explicitVisualFilters,...implicitVisualFilters];
  const visualContext=[...reportFilters,...(page.filters||[]),...explicitVisualFilters];
  const pageContext=[...reportFilters,...(page.filters||[])];
  return <aside className="filtersDock pbFiltersDock" aria-label="Filters pane">
    <div className="pbFiltersDockHeader">
      <div className="pbFiltersDockTitle"><Filter size={14}/><b>Filters</b></div>
      <div style={{display:'flex',gap:4,alignItems:'center'}}>
        {onCollapse&&<button className="dockCollapseButton" title="Collapse Filters pane" onClick={onCollapse} aria-label="Action"><ChevronRight size={14}/></button>}
      </div>
    </div>
    <div className="pbFiltersSearch">
      <Filter size={13} style={{color:'#a19f9d',flexShrink:0}}/>
      <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search" aria-label="Search filters"/>
    </div>
    <div className="pbFiltersDockScroll">
      <FilterList title="Filters on this visual" allowTopN filters={visualFilters} implicitStart={explicitVisualFilters.length} search={search} contextFilters={visualContext} model={model} onAdd={f=>visual&&updateVisual(v=>v.filters=[...(v.filters||[]),f])} onRemove={i=>visual&&i<explicitVisualFilters.length&&updateVisual(v=>v.filters=(v.filters||[]).filter((_,j)=>i!==j))} onUpdate={(i,nx)=>visual&&updateVisual(v=>{v.filters=i<(v.filters||[]).length?(v.filters||[]).map((f,j)=>i===j?nx:f):[...(v.filters||[]),nx]})}/>
      <FilterList title="Filters on this page" filters={page.filters||[]} search={search} contextFilters={pageContext} model={model} onAdd={f=>updatePage(p=>p.filters=[...(p.filters||[]),f])} onRemove={i=>updatePage(p=>p.filters=(p.filters||[]).filter((_,j)=>i!==j))} onUpdate={(i,nx)=>updatePage(p=>p.filters=(p.filters||[]).map((f,j)=>i===j?nx:f))}/>
      <FilterList title="Filters on all pages" filters={reportFilters} search={search} contextFilters={reportFilters} model={model} onAdd={f=>setReportFilters([...reportFilters,f])} onRemove={i=>setReportFilters(reportFilters.filter((_,j)=>i!==j))} onUpdate={(i,nx)=>setReportFilters(reportFilters.map((f,j)=>i===j?nx:f))}/>
    </div>
  </aside>;
}
function VisualizationsPane({addVisual}:{addVisual:(type:VisualType)=>void}){
  return <section className="visualizationsPane">
    <div className="visualizationsHeader"><b>Build visual</b></div>
    <div className="rightVisualGallery">{visualTypes.map(type=><button type="button" key={type} onClick={e=>{e.preventDefault();e.stopPropagation();addVisual(type)}} aria-label={`Add ${visualLabels[type]}`} title={visualLabels[type]}>{visualIcon(type)}<span>{visualLabels[type]}</span></button>)}</div>
  </section>;
}

function MapBuildTools({visual,updateVisual}:{visual:Visual;updateVisual:(fn:(visual:Visual)=>void)=>void}){
  const[crs,setCrs]=useState(visual.format.mapSourceCrs||'EPSG:4326'),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[correction,setCorrection]=useState({query:'',latitude:'',longitude:''});
  const importFile=async(file:File)=>{setBusy(true);setMessage('');try{const geometry=await parseSpatialFile(file,crs);updateVisual(v=>{v.format.mapCustomGeometry=geometry;v.format.mapCustomGeometryName=file.name;v.format.mapSourceCrs=crs});setMessage(`${geometry.features.length.toLocaleString()} features imported from ${file.name}.`)}catch(error:any){setMessage(error?.message||String(error))}finally{setBusy(false)}};
  const saveCorrection=()=>{const latitude=Number(correction.latitude),longitude=Number(correction.longitude),query=correction.query.trim();if(!query||!Number.isFinite(latitude)||latitude<-90||latitude>90||!Number.isFinite(longitude)||longitude<-180||longitude>180){setMessage('Enter a location with valid latitude (-90 to 90) and longitude (-180 to 180).');return}const key=query.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/&/g,'and').replace(/[^a-z0-9]+/g,' ').trim();updateVisual(v=>{v.format.mapLocationCorrections={...(v.format.mapLocationCorrections||{}),[key]:{latitude,longitude,displayName:query}}});setMessage(`Saved ${query} inside this report.`);setCorrection({query:'',latitude:'',longitude:''})};
  return <>
    <Section title="Spatial data" icon={<MapPinned size={14}/>}><div className="formatHint">Import GeoJSON, TopoJSON, KML, or a zipped shapefile. Geometry is normalized and saved with the report.</div><label>Source coordinate system<input value={crs} onChange={event=>setCrs(event.target.value)} placeholder="EPSG:4326"/></label><label className="imageUploadButton"><Upload size={14}/>{busy?'Importing…':visual.format.mapCustomGeometryName?'Replace spatial file':'Import spatial file'}<input type="file" disabled={busy} accept=".geojson,.json,.topojson,.kml,.zip,.shp" onChange={event=>{const file=event.target.files?.[0];if(file)void importFile(file);event.currentTarget.value=''}}/></label>{visual.format.mapCustomGeometryName&&<><small>{visual.format.mapCustomGeometryName} · {visual.format.mapCustomGeometry?.features?.length||0} features</small><label>Join property<input value={visual.format.mapGeometryJoinProperty||''} onChange={event=>updateVisual(v=>v.format.mapGeometryJoinProperty=event.target.value||undefined)} placeholder="Boundary property matching Location"/></label><button type="button" className="dangerBtn" onClick={()=>updateVisual(v=>{v.format.mapCustomGeometry=undefined;v.format.mapCustomGeometryName=undefined})}><Trash2 size={13}/>Remove spatial file</button></>}{message&&<small>{message}</small>}</Section>
    <Section title="Local location correction" icon={<LocateFixed size={14}/>}><div className="formatHint">Resolve an unmatched city or place locally. The coordinates are saved with this report and do not call an external geocoder.</div><label>Location value<input value={correction.query} onChange={event=>setCorrection(current=>({...current,query:event.target.value}))} placeholder="Exactly as it appears in the data"/></label><div className="twoCol"><label>Latitude<input type="number" min="-90" max="90" step="any" value={correction.latitude} onChange={event=>setCorrection(current=>({...current,latitude:event.target.value}))}/></label><label>Longitude<input type="number" min="-180" max="180" step="any" value={correction.longitude} onChange={event=>setCorrection(current=>({...current,longitude:event.target.value}))}/></label></div><button type="button" onClick={saveCorrection}><MapPinned size={13}/>Save in report</button>{Object.values(visual.format.mapLocationCorrections||{}).length>0&&<small>{Object.values(visual.format.mapLocationCorrections||{}).length} local correction(s) saved.</small>}</Section>
  </>;
}
const _chartAxisTypes=new Set(['bar','column','stackedbar','stackedcolumn','line','area','combo','waterfall','scatter','bubble','histogram','boxplot','heatmap']);
const _defaultVisualLabels=new Set(Object.values(visualLabels));
function autoNameFromBindings(v:Visual){
  const capitalize=(s:string)=>s?s[0].toUpperCase()+s.slice(1):'';
  const prettyField=(f:string)=>f.replace(/[_-]+/g,' ').split(' ').filter(Boolean).map(capitalize).join(' ');
  const describe=(binding?:string)=>{
    if(!binding)return {field:'',aggregate:''};
    const [path,aggregate='']=binding.split('::');
    return {field:prettyField(path.split('.').slice(-1)[0]||''),aggregate:aggregate?capitalize(aggregate):''};
  };
  const axisFields=(v.bindings.axis||[]).filter((f:string)=>!f.startsWith('@@'));
  const firstAxis=describe(axisFields[0]),firstLegend=describe(v.bindings.legend?.[0]);
  const firstValue=describe(v.bindings.values?.[0]),firstTarget=describe(v.bindings.target?.[0]);
  const firstX=describe(v.bindings.x?.[0]);
  const valueLabel=firstValue.field?(firstValue.aggregate?`${firstValue.aggregate} of ${firstValue.field}`:firstValue.field):'';
  if(_chartAxisTypes.has(v.type)){
    if(firstAxis.field){v.format.xAxisTitle=firstAxis.field;v.format.axisTitleVisible=true;(v.format as any).xAxisTitleVisible=true;}
    if(firstValue.field){v.format.yAxisTitle=firstValue.field;v.format.axisTitleVisible=true;(v.format as any).yAxisTitleVisible=true;}
  }
  const isDefaultTitle=!v.title||_defaultVisualLabels.has(v.title)||(v.format as any)._autoTitle;
  if(isDefaultTitle){
    let title='';
    if(v.type==='textbox'||v.type==='button')return;
    if(v.type==='slicer')title=firstAxis.field;
    else if(v.type==='map'){const geography=v.bindings.location?.[0]||v.bindings.region?.[0]||v.bindings.country?.[0]||v.bindings.postalCode?.[0]||v.bindings.detail?.[0];title=`Map${describe(geography).field?` by ${describe(geography).field}`:''}`;}
    else if(v.type==='heatmap')title=[valueLabel,[firstLegend.field,firstAxis.field].filter(Boolean).join(' and ')].filter(Boolean).join(' by ');
    else if(v.type==='scatter')title=[firstValue.field,firstX.field||firstAxis.field].filter(Boolean).join(' by ');
    else if(v.type==='multirowcard')title=(v.bindings.values||[]).slice(0,3).map(x=>describe(x).field).filter(Boolean).join(', ');
    else if(v.type==='table')title=[...(v.bindings.axis||[]),...(v.bindings.values||[])].slice(0,3).map(x=>describe(x).field).filter(Boolean).join(', ');
    else if(v.type==='matrix')title=[valueLabel,[firstAxis.field,firstLegend.field].filter(Boolean).join(' and ')].filter(Boolean).join(' by ');
    else if(v.type==='kpi')title=[valueLabel,firstAxis.field].filter(Boolean).join(' by ');
    else if(['card','gauge','progress'].includes(v.type))title=valueLabel||firstTarget.field||firstAxis.field;
    else title=[valueLabel,firstAxis.field||firstLegend.field].filter(Boolean).join(' by ');
    v.title=title||visualLabels[v.type];
    (v.format as any)._autoTitle=true;
  }
}
function RightPane({visual,updateVisual,removeVisual,duplicate,page,updatePage,reportFilters,setReportFilters,model,addVisual,galleryVisible,onCollapse,selectedIds}:{visual:Visual|undefined,updateVisual:(fn:(v:Visual)=>void)=>void,removeVisual:()=>void,duplicate:()=>void,page:Page,updatePage:(fn:(p:Page)=>void)=>void,reportFilters:VisualFilter[],setReportFilters:(x:VisualFilter[])=>void,model:any,addVisual:(type:VisualType)=>void,galleryVisible:boolean,onCollapse?:()=>void,selectedIds?:string[]}){
  const[tab,setTab]=useState<'build'|'format'|'analytics'|'page'>('build');
  const[liveCategories,setLiveCategories]=useState<string[]>([]);
  useEffect(()=>{
    if(!visual||!model||!['pie','donut','bar','column','stackedbar','stackedcolumn','line','area','combo'].includes(visual.type)){setLiveCategories([]);return;}
    const legend=(visual.bindings.legend||[])[0];
    const axis=legend||(visual.bindings.axis||[])[visual.drillLevel||0]||(visual.bindings.axis||[]).slice(-1)[0];
    if(!axis){setLiveCategories([]);return;}
    const project={model,report:{pages:[{...page,visuals:page.visuals}],filters:[],activePageId:page.id}};
    queryVisual(visual,project,null,[]).then(r=>{
      const cats=Array.from(new Set(r.rows.map((row:any)=>String(row[axis]||'')))).filter(Boolean) as string[];
      setLiveCategories(cats);
    }).catch(()=>setLiveCategories([]));
  },[visual?.id,visual?.bindings,visual?.drillLevel,visual?.type,model]);
  const multiSelect = (selectedIds?.length || 0) > 1;
  const selectedVisuals = (selectedIds || []).map(id => page.visuals.find(x => x.id === id)).filter(Boolean) as Visual[];
  const multiSelectSameType = multiSelect && selectedVisuals.length > 0 && selectedVisuals.every(v => v.type === selectedVisuals[0].type);
  const formatUpdateVisual = multiSelect ? (fn:(v:Visual)=>void) => {
    updatePage(pg => {
      for (const id of selectedIds!) {
        const v = pg.visuals.find(x => x.id === id);
        if (v) { formatDefaults(v); fn(v); }
      }
    });
  } : updateVisual;
  const setFmt=(k:keyof VisualFormat,val:any)=>visual&&updateVisual(v=>{formatDefaults(v);(v.format as any)[k]=val});
  const addBinding=(k:VisualWellKey,x:string)=>visual&&updateVisual(v=>{
    let dropVal = x;
    if (k === 'axis') {
      v.drillLevel = 0;
      v.drillFilters = [];
    }
    
    const cleanKey = dropVal.replace(/^(field:|numericField:)/, '');
    const colType = (model?.columnTypes?.[cleanKey] || '').toLowerCase();
    
    if (k === 'axis' && (colType === 'date' || colType === 'datetime' || colType === 'timestamp' || colType.startsWith('date') || colType.startsWith('timestamp'))) {
      v.bindings.axis = [`${cleanKey}::Year`, `${cleanKey}::Quarter`, `${cleanKey}::Month`, `${cleanKey}::Day`];
      v.bindings.hierarchy = undefined;
      return;
    }
    
    if (k === 'axis' && !dropVal.startsWith('@@HIERARCHY@@')) {
      const h = (model?.hierarchies||[]).find((z:any) => z.sourceField === dropVal);
      if (h) dropVal = '@@HIERARCHY@@' + h.id;
    }
    
    if (k === 'axis' && dropVal.startsWith('@@HIERARCHY@@')) {
      const id = dropVal.replace('@@HIERARCHY@@', '');
      const h = (model?.hierarchies||[]).find((z:any) => z.id === id);
      if (h) {
        v.bindings.hierarchy = { id, level: 0 };
        v.bindings.axis = [h.levels[0].field];
        return;
      }
    }
    
    (v.bindings as any)[k]=[...((v.bindings as any)[k]||[]),dropVal];
    const formatHint=model?.columnFormats?.[dropVal];
    if(formatHint&&['values','target','tooltips'].includes(k)){formatDefaults(v);v.format.fieldFormats=v.format.fieldFormats||{};v.format.fieldFormats[dropVal]={...DEFAULT_NUMBER_FORMAT,...formatHint}}
    // Auto-name: generate Power BI-style chart title + axis titles
    autoNameFromBindings(v);
  });
  const removeBinding=(k:VisualWellKey,x:string)=>visual&&updateVisual(v=>{(v.bindings as any)[k]=((v.bindings as any)[k]||[]).filter((z:string)=>z!==x);if(k==='axis'&&!(v.bindings.axis||[]).length)v.bindings.hierarchy=undefined;autoNameFromBindings(v)});
  const pageSettings=page.settings||defaultPageSettings();
  const pageType=pageSettings.pageSizePreset==='Custom'?'Custom':pageSettings.pageSizePreset==='4:3'?'4:3':pageSettings.pageSizePreset==='Letter'?'Letter':pageSettings.pageSizePreset==='Tooltip'?'Tooltip':'16:9';
  const setPageType=(type:'16:9'|'4:3'|'Letter'|'Tooltip'|'Custom')=>updatePage(p=>{pageDefaults(p);p.settings!.pageSizePreset=type;p.settings!.autoFitHeight=false;const dimensions:Record<string,[number,number]>={'16:9':[1280,720],'4:3':[960,720],Letter:[816,1056],Tooltip:[320,240]};if(dimensions[type]){p.settings!.pageWidth=dimensions[type][0];p.settings!.pageHeight=dimensions[type][1]}});
  const profile=visual?visualProfile(visual.type):undefined;
  const supportsCategoryScroll=!!visual&&categoryScrollTypes.has(visual.type);
  return <div className="formatPane advancedFormat professionalRightPane"><div className="formatPaneHeader"><div className="formatPaneIdentity"><b>Visualizations</b>{onCollapse&&<button className="dockCollapseButton" title="Collapse Visualizations pane" onClick={onCollapse} aria-label="Action"><PanelRightClose size={14}/></button>}</div><div className="formatTabs four" role="tablist" aria-label="Visual authoring"><button title="Build visual" aria-label="Build visual" className={tab==='build'?'active':''} onClick={()=>setTab('build')}><BarChart3 size={20}/><span>Build</span></button><button title="Format visual" aria-label="Format visual" className={tab==='format'?'active':''} onClick={()=>setTab('format')}><PaintBucket size={20}/><span>Format</span></button><button title="Analytics" aria-label="Analytics" disabled={!visual} className={tab==='analytics'?'active':''} onClick={()=>setTab('analytics')}><LineChart size={20}/><span>Analytics</span></button><button title="Canvas settings" aria-label="Canvas settings" className={tab==='page'?'active':''} onClick={()=>setTab('page')}><Settings2 size={20}/><span>Canvas</span></button></div></div>

  {tab==='build'&&galleryVisible&&<VisualizationsPane addVisual={addVisual}/>} 
  {tab==='build'&&visual?.type==='button'&&<div className="propertyList interactionActionEditor buttonActionEditor"><ButtonActionEditor visual={visual} page={page} pages={model?.__pages||[]} updateVisual={updateVisual}/><div className="visualActions"><button onClick={duplicate}><Copy size={14}/>Duplicate</button><button className="dangerBtn" onClick={removeVisual}><Trash2 size={14}/>Delete</button></div></div>}
  {tab==='build'?(!visual?<div className="paneEmpty"><Layers3/><b>Select a visual</b><span>Choose a visual on the canvas to bind fields and measures.</span></div>:<div className="propertyList">{visual.type==='textbox'?<Section open title="Text box" icon={<TextCursorInput size={14}/>}><div className="formatHint">Double-click the text box on the canvas to edit and format text directly.</div><label>Plain text<textarea rows={7} value={visual.text||''} onChange={e=>updateVisual(v=>{v.text=e.target.value;v.richText=undefined})} placeholder="Enter report text..."/></label></Section>:visual.type==='image'?<Section open title="Image" icon={<ImageIcon size={14}/>}><div className="formatHint">PNG, JPG, SVG, GIF and WEBP files up to 8 MB are stored with the report.</div><label className="imageUploadButton"><Upload size={14}/>{visual.imageSrc?'Replace image':'Choose image'}<input type="file" accept="image/*" onChange={e=>{const file=e.target.files?.[0];if(file)uploadBackgroundImage(file,dataUrl=>updateVisual(v=>{v.imageSrc=dataUrl;v.imageName=file.name}));e.currentTarget.value=''}}/></label>{visual.imageName&&<small>{visual.imageName}</small>}</Section>:visual.type==='shape'?<Section open title="Shape" icon={<LayoutDashboard size={14}/>}><label>Shape<select value={visual.format.shapeType||'rectangle'} onChange={e=>updateVisual(v=>{v.format.shapeType=e.target.value as VisualFormat['shapeType'];if(v.format.shapeType==='line'&&v.format.shapeStrokeVisible===false)v.format.shapeStrokeVisible=true})}><option value="rectangle">Rectangle</option><option value="roundedRectangle">Rounded rectangle</option><option value="ellipse">Ellipse</option><option value="line">Line</option><option value="triangle">Triangle</option><option value="diamond">Diamond</option></select></label><div className="formatHint">Use the Format tab to change fill, transparency, outline, and line style.</div></Section>:visual.type==='button'?null:<><Section open title="Data" icon={<Layers3 size={14}/>}><DataWells visual={visual} addBinding={addBinding} removeBinding={removeBinding} updateVisual={updateVisual} model={model}/></Section>{visual.type==='map'&&<MapBuildTools visual={visual} updateVisual={updateVisual}/>}<Section open title="Visual group" icon={<Layers3 size={14}/>}><label>Group name<input value={visual.groupId||''} list="visual-groups-list" onChange={e=>formatUpdateVisual(v=>v.groupId=e.target.value.trim()||undefined)} placeholder="e.g. charts-panel"/></label><datalist id="visual-groups-list">{Array.from(new Set(page.visuals.map(v=>v.groupId?.trim()).filter(Boolean))).map(g=><option key={g as string} value={g as string}/>)}</datalist></Section></>}{visual.type==='slicer'&&<Section open title="Slicer layout" icon={<Filter size={14}/>}><label>Style<select value={visual.slicerStyle||'list'} onChange={e=>updateVisual(v=>v.slicerStyle=e.target.value as any)}><option value="list">List</option><option value="dropdown">Dropdown</option><option value="button">Tile</option></select></label></Section>}<div className="visualActions"><button onClick={duplicate}><Copy size={14}/>Duplicate</button><button className="dangerBtn" onClick={removeVisual}><Trash2 size={14}/>Delete</button></div></div>)
  :tab==='format'?(!visual?<div className="paneEmpty"><Palette/><b>Select a visual</b><span>Visual formatting appears here.</span></div>:<FormattingWorkspace visual={visual} categories={liveCategories} updateVisual={formatUpdateVisual} multiSelect={multiSelect} multiSelectSameType={multiSelectSameType}/>)
  :tab==='analytics'?(!visual?<div className="paneEmpty"><LineChart/><b>Select a visual</b><span>Analytics settings appear for the selected chart.</span></div>:<FormattingWorkspace visual={visual} updateVisual={formatUpdateVisual} mode="analytics" multiSelect={multiSelect} multiSelectSameType={multiSelectSameType}/>)
  :<div className="propertyList">
    <Section title="Report Theme" icon={<Palette size={14}/>}>
      <div className="themeGallery">{REPORT_THEMES.map(theme=><button key={theme.id} className={(pageSettings.themeId||'light-professional')===theme.id?'themeCard active':'themeCard'} onClick={()=>updatePage(p=>applyThemeToPage(p,theme.id))}>
        <div className="themeSwatches">{theme.preview.map((c,i)=><i key={i} style={{background:c}}/>)}</div>
        <span>{theme.name}</span>
      </button>)}</div>
      <div className="formatHint">Themes apply the page, header, visual background, accent, labels and title colors. You can still override individual visuals afterward.</div>
    </Section>
    <Section title="Background Image" icon={<ImageIcon size={14}/>}>
      <label className="uploadBackgroundBtn"><Upload size={14}/><span>Upload background image</span><input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={e=>{const file=e.target.files?.[0];if(file)uploadBackgroundImage(file,data=>updatePage(p=>{pageDefaults(p);p.settings!.backgroundImage=data}))}}/></label>
      {pageSettings.backgroundImage&&<div className="backgroundThumb" style={{backgroundImage:`url(${pageSettings.backgroundImage})`}}/>}
      <label>Image fit<select value={pageSettings.backgroundImageFit||'cover'} onChange={e=>updatePage(p=>{pageDefaults(p);p.settings!.backgroundImageFit=e.target.value as any})}>
        <option value="cover">Cover</option><option value="contain">Contain</option><option value="stretch">Stretch</option><option value="center">Center</option>
      </select></label>
      <label>Image opacity <span>{pageSettings.backgroundImageOpacity??24}%</span><input className="pageImageOpacitySlider" aria-label="Background image opacity" type="range" min="0" max="100" value={pageSettings.backgroundImageOpacity??24} onChange={e=>updatePage(p=>{pageDefaults(p);p.settings!.backgroundImageOpacity=+e.target.value})}/></label>
      <div className="inlineActions"><button onClick={()=>updatePage(p=>{pageDefaults(p);p.settings!.backgroundImage=undefined})}><Trash2 size={13}/>Remove image</button><button onClick={()=>updatePage(p=>{const fresh=defaultPageSettings();p.settings=fresh})}><RotateCcw size={13}/>Reset page</button></div>
      <div className="formatHint">PNG, JPG, WEBP or GIF up to 8 MB. The image is stored with report metadata for this authoring build.</div>
    </Section>
<Section title="Page size & canvas" icon={<Maximize2 size={14}/>}>
<div className="powerBiCanvasSettings"><label>Type<select value={pageType} onChange={e=>setPageType(e.target.value as any)}><option value="16:9">16:9</option><option value="4:3">4:3</option><option value="Letter">Letter</option><option value="Tooltip">Tooltip</option><option value="Custom">Custom</option></select></label><div className="canvasDimensionGrid"><label>Width<input type="number" min="240" max="4000" disabled={pageType!=='Custom'} value={pageSettings.pageWidth||1280} onChange={e=>updatePage(p=>{pageDefaults(p);p.settings!.pageWidth=Math.max(240,+e.target.value);p.settings!.pageSizePreset='Custom'})}/></label><label>Height<input type="number" min="180" max="6000" disabled={pageType!=='Custom'} value={pageSettings.pageHeight||720} onChange={e=>updatePage(p=>{pageDefaults(p);p.settings!.pageHeight=Math.max(180,+e.target.value);p.settings!.pageSizePreset='Custom';p.settings!.autoFitHeight=false})}/></label></div><label>Vertical alignment<select value={pageSettings.pageVerticalAlignment||'top'} onChange={e=>updatePage(p=>{pageDefaults(p);p.settings!.pageVerticalAlignment=e.target.value as any})}><option value="top">Top</option><option value="middle">Middle</option><option value="bottom">Bottom</option></select></label><button className="resetCanvasType" onClick={()=>setPageType('16:9')}><RotateCcw size={13}/>Reset to default</button></div>
<details className="canvasAdvancedOptions"><summary>Advanced canvas options</summary><div><label>Horizontal alignment<select value={pageSettings.pageAlignment||'center'} onChange={e=>updatePage(p=>{pageDefaults(p);p.settings!.pageAlignment=e.target.value as any})}><option value="center">Center</option><option value="left">Left</option></select></label><div className="pageSizeActions"><button onClick={()=>updatePage(p=>{pageDefaults(p);const w=p.settings!.pageWidth||1280;p.settings!.pageWidth=p.settings!.pageHeight||720;p.settings!.pageHeight=w;p.settings!.pageSizePreset='Custom';p.settings!.autoFitHeight=false})}>Swap orientation</button><button onClick={()=>updatePage(p=>{pageDefaults(p);const headerH=0;const maxBottom=(p.visuals||[]).reduce((m,v)=>Math.max(m,(v.y||0)+(v.h||30)),0);p.settings!.pageHeight=Math.max(480,Math.ceil((headerH+34+maxBottom+(p.settings!.footerGap||32))/50)*50);p.settings!.pageSizePreset='Custom';p.settings!.autoFitHeight=true})}>Fit height to visuals</button></div><Toggle label="Show canvas grid" value={pageSettings.showGrid!==false} onChange={x=>updatePage(p=>{pageDefaults(p);p.settings!.showGrid=x})}/><Toggle label="Snap visuals to grid" value={pageSettings.snapToGrid!==false} onChange={x=>updatePage(p=>{pageDefaults(p);p.settings!.snapToGrid=x})}/><Toggle label="Allow visuals to overlap" value={pageSettings.allowOverlap===true} onChange={x=>updatePage(p=>{pageDefaults(p);p.settings!.allowOverlap=x})}/></div></details>
</Section>
<Section title="Page background" icon={<PaintBucket size={14}/>}>
<label>Canvas color<ColorControl value={pageSettings.background} onChange={x=>updatePage(p=>{pageDefaults(p);p.settings!.background=x})}/></label>
</Section>
<Section title="Page navigation" icon={<Navigation size={14}/>}>
<Toggle label="Show Previous / Next navigation" value={pageSettings.showNavigation} onChange={x=>updatePage(p=>{pageDefaults(p);p.settings!.showNavigation=x})}/>
{pageSettings.showNavigation&&<>
<label>Navigation position<select value={pageSettings.navigationPosition||'outside'} onChange={e=>updatePage(p=>{pageDefaults(p);p.settings!.navigationPosition=e.target.value as any})}><option value="outside">Bottom outside page</option><option value="sticky">Bottom sticky</option></select></label>
<div className="twoCol"><label>Top margin<input type="number" min="0" max="120" value={pageSettings.navigationTopMargin??16} onChange={e=>updatePage(p=>{pageDefaults(p);p.settings!.navigationTopMargin=+e.target.value})}/></label><label>Bottom margin<input type="number" min="0" max="160" value={pageSettings.navigationBottomMargin??24} onChange={e=>updatePage(p=>{pageDefaults(p);p.settings!.navigationBottomMargin=+e.target.value})}/></label></div>
<div className="formatHint">Navigation is rendered after the complete report page height. It no longer consumes canvas height or floats in the middle of a tall page.</div>
</>}
</Section><Section title="Drill through" icon={<ArrowDownCircle size={14}/>}>
<div className="formatHint">Allow users to drill through to this page from other visuals when they click on a specific category.</div>
<label>Target fields (comma separated)<input placeholder="e.g. Table.Year, Store.City" value={(page.drillThroughFields||[]).join(', ')} onChange={e=>updatePage(p=>{p.drillThroughFields=e.target.value.split(',').map(x=>x.trim()).filter(Boolean)})}/></label>
</Section></div>}</div>;
}

function SelectionPane({page,selectedIds,selectedVisualId,onSelect,onLayer,onReorder,onReorderTab,onBringToFront,onToggleVisibility,onCreateGroup,onUngroup,onCollapse}:{page:Page,selectedIds:string[],selectedVisualId:string|null,onSelect:(id:string,additive:boolean)=>void,onLayer:(mode:'front'|'back'|'forward'|'backward')=>void,onReorder:(sourceId:string,targetId:string)=>void,onReorderTab:(sourceId:string,targetId:string)=>void,onBringToFront:(id:string)=>void,onToggleVisibility:(id:string)=>void,onCreateGroup:(name:string)=>void,onUngroup:()=>void,onCollapse:()=>void}){
  const[draggedId,setDraggedId]=useState<string|null>(null);
  const[activeTab,setActiveTab]=useState<'layer'|'tab'>('layer');
  const[groupName,setGroupName]=useState('');
  const orderedLayer=[...page.visuals].reverse();
  const orderedTab=[...page.visuals].sort((a,b)=>(a.tabOrder??0)-(b.tabOrder??0));
  const hasSelection=selectedIds.length>0||!!selectedVisualId;
  const groups=Array.from(new Set(page.visuals.map(visual=>visual.groupId?.trim()).filter(Boolean) as string[])).sort((a,b)=>a.localeCompare(b));
  const selectedVisuals=page.visuals.filter(visual=>selectedIds.includes(visual.id)||(selectedIds.length===0&&visual.id===selectedVisualId));
  const canUngroup=selectedVisuals.some(visual=>!!visual.groupId);
  const ordered = activeTab==='layer'?orderedLayer:orderedTab;
  return <aside className="selectionPaneGlass" aria-label="Selection and layer order">
      <div className="selectionPaneHeader"><div className="segmentedFormat" style={{marginRight: 'auto', display: 'flex'}}><button className={activeTab==='layer'?'active':''} onClick={()=>setActiveTab('layer')}>Layer order</button><button className={activeTab==='tab'?'active':''} onClick={()=>setActiveTab('tab')}>Tab order</button></div><button title="Collapse Selection pane" aria-label="Collapse Selection pane" onClick={onCollapse}><PanelRightClose size={17}/></button></div>
    {activeTab==='layer'&&<div className="selectionLayerActions"><button disabled={!hasSelection} onClick={()=>onLayer('front')} title="Bring to front">Front</button><button disabled={!hasSelection} onClick={()=>onLayer('forward')} title="Bring forward">Forward</button><button disabled={!hasSelection} onClick={()=>onLayer('backward')} title="Send backward">Backward</button><button disabled={!hasSelection} onClick={()=>onLayer('back')} title="Send to back">Back</button></div>}
    {activeTab==='layer'&&<div className="selectionGroupCreator"><div><input aria-label="Group name" value={groupName} onChange={event=>setGroupName(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'&&hasSelection&&groupName.trim()){onCreateGroup(groupName.trim());setGroupName('')}}} placeholder="New group name"/><button disabled={!hasSelection||!groupName.trim()} onClick={()=>{onCreateGroup(groupName.trim());setGroupName('')}}><Layers3 size={13}/>Group</button></div><button className="selectionUngroup" disabled={!canUngroup} onClick={onUngroup}>Ungroup selected</button>{groups.length>0&&<div className="selectionGroupList">{groups.map(group=>{const members=page.visuals.filter(visual=>visual.groupId?.trim()===group);return <button key={group} title={`Select all ${members.length} visuals`} onClick={()=>members.forEach((visual,index)=>onSelect(visual.id,index>0))}><span>{group}</span><small>{members.length}</small></button>})}</div>}</div>}
    <div className="selectionLayerList">{ordered.map((visual,index)=>{const active=selectedIds.includes(visual.id)||selectedVisualId===visual.id;return <div key={visual.id} draggable className={'selectionLayerRow '+(active?'selected ':'')+(visual.hidden?'hidden ':'')+(draggedId===visual.id?'dragging ':'')} onDragStart={event=>{setDraggedId(visual.id);event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',visual.id)}} onDragEnd={()=>setDraggedId(null)} onDragOver={event=>{event.preventDefault();event.dataTransfer.dropEffect='move'}} onDrop={event=>{event.preventDefault();const sourceId=event.dataTransfer.getData('text/plain')||draggedId;if(sourceId&&sourceId!==visual.id){if(activeTab==='layer')onReorder(sourceId,visual.id);else onReorderTab(sourceId,visual.id);}setDraggedId(null)}} onClick={event=>onSelect(visual.id,event.ctrlKey||event.metaKey||event.shiftKey)}><span className="selectionDragHandle" title="Drag to change order"><GripVertical size={14}/></span><button className="selectionVisibility" title={visual.hidden?'Show visual':'Hide visual'} onClick={event=>{event.stopPropagation();onToggleVisibility(visual.id)}}>{visual.hidden?<EyeOff size={15}/>:<Eye size={15}/>}</button><span className="selectionVisualGlyph">{visualIcon(visual.type)}</span><div><b>{visual.title||visualLabels[visual.type]}</b><small>{visualLabels[visual.type]} · {activeTab==='layer'?'layer '+(orderedLayer.length-index):'tab '+(index+1)}{visual.groupId&&<> · <strong>{visual.groupId}</strong></>}</small></div>{activeTab==='layer'&&<button className="selectionBringFront" disabled={index===0} title={index===0?'Already at front':'Bring this visual to front'} onClick={event=>{event.stopPropagation();onBringToFront(visual.id)}}>{index===0?<em>Front</em>:<ArrowUpCircle size={15}/>}</button>}</div>})}{!ordered.length&&<div className="selectionPaneEmpty">Add a visual to see its order.</div>}</div>
    <div className="selectionPaneHint">Drag rows to reorder {activeTab==='layer'?'layers':'tabs'}. Use the eye to show or hide a visual. Ctrl or Shift-click to select multiple visuals.</div>
  </aside>
}
export default function ReportWorkbench(){
  // Prevent a single gallery gesture from creating the same visual twice.
  // Some browser/input combinations can dispatch duplicate click paths in rapid succession.
  const visualAddGuardRef=useRef<{type:VisualType;at:number}|null>(null);

  const{project,update,selectedVisualId,selectVisual,setView}=useStudio();
  const initial=project?.report.activePageId||project?.report.pages?.[0]?.id||'page-1';
  const[activePage,setActivePage]=useState(initial),[interactionFilterMap,setInteractionFilterMap]=useState<Record<string,VisualFilter>>({}),
  [buttonSelections,setButtonSelections]=useState<Record<string,string>>({}),
  [dataPaneVisible,setDataPaneVisible]=useState(true),[propertiesVisible,setPropertiesVisible]=useState(true),
  [filtersVisible,setFiltersVisible]=useState(false),[selectionPaneVisible,setSelectionPaneVisible]=useState(false),
  [galleryVisible,setGalleryVisible]=useState(true),[pageTabsVisible,setPageTabsVisible]=useState(true),
  [appSidebarVisible,setAppSidebarVisible]=useState(true),[panelMenu,setPanelMenu]=useState(false),
  [designerView,setDesignerView]=useState<'fit'|'actual'|'custom'>('fit'),[designerScale,setDesignerScale]=useState(1),[manualScale,setManualScale]=useState(1),
  [arrangeMenu,setArrangeMenu]=useState(false),
  [selectedVisualIds,setSelectedVisualIds]=useState<string[]>([]),
  [moreVisualsOpen,setMoreVisualsOpen]=useState(false),[moreVisualsSearch,setMoreVisualsSearch]=useState(''),
  [visualCategories,setVisualCategories]=useState<Record<string,string[]>>({}),
  [clipboardCount,setClipboardCount]=useState(0),
  [formatPainter,setFormatPainter]=useState<{sourceId:string;type:VisualType;format:VisualFormat}|null>(null),
  [ribbonTab,setRibbonTab]=useState<'home'|'insert'|'modeling'|'view'|'optimize'>('home');
  const [renamingPageId, setRenamingPageId] = useState<string|null>(null);
  const [draggedPageId, setDraggedPageId] = useState<string|null>(null);
  const [pageContextMenu,setPageContextMenu]=useState<{pageId:string;x:number;y:number}|null>(null);
  const canvasRef=useRef<HTMLDivElement|null>(null);
  const pageSurfaceRef=useRef<HTMLDivElement|null>(null);
  const visualClipboardRef=useRef<Visual[]>([]);
  const imageVisualInputRef=useRef<HTMLInputElement|null>(null);
  const pageHistoryRef=useRef<string[]>([]),authorVisibilityDefaultsRef=useRef<Record<string,boolean>>({});
  useEffect(()=>{document.body.classList.toggle('hideAppSidebar',!appSidebarVisible);return()=>document.body.classList.remove('hideAppSidebar')},[appSidebarVisible]);
  useEffect(()=>{if(!pageContextMenu)return;const close=(event:KeyboardEvent)=>{if(event.key==='Escape')setPageContextMenu(null)};document.addEventListener('keydown',close);return()=>document.removeEventListener('keydown',close)},[pageContextMenu]);
  useEffect(()=>{
    if(!project||designerView==='actual'){setDesignerScale(1);return}
    if(designerView==='custom'){setDesignerScale(manualScale);return}
    const pg=project.report.pages.find(p=>p.id===activePage)||project.report.pages[0];if(!pg)return;
    const width=pg.settings?.pageWidth||1920,height=pg.settings?.pageHeight||1080;const visualBottom=(pg.visuals||[]).reduce((m,v)=>Math.max(m,(v.y||0)+(v.h||100)),0);const headerH=pg.settings?.header?.visible?(pg.settings?.header?.height||84):0;const contentHeight=Math.max(480,headerH+visualBottom+(pg.settings?.footerGap??32));const effectiveHeight=pg.settings?.autoFitHeight?contentHeight:height;const navExtra=pg.settings?.showNavigation?72:0;const wrap=canvasRef.current;if(!wrap)return;
    const compute=()=>{const r=wrap.getBoundingClientRect();const availW=Math.max(500,r.width-22),availH=Math.max(420,r.height-22);setDesignerScale(Math.max(.1,Math.min(availW/width,availH/(effectiveHeight+navExtra))))};
    compute();const ro=new ResizeObserver(compute);ro.observe(wrap);window.addEventListener('resize',compute);return()=>{ro.disconnect();window.removeEventListener('resize',compute)};
  },[project,activePage,designerView,manualScale,dataPaneVisible,propertiesVisible,filtersVisible,appSidebarVisible,pageTabsVisible]);
  if(!project)return null;
  if(!project.report.pages.length){project.report.pages.push({id:'page-1',name:'Page 1',visuals:[],filters:[],settings:defaultPageSettings()})}
  const page=pageDefaults(project.report.pages.find(p=>p.id===activePage)||project.report.pages[0]);const selected=page.visuals.find(v=>v.id===selectedVisualId);const roleId=project.security?.activeRoleId;project.report.filters=project.report.filters||[];
  for(const visual of page.visuals)if(visual.type==='button'&&visual.action?.dynamicLabel!==false)visual.buttonLabel=resolveActionButtonLabel(visual,page,project.report.pages);
  const selectedIds=selectedVisualIds.filter(id=>page.visuals.some(v=>v.id===id));
  const focusCanvas=()=>requestAnimationFrame(()=>pageSurfaceRef.current?.focus({preventScroll:true}));
  const selectOne=(id:string,additive=false)=>{setSelectedVisualIds(previous=>{const valid=previous.filter(x=>page.visuals.some(v=>v.id===x));if(!additive){selectVisual(id);return[id]}const next=valid.includes(id)?valid.filter(x=>x!==id):[...valid,id];selectVisual(next.includes(id)?id:(next[next.length-1]||null));return next});focusCanvas()};
  const interactionFilters=Object.values(interactionFilterMap);
  const allSharedFilters=[...(project.report.filters||[]),...(page.filters||[]),...interactionFilters];
  const updatePage=(fn:(p:Page)=>void)=>update(p=>{const pg=p.report.pages.find(x=>x.id===page.id)!;pageDefaults(pg);fn(pg);return p});
  const setReportFilters=(filters:VisualFilter[])=>update(p=>{p.report.filters=filters;return p});
  const syncGeometry=(items:Record<string,{x:number;y:number;w:number;h:number}>)=>updatePage(pg=>{for(const[id,geometry]of Object.entries(items)){const visual=pg.visuals.find(item=>item.id===id);if(visual)Object.assign(visual,geometry)}});
  const newPageSettings=()=>{const settings=defaultPageSettings(),preset=project.appPreferences?.defaultPageSize||'HD 16:9';const sizes:Record<string,[number,number]>={'HD 16:9':[1280,720],'Full HD 16:9':[1920,1080],'A4 Landscape':[1123,794]};[settings.pageWidth,settings.pageHeight]=sizes[preset]||sizes['HD 16:9'];settings.pageSizePreset=preset;settings.snapToGrid=project.appPreferences?.snapToGrid!==false;settings.showGrid=project.appPreferences?.defaultShowGrid!==false;return settings};
  const newVisual=(type:VisualType):Visual=>{const profile=visualProfile(type);return ({id:crypto.randomUUID(),type,title:visualLabels[type],x:0,y:0,w:type==='shape'?320:Math.max(120,Math.round(profile.w*(s.pageWidth||1920)/12)),h:type==='shape'?160:Math.max(70,profile.h*66-16),geometryVersion:2,rotation:0,zIndex:page.visuals.length,visible:true,locked:false,text:type==='textbox'?'':undefined,buttonLabel:type==='button'?'Go to page':undefined,action:type==='button'?{type:'none'}:undefined,slicerStyle:type==='slicer'?'list':undefined,bindings:{axis:[],values:[],target:[]},filters:[],sort:[],format:{accent:'#118dff',fontSize:(type==='kpi'||type==='card')?28:12,showTitle:!['textbox','button','image','shape'].includes(type),dataLabels:false,background:'#ffffff',fontFamily:project.appPreferences?.defaultFont||'Segoe UI',fieldFormats:{},titleFontSize:12,titleColor:'#242424',labelFontSize:10,labelColor:'#242424',labelPosition:'top',legendVisible:true,legendPosition:'bottom',borderVisible:false,borderColor:'#c8c8c8',borderWidth:1,borderStyle:'solid',borderEdges:{top:true,right:true,bottom:true,left:true},cornerRadius:0,cornerLinked:true,cornerRadii:{topLeft:0,topRight:0,bottomRight:0,bottomLeft:0},shadow:false,backgroundTransparency:0,gridLines:true,showDataPoints:true,dataPointSize:6,tooltipEnabled:true,tooltipBackground:'#ffffff',tooltipColor:'#242424',indicatorEnabled:false,favorableDirection:'up',positiveColor:'#107c10',negativeColor:'#d13438',neutralColor:'#616161',subtitle:'',subtitleVisible:false,subtitleColor:'#616161',subtitleFontSize:10,titleFontWeight:400,axisFontSize:9,axisColor:'#616161',axisTitleVisible:false,markerShape:'circle',lineWidth:2,smoothLines:true,barRadius:0,barWidth:42,padding:type==='shape'?0:8,chartOpacity:100,...(type==='shape'?{visualHeader:false,backgroundEnabled:false,shapeType:'rectangle' as const,shapeFillVisible:true,shapeFill:'#dbeafe',shapeFillTransparency:0,shapeStrokeVisible:false,shapeStroke:'#2563eb',shapeStrokeWidth:2,shapeStrokeStyle:'solid' as const,shapeCornerRadius:18}: {})}})};
  const findSmartSpot=(visuals:Visual[],w:number,h:number)=>{
    const overlaps=(x:number,y:number,v:Visual)=>x<v.x+v.w&&x+w>v.x&&y<v.y+v.h&&y+h>v.y;
    const width=page.settings?.pageWidth||1920;
    const height=page.settings?.pageHeight||1080;
    for(let y=0;y<=height-h;y+=8){for(let x=0;x<=width-w;x+=8){if(!visuals.some(v=>overlaps(x,y,v)))return{x,y}}}
    const cascade = (visuals.length % 10) * 24;
    return{x:cascade, y:cascade};
  };
  const autoBindField=(payload:string)=>{
    const[prefix,...rest]=payload.split(':'),field=rest.join(':');if(!field)return;
    const bind=(v:Visual)=>{
      const existingKeys=(['axis','values','target','tooltips','legend','x','size','min','max','location','latitude','longitude','geometry','detail','color','label','path','country','region','postalCode'] as VisualWellKey[]).filter(k=>((v.bindings as any)[k]||[]).includes(field));
      if(existingKeys.length){for(const k of existingKeys)(v.bindings as any)[k]=((v.bindings as any)[k]||[]).filter((x:string)=>x!==field);return}
      if(prefix==='hierarchy'){const h=(project.model.hierarchies||[]).find((x:any)=>x.id===field);if(h&&visualProfile(v.type).wells.some(w=>w.key==='axis')){v.bindings.hierarchy={id:h.id,level:0};v.bindings.axis=[h.levels[0].field]}return}
      const wells=visualProfile(v.type).wells;
      const inferredRole=v.type==='map'&&prefix==='field'?inferMapRole(field):undefined;
      const preferred:VisualWellKey[]=v.type==='map'?(prefix==='field'?(inferredRole?[inferredRole,'location','detail','color','label']:['location','detail','color','label']):['size','tooltips']):(prefix==='field'?['axis','legend']:['values','target','tooltips']);
      let target=preferred.map(k=>wells.find(w=>w.key===k)).find(w=>w&&!((v.bindings as any)[w.key]||[]).length);
      if(!target&&prefix!=='field')target=wells.find(w=>w.key==='values');
      if(!target&&prefix==='field')target=wells.find(w=>w.key==='axis'||w.key==='legend');
      if(target)(v.bindings as any)[target.key]=[...((v.bindings as any)[target.key]||[]),field];
    };
    if(selected){uv(v=>{bind(v);autoNameFromBindings(v);});return}
    const type:VisualType=prefix==='field'?'table':'column',v=newVisual(type);bind(v);autoNameFromBindings(v);const spot=findSmartSpot(page.visuals,v.w,v.h);v.x=spot.x;v.y=spot.y;updatePage(pg=>pg.visuals.push(v));setTimeout(()=>selectVisual(v.id),0);
  };
    const handleCategoriesLoad=useCallback((id:string,cats:string[])=>{
    setVisualCategories(prev=>{
      const p=prev[id]||[];
      if(p.length===cats.length&&p.every((c,i)=>c===cats[i])) return prev;
      return {...prev,[id]:cats};
    });
  }, []);
const addVisual=(type:VisualType)=>{const now=performance.now();const prev=visualAddGuardRef.current;if(prev&&prev.type===type&&(now-prev.at)<350)return;visualAddGuardRef.current={type,at:now};
    if(selectedVisualId){const current=page.visuals.find(x=>x.id===selectedVisualId);if(current&&current.type!==type){updatePage(pg=>{const v=pg.visuals.find(x=>x.id===selectedVisualId);if(!v)return;const defaults=newVisual(type);const customTitle=v.title!==visualLabels[v.type];v.type=type;v.title=customTitle?v.title:visualLabels[type];v.bindings=sanitizeBindingsForType(type,v.bindings);v.format={...defaults.format,...v.format,fieldFormats:{...(v.format?.fieldFormats||{})}};v.slicerStyle=type==='slicer'?(v.slicerStyle||'list'):undefined;v.text=type==='textbox'?(v.text||defaults.text):undefined;v.richText=type==='textbox'?v.richText:undefined;v.richTextRuns=type==='textbox'?v.richTextRuns:undefined;v.buttonLabel=type==='button'?(v.buttonLabel||defaults.buttonLabel):undefined;v.action=type==='button'?(v.action||defaults.action):undefined;formatDefaults(v)});return}}
    const v=newVisual(type);updatePage(pg=>{const spot=findSmartSpot(pg.visuals,v.w,v.h);v.x=spot.x;v.y=spot.y;pg.visuals.push(v)});setTimeout(()=>selectVisual(v.id),0)};
  const addImageVisual=(file:File)=>uploadBackgroundImage(file,dataUrl=>{const v=newVisual('image');v.imageSrc=dataUrl;v.imageName=file.name;formatDefaults(v);updatePage(pg=>{const spot=findSmartSpot(pg.visuals,v.w,v.h);v.x=spot.x;v.y=spot.y;pg.visuals.push(v)});setTimeout(()=>selectVisual(v.id),0)});
  const addPage=async()=>{const id='page-'+Date.now(),name=(await (window as any).vtabPrompt('Page name','New Page'))||'New Page';update(p=>{p.report.pages.push({id,name,visuals:[],filters:[],settings:newPageSettings()});p.report.activePageId=id;return p});switchPage(id);setInteractionFilterMap({})};
  const switchPage=(id:string,remember=true)=>{if(remember&&id!==page.id)pageHistoryRef.current.push(page.id);setActivePage(id);selectVisual(null);setSelectedVisualIds([]);setInteractionFilterMap({});update(p=>{p.report.activePageId=id;return p})};
  const deletePage=(pageId:string)=>{
    const target=project.report.pages.find(item=>item.id===pageId);if(!target){setPageContextMenu(null);return}
    if(project.report.pages.length<=1){setPageContextMenu(null);alert('A report must contain at least one page. Create another page before deleting this one.');return}
    if(!confirm(`Delete page "${target.name}"?\n\nThe page and its ${target.visuals.length} visual${target.visuals.length===1?'':'s'} will be permanently removed.`)){setPageContextMenu(null);return}
    let result={deleted:false,activePageId:page.id,removedIndex:-1};
    update(state=>{result=removeReportPage(state.report,pageId);return state});
    setPageContextMenu(null);
    if(!result.deleted)return;
    pageHistoryRef.current=pageHistoryRef.current.filter(id=>id!==pageId);
    if(pageId===page.id){setActivePage(result.activePageId);selectVisual(null);setSelectedVisualIds([]);setInteractionFilterMap({});setButtonSelections({})}
  };
  const executeVisualAction=(actionVisual:Visual)=>{
    if(actionVisual.format.buttonSelectionEnabled!==false){const group=(actionVisual.format.buttonSelectionGroup||'default').trim()||'default';setButtonSelections(previous=>({...previous,[group]:actionVisual.id}))}
    const a=actionVisual.action;if(!a||a.type==='none')return;
    if(a.type==='navigate'&&a.targetPageId){switchPage(a.targetPageId);return}
    if(a.type==='back'){const currentIndex=project.report.pages.findIndex(item=>item.id===page.id),previous=pageHistoryRef.current.pop()||project.report.pages[Math.max(0,currentIndex-1)]?.id;if(previous)switchPage(previous,false);return}
    if(a.type==='resetState'||a.type==='clearFilters'){clearAll();if(a.type==='resetState'){setButtonSelections({});updatePage(pg=>{for(const target of pg.visuals){if(Object.prototype.hasOwnProperty.call(authorVisibilityDefaultsRef.current,target.id))target.hidden=authorVisibilityDefaultsRef.current[target.id]}})}return}
    updatePage(pg=>{for(const command of resolveActionCommands(a,pg)){const targets=command.targets;if(!targets.length)continue;for(const target of targets)if(!Object.prototype.hasOwnProperty.call(authorVisibilityDefaultsRef.current,target.id))authorVisibilityDefaultsRef.current[target.id]=!!target.hidden;const allHidden=targets.every(target=>!!target.hidden);for(const target of targets){if(command.operation==='show')target.hidden=false;if(command.operation==='hide')target.hidden=true;if(command.operation==='toggle')target.hidden=!allHidden}}});
  };
  const idx=project.report.pages.findIndex(p=>p.id===page.id);
  const prev=()=>idx>0&&switchPage(project.report.pages[idx-1].id), next=()=>idx<project.report.pages.length-1&&switchPage(project.report.pages[idx+1].id);
  const uv=(fn:(v:Visual)=>void)=>updatePage(pg=>{const v=pg.visuals.find(x=>x.id===selectedVisualId);if(v){formatDefaults(v);fn(v)}});
  const del=()=>{const ids=new Set(selectedIds.length?selectedIds:(selectedVisualId?[selectedVisualId]:[]));updatePage(pg=>pg.visuals=pg.visuals.filter(v=>!ids.has(v.id)));selectVisual(null);setSelectedVisualIds([])};
  const dup=()=>{copySelected();pasteVisuals()};
  const cutSelected=()=>{copySelected();del()};
  const copySelected=()=>{const ids=new Set(selectedIds.length?selectedIds:(selectedVisualId?[selectedVisualId]:[]));const copied=page.visuals.filter(v=>ids.has(v.id)).map(v=>structuredClone(v));visualClipboardRef.current=copied;setClipboardCount(copied.length)};
  const pasteVisuals=()=>{
    const source=visualClipboardRef.current;if(!source.length)return;const idMap=new Map(source.map(v=>[v.id,crypto.randomUUID()]));const pastedIds=source.map(v=>idMap.get(v.id)!);
    let finalDx=0,finalDy=0;
    updatePage(pg=>{const width=pg.settings?.pageWidth||1920,height=pg.settings?.pageHeight||1080,offset=20;const minX=Math.min(...source.map(v=>v.x)),minY=Math.min(...source.map(v=>v.y)),maxRight=Math.max(...source.map(v=>v.x+v.w)),maxBottom=Math.max(...source.map(v=>v.y+v.h));const dx=Math.max(-minX,Math.min(width-maxRight,offset)),dy=Math.max(-minY,Math.min(height-maxBottom,offset));
      finalDx=dx;finalDy=dy;
      for(const original of source){const clone=structuredClone(original);clone.id=idMap.get(original.id)!;clone.x=original.x+dx;clone.y=original.y+dy;clone.zIndex=pg.visuals.length;clone.title=original.title.endsWith(' Copy')?original.title:`${original.title} Copy`;clone.bindings=sanitizeBindingsForType(clone.type,structuredClone(original.bindings));clone.filters=structuredClone(original.filters||[]);clone.sort=structuredClone(original.sort||[]);clone.format={...structuredClone(original.format),fieldFormats:{...(structuredClone(original.format?.fieldFormats||{}))}};
        if(clone.action?.targetVisualId&&idMap.has(clone.action.targetVisualId))clone.action.targetVisualId=idMap.get(clone.action.targetVisualId);
        if(clone.action?.steps)clone.action.steps=clone.action.steps.map(step=>step.targetType==='visual'&&idMap.has(step.targetId)?{...step,targetId:idMap.get(step.targetId)!}:step);
        pg.visuals.push(clone);
      }
    });
    setTimeout(()=>{setSelectedVisualIds(pastedIds);selectVisual(pastedIds[pastedIds.length-1]||null);visualClipboardRef.current=visualClipboardRef.current.map(v=>({...v,x:v.x+finalDx,y:v.y+finalDy}));focusCanvas()},0);
  };
  useEffect(()=>{
    const handleKeyDown=(e:KeyboardEvent)=>{
      const target=e.target as HTMLElement|null;
      if(target?.closest('input,textarea,select,[contenteditable="true"]'))return;
      const key=e.key.toLowerCase(),command=e.ctrlKey||e.metaKey;
      if(command&&key==='c'){if(selectedVisualId){e.preventDefault();copySelected()}return}
      if(command&&key==='x'){if(selectedVisualId){e.preventDefault();cutSelected()}return}
      if(command&&key==='v'){e.preventDefault();pasteVisuals();return}
      if(e.key==='Escape'&&formatPainter){e.preventDefault();setFormatPainter(null);return}
      if(!selectedVisualId)return;
      if(e.key==='Delete'||e.key==='Backspace'){if(target?.closest('.rightPane') || window.getSelection()?.toString().length){e.preventDefault();return;}e.preventDefault();del();return}
      if(command&&key==='d'){e.preventDefault();dup();return}
      if(e.key==='ArrowUp'){e.preventDefault();nudgeSelected(0,e.shiftKey?-10:-1);return}
      if(e.key==='ArrowDown'){e.preventDefault();nudgeSelected(0,e.shiftKey?10:1);return}
      if(e.key==='ArrowLeft'){e.preventDefault();nudgeSelected(e.shiftKey?-10:-1,0);return}
      if(e.key==='ArrowRight'){e.preventDefault();nudgeSelected(e.shiftKey?10:1,0);return}
    };
    document.addEventListener('keydown',handleKeyDown);
    return ()=>document.removeEventListener('keydown',handleKeyDown);
  },[selectedVisualId, selectedIds, formatPainter, page.visuals]);
  const toggleFormatPainter=()=>{if(formatPainter){setFormatPainter(null);return}const source=page.visuals.find(v=>v.id===selectedVisualId);if(source)setFormatPainter({sourceId:source.id,type:source.type,format:structuredClone(source.format)})};
  const selectCanvasVisual=(id:string,additive=false)=>{if(formatPainter&&id!==formatPainter.sourceId){updatePage(pg=>{const target=pg.visuals.find(v=>v.id===id);if(!target||target.locked)return;if(target.type===formatPainter.type)target.format=structuredClone(formatPainter.format);else for(const key of COMMON_FORMAT_PAINTER_KEYS){const value=formatPainter.format[key];if(value!==undefined)(target.format as any)[key]=structuredClone(value)}});setFormatPainter(null)}selectOne(id,additive)};
  const arrangeSelection=(mode:'left'|'center'|'right'|'top'|'middle'|'bottom'|'distributeH'|'distributeV')=>updatePage(pg=>{const items=pg.visuals.filter(v=>selectedIds.includes(v.id));if(items.length<2)return;const minX=Math.min(...items.map(v=>v.x)),maxX=Math.max(...items.map(v=>v.x+v.w)),minY=Math.min(...items.map(v=>v.y)),maxY=Math.max(...items.map(v=>v.y+v.h));for(const v of items){if(mode==='left')v.x=minX;if(mode==='center')v.x=Math.max(0,(minX+maxX-v.w)/2);if(mode==='right')v.x=Math.max(0,maxX-v.w);if(mode==='top')v.y=minY;if(mode==='middle')v.y=Math.max(0,(minY+maxY-v.h)/2);if(mode==='bottom')v.y=Math.max(0,maxY-v.h)}if(mode==='distributeH'&&items.length>2){const sorted=[...items].sort((a,b)=>a.x-b.x),width=sorted.reduce((n,v)=>n+v.w,0),gap=Math.max(0,(maxX-minX-width)/(sorted.length-1));let x=minX;for(const v of sorted){v.x=x;x+=v.w+gap}}if(mode==='distributeV'&&items.length>2){const sorted=[...items].sort((a,b)=>a.y-b.y),height=sorted.reduce((n,v)=>n+v.h,0),gap=Math.max(0,(maxY-minY-height)/(sorted.length-1));let y=minY;for(const v of sorted){v.y=y;y+=v.h+gap}}});
  const layerSelection=(mode:'front'|'back'|'forward'|'backward')=>updatePage(pg=>{const chosen=new Set(selectedIds.length?selectedIds:(selectedVisualId?[selectedVisualId]:[]));if(!chosen.size)return;if(mode==='front'||mode==='back'){const selectedPart=pg.visuals.filter(v=>chosen.has(v.id)),others=pg.visuals.filter(v=>!chosen.has(v.id));pg.visuals=mode==='front'?[...others,...selectedPart]:[...selectedPart,...others];return}const next=[...pg.visuals];if(mode==='forward'){for(let i=next.length-2;i>=0;i--)if(chosen.has(next[i].id)&&!chosen.has(next[i+1].id))[next[i],next[i+1]]=[next[i+1],next[i]]}else{for(let i=1;i<next.length;i++)if(chosen.has(next[i].id)&&!chosen.has(next[i-1].id))[next[i],next[i-1]]=[next[i-1],next[i]]}pg.visuals=next});
  const reorderLayer=(sourceId:string,targetId:string)=>updatePage(pg=>{const frontToBack=[...pg.visuals].reverse(),sourceIndex=frontToBack.findIndex(v=>v.id===sourceId),targetIndex=frontToBack.findIndex(v=>v.id===targetId);if(sourceIndex<0||targetIndex<0||sourceIndex===targetIndex)return;const[moved]=frontToBack.splice(sourceIndex,1);frontToBack.splice(targetIndex,0,moved);pg.visuals=frontToBack.reverse()});
  const reorderTab=(sourceId:string,targetId:string)=>updatePage(pg=>{pg.visuals.forEach((v,i)=>{if(v.tabOrder===undefined)v.tabOrder=i});const ordered=[...pg.visuals].sort((a,b)=>(a.tabOrder??0)-(b.tabOrder??0));const sIdx=ordered.findIndex(v=>v.id===sourceId);const tIdx=ordered.findIndex(v=>v.id===targetId);if(sIdx<0||tIdx<0||sIdx===tIdx)return;const[moved]=ordered.splice(sIdx,1);ordered.splice(tIdx,0,moved);ordered.forEach((v,i)=>v.tabOrder=i);});
  const bringVisualToFront=(id:string)=>updatePage(pg=>{const index=pg.visuals.findIndex(visual=>visual.id===id);if(index<0||index===pg.visuals.length-1)return;const[visual]=pg.visuals.splice(index,1);pg.visuals.push(visual)});
  const toggleVisualVisibility=(id:string)=>updatePage(pg=>{const visual=pg.visuals.find(v=>v.id===id);if(visual)visual.hidden=!visual.hidden});
  const groupSelection=(name:string)=>{const clean=name.trim();if(!clean)return;const ids=new Set(selectedIds.length?selectedIds:(selectedVisualId?[selectedVisualId]:[]));updatePage(pg=>{for(const visual of pg.visuals)if(ids.has(visual.id))visual.groupId=clean})};
  const ungroupSelection=()=>{const ids=new Set(selectedIds.length?selectedIds:(selectedVisualId?[selectedVisualId]:[]));updatePage(pg=>{for(const visual of pg.visuals)if(ids.has(visual.id))visual.groupId=undefined})};
  const placeSelected=(mode:'left'|'center'|'right'|'top'|'next')=>{if(selectedIds.length>1){arrangeSelection(mode==='next'?'distributeV':mode);return}updatePage(pg=>{const v=pg.visuals.find(x=>x.id===selectedVisualId);if(!v)return;const width=pg.settings?.pageWidth||1920;if(mode==='left')v.x=0;if(mode==='center')v.x=Math.max(0,(width-v.w)/2);if(mode==='right')v.x=Math.max(0,width-v.w);if(mode==='top')v.y=0;if(mode==='next'){const others=pg.visuals.filter(x=>x.id!==v.id);v.x=0;v.y=others.reduce((m,x)=>Math.max(m,x.y+x.h),0)+8}})};
  const widthSelected=(w:number)=>updatePage(pg=>{const v=pg.visuals.find(x=>x.id===selectedVisualId);if(!v)return;const width=pg.settings?.pageWidth||1920;v.w=Math.min(width,Math.max(40,w));if(v.x+v.w>width)v.x=Math.max(0,width-v.w)});
  const nudgeSelected=(dx:number,dy:number)=>updatePage(pg=>{const ids=new Set(selectedIds.length?selectedIds:(selectedVisualId?[selectedVisualId]:[]));const width=pg.settings?.pageWidth||1920,height=pg.settings?.pageHeight||1080;for(const v of pg.visuals.filter(x=>ids.has(x.id)&&!x.locked)){v.x=Math.max(0,Math.min(width-v.w,v.x+dx));v.y=Math.max(0,Math.min(height-v.h,v.y+dy))}});
  const autoArrangePremium=()=>updatePage(pg=>{
    const canvasWidth=pg.settings?.pageWidth||1920;
    const margin=24;
    const gap=16;
    const usableWidth=canvasWidth-margin*2;
    const isVisible=(v:Visual)=>v.visible!==false&&!v.hidden;
    
    // Check if user has selected specific visuals to arrange
    const selectedSet = new Set(selectedIds.length ? selectedIds : (selectedVisualId ? [selectedVisualId] : []));
    const targetMovable = selectedSet.size > 1
      ? pg.visuals.filter(v => isVisible(v) && !v.locked && selectedSet.has(v.id))
      : pg.visuals.filter(v => isVisible(v) && !v.locked);
    
    if(!targetMovable.length) return;

    if (selectedSet.size > 1) {
      // Align selected visuals in a horizontal row at their shared top position
      targetMovable.sort((a,b) => a.x - b.x);
      const rowY = Math.min(...targetMovable.map(v => v.y));
      let curX = Math.min(...targetMovable.map(v => v.x));
      for (const v of targetMovable) {
        v.x = Math.round(curX);
        v.y = Math.round(rowY);
        curX += v.w + gap;
      }
    } else {
      // Lay out all visuals in clean horizontal rows side-by-side
      const sorted = [...targetMovable].sort((a,b) => a.y - b.y || a.x - b.x);
      let cursorX = margin;
      let cursorY = margin;
      let currentRowHeight = 0;
      for (const v of sorted) {
        if (cursorX + v.w > usableWidth && cursorX > margin) {
          cursorY += currentRowHeight + gap;
          cursorX = margin;
          currentRowHeight = 0;
        }
        v.x = Math.round(cursorX);
        v.y = Math.round(cursorY);
        currentRowHeight = Math.max(currentRowHeight, v.h);
        cursorX += v.w + gap;
      }
    }
  });
  const clearAll=()=>{
    setInteractionFilterMap({});
    update(p=>{
      p.report.filters=[];
      const pg=p.report.pages.find(x=>x.id===page.id);
      if(pg){
        pg.filters=[];
        pg.visuals.forEach(v=>{v.drillLevel=0;v.drillFilters=[]})
      }
      return p
    })
  };
  const s=page.settings||defaultPageSettings();
  const layoutMode=s.layoutMode||'guided';
  const designerVisualBottom=(page.visuals||[]).reduce((m,v)=>Math.max(m,(v.y||0)+(v.h||100)),0);
  const designerHeaderHeight=0;
  const designerContentHeight=Math.max(480,designerHeaderHeight+34+designerVisualBottom+(s.footerGap??32));
  const designerEffectiveHeight=s.autoFitHeight?designerContentHeight:(s.pageHeight||1080);
  return <div className={'reportWorkspaceGlass '+(formatPainter?'formatPainterActive':'')}>
    <input ref={imageVisualInputRef} className="insertVisualFileInput" type="file" accept="image/*" onChange={e=>{const file=e.target.files?.[0];if(file)addImageVisual(file);e.currentTarget.value=''}}/>
    <nav className="reportContextTabs" aria-label="Report command tabs">
      {(['home','insert','modeling','view','optimize'] as const).map(tab=><button key={tab} className={ribbonTab===tab?'active':''} onClick={()=>setRibbonTab(tab)}>{tab[0].toUpperCase()+tab.slice(1)}</button>)}
    </nav>
    <div className="reportRibbonGlass reportCommandRibbon">
      {ribbonTab==='home'&&<><button className="btnGlass" disabled={!selectedVisualId} onClick={copySelected} title="Copy selected visual(s) (Ctrl+C)"><Copy size={17}/>Copy</button><button className="btnGlass" disabled={!clipboardCount} onClick={pasteVisuals} title="Paste visual(s) (Ctrl+V)"><Clipboard size={17}/>Paste</button><button className={'btnGlass '+(formatPainter?'active':'')} disabled={!selectedVisualId} onClick={toggleFormatPainter} title={formatPainter?'Cancel format painter (Esc)':'Copy formatting, then click another visual'}><PaintBucket size={17}/>Format painter</button><button className="btnGlass" onClick={()=>setView('data')}><FileSpreadsheet size={17}/>Get data</button><button className="btnGlass" onClick={()=>setView('transform')}><SlidersHorizontal size={17}/>Transform data</button><button className="btnGlass" onClick={()=>setView('measures')}><Hash size={17}/>New measure</button><button className="btnGlass" onClick={clearAll}><Eraser size={17}/>Clear filters</button></>}
      {ribbonTab==='insert'&&<><button className="btnGlass" onClick={addPage}><Plus size={17}/>New page</button><button className="btnGlass" onClick={()=>{update(p=>{ensurePaginatedReports(p).push(createPaginatedReport(`Paginated Report ${ensurePaginatedReports(p).length+1}`));return p});setView('paginated')}}><FileJson size={17}/>Paginated report</button><button className="btnGlass" onClick={()=>addVisual('textbox')}><TextCursorInput size={17}/>Text box</button><button className="btnGlass" onClick={()=>imageVisualInputRef.current?.click()}><ImageIcon size={17}/>Image</button><button className="btnGlass" onClick={()=>addVisual('shape')}><LayoutDashboard size={17}/>Shapes</button><button className="btnGlass" onClick={()=>addVisual('button')}><MousePointerClick size={17}/>Button</button><button className="btnGlass" onClick={()=>addVisual('card')}><Hash size={17}/>Card</button><button className="btnGlass" onClick={()=>addVisual('table')}><Table2 size={17}/>Table</button><button className="btnGlass" onClick={()=>addVisual('slicer')}><Filter size={17}/>Slicer</button><button className="btnGlass" onClick={()=>{setMoreVisualsOpen(true);setMoreVisualsSearch('')}}><BarChart3 size={17}/>More visuals</button></>}
      {ribbonTab==='modeling'&&<><button className="btnGlass" onClick={()=>setView('model')}><GitBranch size={17}/>Model view</button><button className="btnGlass" onClick={()=>setView('model')}><Settings2 size={17}/>Relationships</button><button className="btnGlass" onClick={()=>setView('measures')}><Hash size={17}/>Measures</button><button className="btnGlass" onClick={()=>setView('ai-measures')}><Sparkles size={17}/>AI measures</button></>}
      {ribbonTab==='view'&&<><div className="panelMenuWrap"><button className="btnGlass" onClick={()=>setPanelMenu(x=>!x)}><Settings2 size={17}/>Show panes</button>{panelMenu&&<><div style={{position:'fixed',inset:0,zIndex:998}} onPointerDown={(e)=>{e.stopPropagation();setPanelMenu(false)}} /><div className="panelMenuGlass" style={{position:'absolute',zIndex:999}}><label className="checkboxGlass"><input type="checkbox" checked={appSidebarVisible} onChange={e=>setAppSidebarVisible(e.target.checked)}/>Application navigation</label><label className="checkboxGlass"><input type="checkbox" checked={dataPaneVisible} onChange={e=>setDataPaneVisible(e.target.checked)}/>Data pane</label><label className="checkboxGlass"><input type="checkbox" checked={propertiesVisible} onChange={e=>setPropertiesVisible(e.target.checked)}/>Visualizations pane</label><label className="checkboxGlass"><input type="checkbox" checked={filtersVisible} onChange={e=>setFiltersVisible(e.target.checked)}/>Filters pane</label><label className="checkboxGlass"><input type="checkbox" checked={pageTabsVisible} onChange={e=>setPageTabsVisible(e.target.checked)}/>Page tabs</label></div></>}</div><button className={'btnGlass '+(designerView==='fit'?'active':'')} onClick={()=>setDesignerView('fit')}><Maximize2 size={17}/>Fit page</button><button className={'btnGlass '+(designerView==='actual'?'active':'')} onClick={()=>setDesignerView('actual')}><Eye size={17}/>Actual size</button><button className="btnGlass" onClick={()=>{setAppSidebarVisible(false);setDataPaneVisible(false);setPropertiesVisible(false);setFiltersVisible(false)}}><Maximize2 size={17}/>Focus canvas</button></>}
      {ribbonTab==='view'&&<><button className={'btnGlass '+(selectionPaneVisible?'active':'')} onClick={()=>setSelectionPaneVisible(value=>!value)}><Layers3 size={17}/>Selection pane</button><button className={'btnGlass '+(s.showGrid!==false?'active':'')} onClick={()=>updatePage(p=>{pageDefaults(p);p.settings!.showGrid=p.settings!.showGrid===false})}><LayoutDashboard size={17}/>Gridlines</button></>}
      {ribbonTab==='optimize'&&<><div className="panelMenuWrap arrangeMenuWrap"><button className="btnGlass" onClick={()=>setArrangeMenu(x=>!x)}><LayoutDashboard size={17}/>Align & arrange</button>{arrangeMenu&&<><div style={{position:'fixed',inset:0,zIndex:998}} onPointerDown={(e)=>{e.stopPropagation();setArrangeMenu(false)}} /><div className="panelMenuGlass arrangeCommandMenu" style={{position:'absolute',zIndex:999}}><button disabled={selectedIds.length<2} onClick={()=>{arrangeSelection('left');setArrangeMenu(false)}}>Align left</button><button disabled={selectedIds.length<2} onClick={()=>{arrangeSelection('center');setArrangeMenu(false)}}>Align center</button><button disabled={selectedIds.length<2} onClick={()=>{arrangeSelection('right');setArrangeMenu(false)}}>Align right</button><button disabled={selectedIds.length<2} onClick={()=>{arrangeSelection('top');setArrangeMenu(false)}}>Align top</button><button disabled={selectedIds.length<2} onClick={()=>{arrangeSelection('middle');setArrangeMenu(false)}}>Align middle</button><button disabled={selectedIds.length<2} onClick={()=>{arrangeSelection('bottom');setArrangeMenu(false)}}>Align bottom</button><button disabled={selectedIds.length<3} onClick={()=>{arrangeSelection('distributeH');setArrangeMenu(false)}}>Distribute horizontally</button><button disabled={selectedIds.length<3} onClick={()=>{arrangeSelection('distributeV');setArrangeMenu(false)}}>Distribute vertically</button><hr/><button disabled={!selectedVisualId} onClick={()=>{layerSelection('front');setArrangeMenu(false)}}>Bring to front</button><button disabled={!selectedVisualId} onClick={()=>{layerSelection('forward');setArrangeMenu(false)}}>Bring forward</button><button disabled={!selectedVisualId} onClick={()=>{layerSelection('backward');setArrangeMenu(false)}}>Send backward</button><button disabled={!selectedVisualId} onClick={()=>{layerSelection('back');setArrangeMenu(false)}}>Send to back</button></div></>}</div><button className="btnGlass" onClick={autoArrangePremium}><LayoutDashboard size={17}/>Auto arrange</button><button className={'btnGlass '+(s.allowOverlap!==true?'active':'')} onClick={()=>updatePage(p=>{pageDefaults(p);p.settings!.allowOverlap=!p.settings!.allowOverlap})}><Layers3 size={17}/>Prevent overlap</button></>}
    </div>
    <div className="reportRibbonGlass legacyReportRibbon" aria-hidden="true">
      <div className="panelMenuWrap"><button className="btnGlass" onClick={()=>setPanelMenu(x=>!x)}><Settings2 size={14}/>Panels</button>{panelMenu&&<><div style={{position:'fixed',inset:0,zIndex:998}} onPointerDown={(e)=>{e.stopPropagation();setPanelMenu(false)}} /><div className="panelMenuGlass" style={{position:'absolute',zIndex:999}}>
        <label className="checkboxGlass"><input type="checkbox" checked={appSidebarVisible} onChange={e=>setAppSidebarVisible(e.target.checked)}/>Application navigation</label>
        <label className="checkboxGlass"><input type="checkbox" checked={dataPaneVisible} onChange={e=>setDataPaneVisible(e.target.checked)}/>Data / Fields pane</label>
        <label className="checkboxGlass"><input type="checkbox" checked={propertiesVisible} onChange={e=>setPropertiesVisible(e.target.checked)}/>Right authoring pane</label>
        <label className="checkboxGlass"><input type="checkbox" checked={filtersVisible} onChange={e=>setFiltersVisible(e.target.checked)}/>Filters pane</label>
        <label className="checkboxGlass"><input type="checkbox" checked={galleryVisible} onChange={e=>setGalleryVisible(e.target.checked)}/>Visualizations section</label>
        <label className="checkboxGlass"><input type="checkbox" checked={pageTabsVisible} onChange={e=>setPageTabsVisible(e.target.checked)}/>Page tabs</label>
        <button className="btnGlass" onClick={()=>{setAppSidebarVisible(true);setDataPaneVisible(true);setPropertiesVisible(true);setFiltersVisible(true);setGalleryVisible(true);setPageTabsVisible(true)}}>Show all panels</button>
        <button className="btnGlass" onClick={()=>{setAppSidebarVisible(false);setDataPaneVisible(false);setPropertiesVisible(false);setFiltersVisible(false);setGalleryVisible(false);setPageTabsVisible(false)}}>Focus canvas</button>
      </div></>}</div>
      <button className={'btnGlass paneQuickToggle navigationQuickToggle '+(appSidebarVisible?'active':'')} onClick={()=>setAppSidebarVisible(!appSidebarVisible)} title="Show or hide application navigation"><Navigation size={14}/>Navigation</button>
      <button className={'btnGlass paneQuickToggle '+(dataPaneVisible?'active':'')} onClick={()=>setDataPaneVisible(!dataPaneVisible)}>{dataPaneVisible?<PanelLeftClose size={14}/>:<PanelLeftOpen size={14}/>}Fields</button>
      <button className={'btnGlass paneQuickToggle '+(propertiesVisible?'active':'')} onClick={()=>setPropertiesVisible(!propertiesVisible)}>{propertiesVisible?<PanelRightClose size={14}/>:<PanelRightOpen size={14}/>}Properties</button>
      <button className={'btnGlass paneQuickToggle '+(filtersVisible?'active':'')} onClick={()=>setFiltersVisible(!filtersVisible)}><Filter size={14}/>Filters</button>
      <button className="btnGlass" onClick={()=>{setAppSidebarVisible(false);setDataPaneVisible(false);setPropertiesVisible(false);setFiltersVisible(false);setGalleryVisible(false)}} title="Hide navigation and authoring panes to maximize the canvas"><Maximize2 size={14}/>Focus Canvas</button>
      <div className="ribbonSpacerGlass"/><div className="designerViewToggleGlass"><button className={'btnGlass '+(designerView==='fit'?'active':'')} onClick={()=>setDesignerView('fit')}><Maximize2 size={14}/>Fit Report</button><button className={'btnGlass '+(designerView==='actual'?'active':'')} onClick={()=>setDesignerView('actual')}><Eye size={14}/>Actual Size</button><div className="zoomControls"><button className="iconGlass" onClick={()=>{setDesignerView('custom');setManualScale(s=>Math.max(0.25,s-0.25))}}>-</button><span className="zoomLabel">{Math.round((designerView==='custom'?manualScale:designerScale)*100)}%</span><button className="iconGlass" onClick={()=>{setDesignerView('custom');setManualScale(s=>Math.min(3,s+0.25))}}>+</button></div></div><div className="layoutModeToggleGlass"><button className={'btnGlass '+(s.layoutMode==='guided'?'active':'')} onClick={()=>updatePage(p=>{pageDefaults(p);p.settings!.layoutMode='guided';p.settings!.allowOverlap=false;p.settings!.snapToGrid=true})}>Guided</button><button className={'btnGlass '+(s.layoutMode!=='guided'?'active':'')} onClick={()=>updatePage(p=>{pageDefaults(p);p.settings!.layoutMode='freeform';p.settings!.allowOverlap=true;p.settings!.snapToGrid=false})}>Freeform</button></div><div className="arrangeMenuWrap"><button className="btnGlass" onClick={()=>setArrangeMenu(x=>!x)}><LayoutDashboard size={14}/>Arrange</button>{arrangeMenu&&<><div style={{position:'fixed',inset:0,zIndex:998}} onPointerDown={(e)=>{e.stopPropagation();setArrangeMenu(false)}} /><div className="arrangeMenuGlass" style={{position:'absolute',zIndex:999}}><button className="btnGlass" onClick={()=>{autoArrangePremium();setArrangeMenu(false)}}>Premium layout</button><button className="btnGlass" disabled={!selected} onClick={()=>{placeSelected('left');setArrangeMenu(false)}}>Align left</button><button className="btnGlass" disabled={!selected} onClick={()=>{placeSelected('center');setArrangeMenu(false)}}>Center</button><button className="btnGlass" disabled={!selected} onClick={()=>{placeSelected('right');setArrangeMenu(false)}}>Align right</button><button className="btnGlass" disabled={!selected} onClick={()=>{placeSelected('next');setArrangeMenu(false)}}>Move next</button></div></>}</div><button className="btnGlass" onClick={clearAll}><Eraser size={14}/>Clear Filters</button><button className="btnGlass" onClick={prev} disabled={idx===0} aria-label="Action"><ChevronLeft size={14}/></button><button className="btnGlass" onClick={next} disabled={idx===project.report.pages.length-1} aria-label="Action"><ChevronRight size={14}/></button><button className="btnGlass primary" onClick={addPage}><Plus size={14}/>New Page</button></div>
    <div className={'reportBodyGlass '+(!dataPaneVisible?'dataPaneHidden ':'')+(!propertiesVisible?'propertiesPaneHidden ':'')+(!filtersVisible?'filtersPaneHidden ':'')}>
      {dataPaneVisible&&<Fields project={project} selectedBindings={selected?.bindings} onAutoBind={autoBindField} onCollapse={()=>setDataPaneVisible(false)}/>}<div className="canvasStageGlass"><div className="canvasToplineGlass"><div><b>{page.name}</b><span>{s.pageWidth||1920} × {s.pageHeight||1080} · {designerView==='fit'?'Fit view':'Actual size'}</span></div>{s.showNavigation&&<div className="navControlsGlass"><button className="btnGlass" onClick={prev} disabled={idx===0}><ChevronLeft size={14}/>Previous</button><button className="btnGlass" onClick={clearAll}><Eraser size={14}/>Clear Filters</button><span>Page {idx+1} of {project.report.pages.length}</span><button className="btnGlass" onClick={next} disabled={idx===project.report.pages.length-1}>Next<ChevronRight size={14}/></button></div>}<div className="filterSummaryGlass"><Filter size={12}/>{(project.report.filters?.length||0)+(page.filters?.length||0)+interactionFilters.length} active</div></div>
      <div className={'canvasWrapGlass align-'+(s.pageAlignment||'center')+' valign-'+(s.pageVerticalAlignment||'top')+' '+(s.showGrid!==false?'showDesignerGrid':'hideDesignerGrid')} ref={canvasRef} style={{backgroundColor:'transparent'}}>
        <div className="designerScaleFrameGlass" style={{width:(s.pageWidth||1920)*designerScale,height:designerEffectiveHeight*designerScale}}>
        <div ref={pageSurfaceRef} className="reportPageSurfaceGlass" role="application" aria-label={`${page.name} report canvas`} onMouseDown={e=>{if(!(e.target as HTMLElement).closest('.visualCard')){selectVisual(null);setSelectedVisualIds([]);setFormatPainter(null)}}} style={{background:s.background,width:s.pageWidth||1920,height:designerEffectiveHeight,minHeight:designerEffectiveHeight,transform:`scale(${designerScale})`,transformOrigin:'top left'}}>
          {s.backgroundImage&&<div className={'pageBackgroundImage fit-'+(s.backgroundImageFit||'cover')} style={{backgroundImage:`url(${s.backgroundImage})`,opacity:(s.backgroundImageOpacity??24)/100}}/>}
          <div className="pageContentLayer">

          <CanvasObjectInteractionManager visuals={page.visuals} selectedIds={selectedIds} primaryId={selectedVisualId} scale={designerScale} canvasWidth={s.pageWidth||1920} canvasHeight={Math.max(520,designerEffectiveHeight-designerHeaderHeight)} snapToGrid={false} preventOverlap={s.allowOverlap!==true} onSelect={selectCanvasVisual} onGeometry={syncGeometry} render={v=><VisualCard v={v} model={project.model} project={project} selected={selectedIds.includes(v.id)||selectedVisualId===v.id} actionSelected={buttonSelections[(v.format.buttonSelectionGroup||'default').trim()||'default']===v.id} onSelect={additive=>selectCanvasVisual(v.id,additive)} roleId={roleId} extraFilters={[...(project.report.filters||[]),...(page.filters||[]),...Object.entries(interactionFilterMap).filter(([owner])=>owner!==v.id).map(([,f])=>f)]} activeInteractionFilter={interactionFilterMap[v.id]} onDrillThrough={(pid, f) => { switchPage(pid); update(p => { const targetPage = p.report.pages.find(x=>x.id===pid); if (targetPage) { targetPage.filters = [...(targetPage.filters||[]).filter(z=>z.field!==f.field), f]; } return p; }); }} onSlicer={f=>setInteractionFilterMap(prev=>{const next={...prev};if(f)next[v.id]=f;else delete next[v.id];return next})} onChange={fn=>updatePage(pg=>{const vv=pg.visuals.find(x=>x.id===v.id);if(vv)fn(vv)})} onAction={executeVisualAction} onDuplicate={()=>{const newId=crypto.randomUUID();updatePage(pg=>{const src=pg.visuals.find(x=>x.id===v.id);if(src){const n=structuredClone(src);n.id=newId;n.zIndex=pg.visuals.length;n.bindings=sanitizeBindingsForType(n.type,structuredClone(src.bindings));n.filters=structuredClone(src.filters||[]);n.format={...structuredClone(src.format),fieldFormats:{...(structuredClone(src.format?.fieldFormats||{}))}};const spot=findSmartSpot(pg.visuals,n.w,n.h);n.x=spot.x;n.y=spot.y;n.title+=' Copy';pg.visuals.push(n)}});setTimeout(()=>selectOne(newId),0)}} onDelete={()=>{if(selectedIds.includes(v.id)||selectedVisualId===v.id)del();else{updatePage(pg=>{pg.visuals=pg.visuals.filter(x=>x.id!==v.id)});setSelectedVisualIds(ids=>ids.filter(id=>id!==v.id));if(selectedVisualId===v.id)selectVisual(null)}}} onCategoriesLoad={handleCategoriesLoad}/>}/>
          
          </div>
        </div>
        </div>
      </div></div>
      {selectionPaneVisible&&<SelectionPane page={page} selectedIds={selectedIds} selectedVisualId={selectedVisualId} onSelect={selectOne} onLayer={layerSelection} onReorder={reorderLayer} onReorderTab={reorderTab} onBringToFront={bringVisualToFront} onToggleVisibility={toggleVisualVisibility} onCreateGroup={groupSelection} onUngroup={ungroupSelection} onCollapse={()=>setSelectionPaneVisible(false)}/>} 
      {filtersVisible&&<FiltersDock model={project.model} visual={selected} updateVisual={uv} page={page} updatePage={updatePage} reportFilters={project.report.filters||[]} setReportFilters={setReportFilters} onCollapse={()=>setFiltersVisible(false)}/>} 
      {propertiesVisible&&<RightPane model={{...project.model,__pages:project.report.pages}} visual={selected} updateVisual={uv} removeVisual={del} duplicate={dup} page={page} updatePage={updatePage} reportFilters={project.report.filters||[]} setReportFilters={setReportFilters} addVisual={addVisual} galleryVisible={galleryVisible} onCollapse={()=>setPropertiesVisible(false)} selectedIds={selectedIds}/>} 
    </div>
    {(allSharedFilters.length>0)&&<div className="activeFilterStripGlass"><b>Active filters</b>{allSharedFilters.map((f,i)=><span key={i}>{f.field} {f.operator} {String(f.value)}</span>)}<button className="btnGlass" onClick={clearAll}>Clear all</button></div>}
    {pageTabsVisible&&<div className="pageTabsGlass"><button className="iconGlass navMini" title="Previous page" onClick={prev} disabled={idx===0} aria-label="Action"><ChevronLeft size={14}/></button><button className="iconGlass navMini" title="Next page" onClick={next} disabled={idx===project.report.pages.length-1} aria-label="Action"><ChevronRight size={14}/></button>{project.report.pages.map(p=>renamingPageId===p.id?<input key={p.id} className="pageTabGlass active" autoFocus defaultValue={p.name} onBlur={e=>{update(state=>{const pg=state.report.pages.find(x=>x.id===p.id);if(pg)pg.name=e.target.value||'Page';return state});setRenamingPageId(null)}} onKeyDown={e=>{if(e.key==='Enter')e.currentTarget.blur();if(e.key==='Escape')setRenamingPageId(null)}} />:<button key={p.id} draggable onDragStart={e=>{setPageContextMenu(null);setDraggedPageId(p.id);e.dataTransfer.effectAllowed='move'}} onDragOver={e=>{e.preventDefault();e.dataTransfer.dropEffect='move'}} onDrop={e=>{e.preventDefault();if(!draggedPageId||draggedPageId===p.id)return;update(state=>{const from=state.report.pages.findIndex(x=>x.id===draggedPageId),to=state.report.pages.findIndex(x=>x.id===p.id);if(from>=0&&to>=0){const[moved]=state.report.pages.splice(from,1);state.report.pages.splice(to,0,moved)}return state});setDraggedPageId(null)}} onClick={()=>{setPageContextMenu(null);switchPage(p.id)}} onDoubleClick={()=>{setPageContextMenu(null);setRenamingPageId(p.id)}} onContextMenu={e=>{e.preventDefault();e.stopPropagation();setPageContextMenu({pageId:p.id,x:Math.min(e.clientX,Math.max(8,window.innerWidth-196)),y:Math.max(8,Math.min(e.clientY-94,window.innerHeight-120))})}} className={'pageTabGlass '+(page.id===p.id?'active':'')+(draggedPageId===p.id?' dragging':'')}>{p.name}</button>)}<button className="iconGlass addPageTab" title="New page" onClick={addPage} aria-label="Action"><Plus size={16}/></button><div className="reportStatusSpacer"/><span className="reportStatusText">Page {idx+1} of {project.report.pages.length}  {page.visuals.length} visuals</span><div className="powerBiZoomBar"><button title="Zoom out" onClick={()=>{const current=designerView==='custom'?manualScale:designerScale;setManualScale(Math.max(.25,current-.05));setDesignerView('custom')}}>-</button><input className="statusZoomSlider" aria-label="Canvas zoom" type="range" min="25" max="200" step="5" value={Math.round((designerView==='custom'?manualScale:designerScale)*100)} onChange={e=>{setManualScale(+e.target.value/100);setDesignerView('custom')}}/><button title="Zoom in" onClick={()=>{const current=designerView==='custom'?manualScale:designerScale;setManualScale(Math.min(2,current+.05));setDesignerView('custom')}}>+</button><span className="reportStatusZoom">{Math.round((designerView==='custom'?manualScale:designerScale)*100)}%</span><button className="statusFitButton" title="Fit page to available space" onClick={()=>setDesignerView('fit')}><Maximize2 size={14}/><span>Fit page</span></button></div></div>}
    {pageContextMenu&&createPortal(<div className="pageTabContextBackdrop" onPointerDown={()=>setPageContextMenu(null)} onContextMenu={e=>{e.preventDefault();setPageContextMenu(null)}}><div className="pageTabContextMenu" role="menu" aria-label="Page options" style={{left:pageContextMenu.x,top:pageContextMenu.y}} onPointerDown={e=>e.stopPropagation()}><b>{project.report.pages.find(item=>item.id===pageContextMenu.pageId)?.name||'Page'}</b><button role="menuitem" onClick={()=>{setRenamingPageId(pageContextMenu.pageId);setPageContextMenu(null)}}><Type size={14}/>Rename page</button><button role="menuitem" className="danger" disabled={project.report.pages.length<=1} title={project.report.pages.length<=1?'A report must contain at least one page':''} onClick={()=>deletePage(pageContextMenu.pageId)}><Trash2 size={14}/>Delete page</button>{project.report.pages.length<=1&&<small>Create another page before deleting this one.</small>}</div></div>,document.body)}
    {moreVisualsOpen&&createPortal(
      <div className="moreVisualsOverlay" role="dialog" aria-modal="true" aria-label="More visuals" onClick={e=>{if((e.target as HTMLElement).classList.contains('moreVisualsOverlay'))setMoreVisualsOpen(false)}}>
        <div className="moreVisualsDialog">
          <div className="moreVisualsHeader">
            <div><b>More visuals</b><small>Choose a visual type to add to the canvas</small></div>
            <button className="iconGlass" onClick={()=>setMoreVisualsOpen(false)} title="Close"><X size={16}/></button>
          </div>
          <div className="moreVisualsSearch">
            <Search size={13}/>
            <input autoFocus placeholder="Search visuals…" value={moreVisualsSearch} onChange={e=>setMoreVisualsSearch(e.target.value)} onKeyDown={e=>{if(e.key==='Escape')setMoreVisualsOpen(false)}}/>
          </div>
          <div className="moreVisualsGrid">
            {visualTypes.filter(t=>!moreVisualsSearch||visualLabels[t].toLowerCase().includes(moreVisualsSearch.toLowerCase())).map(type=>(
              <button key={type} className="moreVisualsItem" title={visualLabels[type]} onClick={()=>{addVisual(type);setMoreVisualsOpen(false)}}>
                {visualIcon(type)}
                <span>{visualLabels[type]}</span>
              </button>
            ))}
          </div>
        </div>
      </div>,
      document.body
    )}
  </div>;
}









