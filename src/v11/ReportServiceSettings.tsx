import { useEffect, useState } from "react";

type Report = { id:string; itemKey?:string; itemType?:string; paginatedId?:string; name:string; published_at:string; updated_at?:string; pages:number; role:string; sourceType?:string };
type Props = { report:Report; onClose:()=>void; onShare:()=>void; onRefresh:()=>void; onDelete:()=>void };
const canEdit=(role:string)=>["Owner","Co-Owner","Admin","Member","Contributor"].includes(role);

export function ReportContentList({reports,onView,onSettings,onShare,onRefresh,onDelete}:{reports:Report[];onView:(r:Report)=>void;onSettings:(r:Report)=>void;onShare:(r:Report)=>void;onRefresh:(r:Report)=>void;onDelete:(r:Report)=>void}){
  const [menu,setMenu]=useState<string|null>(null);
  useEffect(()=>{const close=()=>setMenu(null);window.addEventListener("click",close);return()=>window.removeEventListener("click",close)},[]);
  const relative=(value:string)=>{const days=Math.floor((Date.now()-new Date(value).getTime())/86400000);return days<1?"Today":days===1?"Yesterday":`${days} days ago`};
  return <div style={{background:"#fff",border:"1px solid #e5e7eb",borderRadius:8,boxShadow:"0 1px 2px rgba(0,0,0,.04)",overflow:"visible"}}>
    <div style={{display:"grid",gridTemplateColumns:"minmax(260px,1fr) 130px 130px 150px 54px",padding:"10px 16px",borderBottom:"1px solid #e5e7eb",color:"#5f6368",fontSize:12,fontWeight:700}}><span>Name</span><span>Type</span><span>Access</span><span>Refreshed</span><span/></div>
    {reports.map(report=><div key={report.itemKey||report.id} onDoubleClick={()=>onView(report)} style={{display:"grid",gridTemplateColumns:"minmax(260px,1fr) 130px 130px 150px 54px",padding:"11px 16px",borderBottom:"1px solid #eef0f2",alignItems:"center",fontSize:13,minHeight:42}}>
      <button onClick={()=>onView(report)} style={{display:"flex",alignItems:"center",gap:11,border:0,background:"none",padding:0,textAlign:"left",cursor:"pointer",color:"#202124",fontWeight:600}}><span style={{width:28,height:28,borderRadius:4,display:"grid",placeItems:"center",background:"#f3e8ff",color:"#7e22ce",fontSize:15}}>▥</span>{report.name}</button>
      <span style={{color:"#5f6368"}}>{report.itemType||'Report'}</span><span style={{color:"#5f6368"}}>{report.role}</span><span style={{color:"#5f6368"}}>{relative(report.updated_at||report.published_at)}</span>
      <div style={{position:"relative",justifySelf:"end"}} onClick={e=>e.stopPropagation()}><button aria-label={`More options for ${report.name}`} title="More options" onClick={e=>{e.stopPropagation();const key=report.itemKey||report.id;setMenu(menu===key?null:key)}} style={{width:34,height:30,border:"1px solid transparent",borderRadius:5,background:menu===(report.itemKey||report.id)?"#eef2ff":"transparent",fontSize:22,lineHeight:1,cursor:"pointer",color:"#374151"}}>⋯</button>
      {menu===(report.itemKey||report.id)&&<div style={{position:"absolute",right:0,top:34,zIndex:40,width:220,background:"#fff",border:"1px solid #d1d5db",borderRadius:7,boxShadow:"0 8px 24px rgba(0,0,0,.18)",padding:5}}>
        <Menu label="Open report" icon="▥" onClick={()=>onView(report)}/>
        {canEdit(report.role)&&<><Menu label="Share and manage access" icon="♧" onClick={()=>onShare(report)}/><div style={{height:1,background:"#e5e7eb",margin:"5px 0"}}/><Menu label="Report settings" icon="⚙" onClick={()=>onSettings(report)}/><Menu danger label="Delete" icon="⌫" onClick={()=>onDelete(report)}/></>}
      </div>}</div>
    </div>)}
  </div>
}

function Menu({label,icon,onClick,danger=false}:{label:string;icon:string;onClick:()=>void;danger?:boolean}){return <button onClick={onClick} style={{width:"100%",display:"flex",gap:11,alignItems:"center",border:0,background:"transparent",padding:"9px 10px",borderRadius:5,cursor:"pointer",fontSize:13,textAlign:"left",color:danger?"#b91c1c":"#202124"}}><span style={{width:18,textAlign:"center"}}>{icon}</span>{label}</button>}

