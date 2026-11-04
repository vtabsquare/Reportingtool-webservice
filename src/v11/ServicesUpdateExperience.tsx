import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpCircle, RotateCw, ShieldCheck, X } from 'lucide-react';
import { api } from '../api';
import PixelBuildScreen,{type ServicesUpdateStatus} from './PixelBuildScreen';

const activeStates=new Set(['queued','applying','deploying','building','restarting']);

export default function ServicesUpdateExperience(){
  const[status,setStatus]=useState<ServicesUpdateStatus|null>(null);
  const[busy,setBusy]=useState(false);
  const[dismissed,setDismissed]=useState(false);
  const mounted=useRef(true);
  const poll=useCallback(async()=>{try{const next=await api<ServicesUpdateStatus>('/update/status');if(mounted.current)setStatus(next)}catch{/* Keep the current update UI while a managed service restarts. */}},[]);
  useEffect(()=>{mounted.current=true;poll();const timer=window.setInterval(poll,5000);return()=>{mounted.current=false;window.clearInterval(timer)}},[poll]);
  useEffect(()=>{if(status&&activeStates.has(status.status))localStorage.setItem('vtab_building_update','1');if(status?.status==='completed')localStorage.removeItem('vtab_building_update')},[status]);
  const apply=async()=>{setBusy(true);setDismissed(false);localStorage.setItem('vtab_building_update','1');try{setStatus(await api<ServicesUpdateStatus>('/update/apply',{method:'POST',body:'{}'}))}finally{setBusy(false)}};
  const building=!!status&&(activeStates.has(status.status)||status.status==='failed'||status.status==='completed'||localStorage.getItem('vtab_building_update')==='1');
  if(building&&status)return <PixelBuildScreen status={status} onClose={()=>status.status==='completed'?location.reload():setStatus({...status,status:'idle'})}/>;
  if(!status?.update_available||dismissed)return null;
  return <aside className="vtabUpdateBanner"><span className="vtabUpdateIcon"><ArrowUpCircle size={19}/></span><div><b>Services update {status.available_version} is ready</b><small><ShieldCheck size={12}/> Approved release · exact commit {status.target_commit_sha?.slice(0,8)}</small></div><button className="vtabUpdateNow" disabled={busy} onClick={apply}>{busy?<RotateCw className="spin" size={15}/>:<ArrowUpCircle size={15}/>} Update now</button><button className="vtabUpdateDismiss" aria-label="Dismiss update notice" onClick={()=>setDismissed(true)}><X size={16}/></button></aside>;
}
