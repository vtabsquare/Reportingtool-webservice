import{useState}from'react';
import{CheckCircle2,Download,FileText,LoaderCircle}from'lucide-react';
import{apiDownloadPost}from'../api';

function filename(report:any){return String(report?.rendering?.fileNameTemplate||report?.name||'Paginated_Report').replace(/\{\{[^}]+\}\}/g,'Report').replace(/[^A-Za-z0-9_.-]+/g,'_').replace(/\.pdf$/i,'')+'.pdf'}

export default function PaginatedReportViewer({reportId,project,filters,cloudMode,initialDefinitionId}:{reportId:string;project:any;filters:any[];cloudMode:boolean;initialDefinitionId?:string}){
  const reports=project?.paginatedReports||[];
  const[activeId,setActiveId]=useState(initialDefinitionId||reports[0]?.id||'');
  const[parameters,setParameters]=useState<Record<string,any>>({});
  const[busy,setBusy]=useState(false),[error,setError]=useState(''),[complete,setComplete]=useState(false);
  const active=reports.find((item:any)=>item.id===activeId)||reports[0];
  const page=active?.page||{};
  const orientation=page.orientation||'portrait';
  const dims=orientation==='landscape'?[Math.max(page.widthMm||210,page.heightMm||297),Math.min(page.widthMm||210,page.heightMm||297)]:[Math.min(page.widthMm||210,page.heightMm||297),Math.max(page.widthMm||210,page.heightMm||297)];
  const scale=Math.min(2.2,560/dims[0]);
  const generate=async()=>{
    if(!active||busy)return;setBusy(true);setError('');setComplete(false);
    try{
      const payload={definitionId:active.id,filters,parameters,roleId:project.security?.activeRoleId,...(cloudMode?{project}:{})};
      await apiDownloadPost(cloudMode?'/published/paginated/pdf-snapshot':`/published/${reportId}/paginated/pdf`,filename(active),payload);
      setComplete(true);
    }catch(reason:any){setError(reason?.message||String(reason))}finally{setBusy(false)}
  };
  if(!active)return <div className="paginatedServiceEmpty">No paginated report was included in this publication.</div>;
  return <div className="paginatedService">
    <aside><h3>Paginated reports</h3>{reports.map((report:any)=><button key={report.id} className={report.id===active.id?'active':''} onClick={()=>{setActiveId(report.id);setComplete(false);setError('')}}><FileText size={16}/><span><b>{report.name}</b><small>{report.page?.size||'A4'} · {report.page?.orientation||'portrait'}</small></span></button>)}</aside>
    <main><div className="paginatedServiceHeading"><div><small>PUBLISHED PAGINATED REPORT</small><h2>{active.name}</h2><p>Configure parameters, then generate a server-rendered PDF using the current report filter context.</p></div><button onClick={generate} disabled={busy}>{busy?<LoaderCircle className="spin" size={17}/>:<Download size={17}/>} {busy?'Generating PDF…':'Generate PDF'}</button></div>{error&&<div className="paginatedServiceError">{error}</div>}{complete&&<div className="paginatedServiceSuccess"><CheckCircle2 size={15}/>PDF generated successfully.</div>}<div className="paginatedServiceContent"><section className="paginatedServicePreview"><div className="paginatedServicePaper" style={{width:dims[0]*scale,height:dims[1]*scale}}><header>{active.header?.items?.map((item:any)=><span key={item.id} style={{textAlign:item.align||'left'}}>{item.type==='text'?item.value:' '}</span>)}</header><div className="paginatedServiceTable"><div className="paginatedServiceTableHead">{active.table?.columns?.map((column:any)=><span key={column.id}>{column.label}</span>)}</div>{Array.from({length:8},(_,index)=><div className="paginatedServiceTableRow" key={index}>{active.table?.columns?.map((column:any)=><span key={column.id}>—</span>)}</div>)}</div><footer>{active.footer?.items?.map((item:any)=><span key={item.id} style={{textAlign:item.align||'right'}}>{item.type==='text'?item.value:' '}</span>)}</footer></div></section><aside className="paginatedServiceParameters"><h3>Parameters</h3>{!active.parameters?.length?<p>No additional parameters are required. Current dashboard filters will still be applied.</p>:active.parameters.map((parameter:any)=><label key={parameter.id}><span>{parameter.label||parameter.name}{parameter.required?' *':''}</span>{parameter.type==='boolean'?<input type="checkbox" checked={!!(parameters[parameter.name]??parameter.defaultValue)} onChange={event=>setParameters(value=>({...value,[parameter.name]:event.target.checked}))}/>:parameter.type==='single'?<select value={parameters[parameter.name]??parameter.defaultValue??''} onChange={event=>setParameters(value=>({...value,[parameter.name]:event.target.value}))}><option value="">Select…</option>{(parameter.values||[]).map((value:string)=><option key={value}>{value}</option>)}</select>:<input type={parameter.type==='date'?'date':parameter.type==='number'?'number':'text'} value={parameters[parameter.name]??parameter.defaultValue??''} onChange={event=>setParameters(value=>({...value,[parameter.name]:event.target.value}))}/>}</label>)}<div className="paginatedFilterContext"><b>Current filter context</b><span>{filters.length?`${filters.length} active filter${filters.length===1?'':'s'} will be applied.`:'No interactive filters are currently selected.'}</span></div></aside></div></main>
  </div>;
}