export default function ReportServiceSettings({report,onClose,onShare,onRefresh,onDelete}:Props){
  const [section,setSection]=useState("general");
  const editable=canEdit(report.role);
  const sections=[['general','General','ⓘ'],['access','Sharing and access','♧']];
  return <div style={{position:"fixed",inset:0,zIndex:1250,background:"rgba(15,23,42,.28)"}} onMouseDown={onClose}>
    <aside style={{position:"absolute",right:0,top:0,bottom:0,width:"min(760px,92vw)",background:"#fff",boxShadow:"-10px 0 35px rgba(15,23,42,.2)",display:"flex",flexDirection:"column"}} onMouseDown={e=>e.stopPropagation()}>
      <header style={{height:58,padding:"0 20px",display:"flex",alignItems:"center",borderBottom:"1px solid #e5e7eb"}}><div style={{flex:1}}><b style={{display:"block",fontSize:16,color:"#202124"}}>Settings for {report.name}</b><small style={{color:"#6b7280"}}>Report presentation and access</small></div><button onClick={onClose} style={{border:0,background:"transparent",fontSize:22,cursor:"pointer"}}>×</button></header>
      <div style={{display:"flex",minHeight:0,flex:1}}><nav style={{width:245,borderRight:"1px solid #e5e7eb",padding:"12px 8px",overflow:"auto"}}>{sections.map(item=><button key={item[0]} onClick={()=>setSection(item[0])} style={{width:"100%",border:0,borderLeft:section===item[0]?"3px solid #7c3aed":"3px solid transparent",background:section===item[0]?"#f5f3ff":"transparent",padding:"10px 12px",display:"flex",gap:10,textAlign:"left",cursor:"pointer",fontSize:13,color:section===item[0]?"#5b21b6":"#374151",fontWeight:section===item[0]?700:500}}><span>{item[2]}</span>{item[1]}</button>)}</nav>
        <main style={{padding:26,overflow:"auto",flex:1,color:"#202124"}}>
          {section==="general"&&<Section title="General" text="Report identity and presentation metadata. Data connections, credentials and refresh belong to the connected semantic model."><Read label="Name" value={report.name}/><Read label="Item type" value="Report"/><Read label="Report ID" value={report.id}/><Read label="Your access" value={report.role}/></Section>}
          {section==="access"&&<Section title="Sharing and access" text="Control who can view, build from, or manage this report."><Action title="Manage access" detail="Share with people and assign report permissions." button="Manage access" disabled={!editable} onClick={onShare}/></Section>}
          {editable&&section==="general"&&<div style={{marginTop:30,borderTop:"1px solid #e5e7eb",paddingTop:20}}><h3 style={{fontSize:14,color:"#b91c1c"}}>Delete this report</h3><p style={{fontSize:13,color:"#6b7280"}}>This permanently removes the published report and its refresh configuration.</p><button onClick={onDelete} style={{border:"1px solid #dc2626",background:"#fff",color:"#b91c1c",borderRadius:5,padding:"8px 13px",fontWeight:700,cursor:"pointer"}}>Delete report</button></div>}
        </main></div>
    </aside>
  </div>
}

function Section({title,text,children}:{title:string;text:string;children:any}){return <><h2 style={{margin:"0 0 6px",fontSize:20}}>{title}</h2><p style={{margin:"0 0 24px",fontSize:13,color:"#6b7280",lineHeight:1.55}}>{text}</p>{children}</>}
function Read({label,value}:{label:string;value:string}){return <label style={{display:"block",fontSize:12,fontWeight:700,color:"#4b5563",marginBottom:16}}>{label}<div style={{marginTop:5,border:"1px solid #d1d5db",borderRadius:5,padding:"9px 10px",fontWeight:400,color:"#202124",background:"#f9fafb",wordBreak:"break-all"}}>{value}</div></label>}
function Action({title,detail,button:label,onClick,disabled}:{title:string;detail:string;button:string;onClick:()=>void;disabled:boolean}){return <div style={{border:"1px solid #e5e7eb",borderRadius:7,padding:17,display:"flex",gap:16,alignItems:"center"}}><div style={{flex:1}}><b style={{display:"block",fontSize:14,marginBottom:5}}>{title}</b><span style={{fontSize:12,color:"#6b7280",lineHeight:1.5}}>{detail}</span></div><button disabled={disabled} onClick={onClick} style={{border:"1px solid #6d28d9",background:disabled?"#f3f4f6":"#6d28d9",color:disabled?"#9ca3af":"#fff",borderRadius:5,padding:"8px 12px",fontWeight:700,cursor:disabled?"not-allowed":"pointer"}}>{label}</button></div>}
