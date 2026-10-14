import { useCallback, useEffect, useRef, useState } from 'react';
import { Bell, CheckCheck, CircleAlert, CircleCheck, Info, Trash2, X } from 'lucide-react';
import { api } from '../api';
import { supabase } from '../supabase';

type NotificationItem = {
  id:string; title:string; message:string; event_type:string; category:string; severity:string;
  action_url?:string; read_at?:string|null; created_at:string; workspace_id?:string; report_id?:string;
};
type NotificationPage={items:NotificationItem[];unreadCount:number;nextCursor?:string|null};

const since=(value:string)=>{
  const elapsed=Math.max(0,Date.now()-new Date(value).getTime()),minutes=Math.floor(elapsed/60000);
  if(minutes<1)return 'Now';if(minutes<60)return `${minutes}m`;
  const hours=Math.floor(minutes/60);if(hours<24)return `${hours}h`;
  const days=Math.floor(hours/24);return days<30?`${days}d`:new Date(value).toLocaleDateString();
};

export default function NotificationCenter({userId}:{userId?:string}){
  const[open,setOpen]=useState(false),[items,setItems]=useState<NotificationItem[]>([]),[unread,setUnread]=useState(0);
  const[nextCursor,setNextCursor]=useState<string|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState('');
  const root=useRef<HTMLDivElement>(null);
  const load=useCallback(async(cursor?:string,append=false)=>{
    setLoading(true);setError('');
    try{
      const query=new URLSearchParams({limit:'25'});if(cursor)query.set('cursor',cursor);
      const result=await api<NotificationPage>(`/service/notifications?${query}`);
      setItems(previous=>append?[...previous,...result.items]:result.items);setUnread(result.unreadCount);setNextCursor(result.nextCursor||null);
    }catch(e:any){setError(e.message||String(e))}finally{setLoading(false)}
  },[]);
  useEffect(()=>{void load();const timer=window.setInterval(()=>void load(),45000);return()=>window.clearInterval(timer)},[load]);
  useEffect(()=>{
    if(!supabase||!userId)return;
    const channel=supabase.channel(`vtab-notifications-${userId}`).on('postgres_changes',{event:'*',schema:'public',table:'notifications',filter:`user_id=eq.${userId}`},()=>void load()).subscribe();
    return()=>{void supabase.removeChannel(channel)};
  },[userId,load]);
  useEffect(()=>{const close=(event:MouseEvent)=>{if(open&&root.current&&!root.current.contains(event.target as Node))setOpen(false)};document.addEventListener('mousedown',close);return()=>document.removeEventListener('mousedown',close)},[open]);
  const patch=async(id:string,payload:any)=>{await api(`/service/notifications/${id}`,{method:'PATCH',body:JSON.stringify(payload)});await load()};
  const select=async(item:NotificationItem)=>{if(!item.read_at)await patch(item.id,{read:true});if(item.action_url?.startsWith('/'))window.location.assign(item.action_url)};
  const markAll=async()=>{await api('/service/notifications/read-all',{method:'POST'});await load()};
  return <div className="vtabNotificationRoot" ref={root}>
    <button className="pbi-header-icon-btn vtabHeaderBadgeButton" title="Notifications" aria-label={`${unread} unread notifications`} onClick={()=>{setOpen(value=>!value);if(!open)void load()}}>
      <Bell size={17}/>{unread>0&&<span>{unread>99?'99+':unread}</span>}
    </button>
    {open&&<aside className="vtabNotificationPanel" aria-label="Notifications">
      <header><div><b>Notifications</b><small>{unread?`${unread} unread`:'You’re all caught up'}</small></div><div>{unread>0&&<button title="Mark all as read" onClick={()=>void markAll()}><CheckCheck size={16}/></button>}<button title="Close" onClick={()=>setOpen(false)}><X size={17}/></button></div></header>
      <main>
        {error&&<div className="vtabNotificationError"><CircleAlert size={16}/><span>{error}</span></div>}
        {!error&&!items.length&&!loading&&<div className="vtabNotificationEmpty"><Bell size={26}/><b>No notifications</b><span>Refresh, sharing, subscriptions and alerts will appear here.</span></div>}
        {items.map(item=><article key={item.id} className={item.read_at?'':'unread'}>
          <button className="vtabNotificationContent" onClick={()=>void select(item)}>
            <span className={`vtabNotificationType ${item.severity||'info'}`}>{item.severity==='success'?<CircleCheck size={16}/>:item.severity==='error'?<CircleAlert size={16}/>:<Info size={16}/>}</span>
            <span><b>{item.title}</b><small>{item.message}</small><em>{since(item.created_at)} · {(item.category||'system').replace('_',' ')}</em></span>
          </button>
          <button className="vtabNotificationDismiss" title="Dismiss" onClick={()=>void patch(item.id,{dismissed:true})}><Trash2 size={14}/></button>
        </article>)}
        {nextCursor&&<button className="vtabNotificationMore" disabled={loading} onClick={()=>void load(nextCursor,true)}>{loading?'Loading…':'Load earlier notifications'}</button>}
        {loading&&!items.length&&<div className="vtabNotificationLoading">Loading notifications…</div>}
      </main>
    </aside>}
  </div>;
}

