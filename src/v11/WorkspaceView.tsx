import{useEffect,useState}from'react';
import{ExternalLink,RefreshCcw,Trash2,LayoutDashboard,CalendarClock,FileDown,Presentation,Mail}from'lucide-react';
import{api,apiDownload}from'../api';

function sharePrompt(id:string,name:string){
 const to=window.prompt('Share report by email\n\nRecipient email(s), comma separated:','');if(!to)return;
 const attach=(window.prompt('Attachment: none, pdf or pptx','none')||'none').toLowerCase();
 api(`/published/${id}/share-email`,{method:'POST',body:JSON.stringify({to,attach:attach==='none'?'':attach,subject:`VTAB Report: ${name}`,message:'A VTAB Workspace report has been shared with you.',reportUrl:`${location.origin}/?viewer=${id}`})}).then(()=>alert('Report shared by email.')).catch((e:any)=>alert(e.message));
}
export default function WorkspaceView(){
 const[items,setItems]=useState<any[]>([]),[busy,setBusy]=useState(false),[authRequired,setAuthRequired]=useState(false),[signedIn,setSignedIn]=useState(true),[login,setLogin]=useState({email:'',password:''});
 const load=()=>{setBusy(true);api<any[]>('/published').then(setItems).finally(()=>setBusy(false))};
 useEffect(()=>{api<any>('/auth/status').then(s=>{setAuthRequired(!!s.required);if(s.required){api('/auth/me').then(()=>{setSignedIn(true);load()}).catch(()=>setSignedIn(false))}else load()})},[]);
 const remove=async(id:string)=>{if(!confirm('Unpublish this report?'))return;await api(`/published/${id}`,{method:'DELETE'});load()};
 const exportFile=(id:string,fmt:'pdf'|'pptx',name='VTAB_Report')=>apiDownload(`/published/${id}/export/${fmt}`,`${name}.${fmt==='pdf'?'pdf':'pptx'}`).catch((e:any)=>alert(e.message));
 const doLogin=async()=>{try{const r=await api<any>('/auth/login',{method:'POST',body:JSON.stringify(login)});localStorage.setItem('vtab_workspace_token',r.token);setSignedIn(true);load()}catch(e:any){alert(e.message)}};
 if(authRequired&&!signedIn)return <div className="workspaceLogin"><div className="workspaceLoginCard"><div className="brandMark">V</div><h2>Sign in to VTAB Workspace</h2><p>Use an account granted access by your VTAB Web administrator.</p><input placeholder="Email" value={login.email} onChange={e=>setLogin({...login,email:e.target.value})}/><input type="password" placeholder="Password" value={login.password} onChange={e=>setLogin({...login,password:e.target.value})}/><button className="primary" onClick={doLogin}>Sign In</button></div></div>;
 return <div className="page workspaceLibrary"><div className="workspaceHero"><div><span className="eyebrow">VTAB WORKSPACE</span><h1>Published Analytics</h1><p>Open, export and share governed reports from the browser workspace.</p></div><button onClick={load}><RefreshCcw size={16}/>{busy?'Refreshing…':'Refresh'}</button></div>
  {!items.length?<div className="workspaceEmpty"><LayoutDashboard size={34}/><b>No published reports yet</b><span>Publish a report from the Publish page. It will appear here immediately.</span></div>:<div className="publishedGrid">{items.map(x=><div className="publishedCard" key={x.id}><div className="publishedCardTop"><span className="publishedIcon"><LayoutDashboard size={22}/></span><span className="publishedStatus">LIVE</span></div><h3>{x.name}</h3><p>{x.pages} pages · {x.visuals} visuals</p><small><CalendarClock size={13}/>{new Date(x.updated_at||x.published_at).toLocaleString()}</small><div className="publishedActions workspaceActionGrid"><button className="primary" onClick={()=>window.open(`/?viewer=${x.id}`,'_blank')}><ExternalLink size={15}/>Open Viewer</button><button onClick={()=>exportFile(x.id,'pdf',x.name)}><FileDown size={15}/>PDF</button><button onClick={()=>exportFile(x.id,'pptx',x.name)}><Presentation size={15}/>PPT</button><button onClick={()=>sharePrompt(x.id,x.name)}><Mail size={15}/>Email</button><button onClick={()=>remove(x.id)}><Trash2 size={15}/>Unpublish</button></div></div>)}</div>}
 </div>
}
