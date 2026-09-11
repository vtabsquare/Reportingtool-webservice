import {useEffect,useState} from 'react';
import {BarChart3,CalendarClock,Copy,Edit3,FilePlus2,MoreHorizontal,RefreshCcw,Search,Trash2,Type} from 'lucide-react';
import {api} from '../api';
import {useStudio} from '../store';

type SavedReport={
  id:string;
  name:string;
  pages:number;
  visuals:number;
  created_at:string;
  updated_at:string;
  report:any;
};

export default function SavedReports(){
  const{replaceProject,setView}=useStudio();
  const[items,setItems]=useState<SavedReport[]>([]);
  const[search,setSearch]=useState('');
  const[loading,setLoading]=useState(false);

  const[promptDialog,setPromptDialog]=useState<{title:string,defaultValue:string,onConfirm:(val:string)=>void}|null>(null);

  const load=async()=>{
    setLoading(true);
    try{setItems(await api<SavedReport[]>('/reports'))}
    finally{setLoading(false)}
  };
  useEffect(()=>{load()},[]);

  const open=(id:string)=>{
    const url=`${window.location.origin}${window.location.pathname}?editReport=${encodeURIComponent(id)}`;
    const opened=window.open(url,'_blank');
    if(opened)opened.opener=null;else window.location.assign(url);
  };

  const newReport=()=>{
    setPromptDialog({
      title:'Name your new report',
      defaultValue:'New Analytics Report',
      onConfirm:async(name)=>{
        setPromptDialog(null);
        if(!name.trim())return;
        const p=await api<any>('/projects/new',{method:'POST',body:JSON.stringify({name:name.trim()})});
        replaceProject(p);setView('data');
      }
    });
  };

  const duplicate=async(id:string)=>{
    await api(`/reports/${id}/duplicate`,{method:'POST'});
    await load();
  };

  const rename=(item:SavedReport)=>{
    setPromptDialog({
      title:'Rename report',
      defaultValue:item.name,
      onConfirm:async(name)=>{
        setPromptDialog(null);
        if(!name.trim()||name.trim()===item.name)return;
        await api(`/reports/${item.id}/rename`,{method:'POST',body:JSON.stringify({name:name.trim()})});
        await load();
      }
    });
  };

  const remove=async(item:SavedReport)=>{
    if(!window.confirm(`Delete "${item.name}"?`))return;
    await api(`/reports/${item.id}`,{method:'DELETE'});
    await load();
  };

  const filtered=items.filter(x=>x.name.toLowerCase().includes(search.toLowerCase()));

  function PromptModal({title,defaultValue,onConfirm,onCancel}:{title:string,defaultValue:string,onConfirm:(v:string)=>void,onCancel:()=>void}){
    const [val,setVal]=useState(defaultValue);
    return <div className="fancyDialogOverlay" onClick={onCancel}>
      <div className="fancyDialogContent" onClick={e=>e.stopPropagation()}>
        <div className="fancyDialogHeader">
          <h3>{title}</h3>
          <p>Give your report a clear, descriptive name. You can rename it anytime.</p>
        </div>
        <div className="fancyDialogInputWrap">
          <input autoFocus className="fancyDialogInput" value={val} onChange={e=>setVal(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')onConfirm(val);if(e.key==='Escape')onCancel()}} placeholder="e.g. Q3 Sales Report"/>
          {val&&<button className="fancyDialogClearBtn" onClick={()=>setVal('')} title="Clear">×</button>}
        </div>
        <div className="fancyDialogActions">
          <button className="btnGlass" onClick={onCancel}>Cancel</button>
          <button className="btnGlass primary" onClick={()=>onConfirm(val)}>Continue →</button>
        </div>
      </div>
    </div>
  }

  return <div className="page savedReportsPage">
    <div className="savedReportsHero">
      <div>
        <span className="eyebrow">REPORT LIBRARY</span>
        <h1>Saved Reports</h1>
        <p>Open an existing report, continue editing, save new versions, duplicate it, or start from a blank report.</p>
      </div>
      <div className="savedReportActions">
        <button onClick={load}><RefreshCcw size={15}/>{loading?'Refreshing...':'Refresh'}</button>
        <button className="primary" onClick={newReport}><FilePlus2 size={16}/>New Report</button>
      </div>
    </div>

    <div className="reportLibraryToolbar">
      <div className="search"><Search size={15}/><input placeholder="Search saved reports..." value={search} onChange={e=>setSearch(e.target.value)}/></div>
      <span>{filtered.length} report{filtered.length===1?'':'s'}</span>
    </div>

    <div className="reportLibraryGrid">
      {filtered.map(item=><article className="savedReportCard" key={item.id}>
        <div className="savedReportPreview">
          <div className="previewHeader"></div>
          <div className="previewKpi"></div>
          <div className="previewChart"></div>
        </div>
        <div className="savedReportContent">
          <div className="savedReportTitle">
            <div><b>{item.name}</b><small>{item.id.slice(0,8)}</small></div>
            <MoreHorizontal size={18}/>
          </div>
          <div className="savedReportMeta">
            <span><Type size={13}/>{item.pages} page{item.pages===1?'':'s'}</span>
            <span><BarChart3 size={13}/>{item.visuals} visuals</span>
            <span><CalendarClock size={13}/>{item.updated_at?.replace('T',' ').slice(0,16)||'Saved'}</span>
          </div>
          <div className="savedReportButtons">
            <button className="primary" onClick={()=>open(item.id)}><Edit3 size={14}/>Open / Edit</button>
            <button onClick={()=>duplicate(item.id)} title="Duplicate"><Copy size={14}/></button>
            <button onClick={()=>rename(item)} title="Rename"><Type size={14}/></button>
            <button className="dangerBtn" onClick={()=>remove(item)} title="Delete"><Trash2 size={14}/></button>
          </div>
        </div>
      </article>)}
      {!filtered.length&&<div className="libraryEmpty"><FilePlus2 size={32}/><b>No saved reports found</b><span>Create a new report and click Save. It will appear here.</span><button className="primary" onClick={newReport}>Create New Report</button></div>}
    </div>
    {promptDialog&&<PromptModal title={promptDialog.title} defaultValue={promptDialog.defaultValue} onConfirm={promptDialog.onConfirm} onCancel={()=>setPromptDialog(null)}/>}
  </div>;
}
