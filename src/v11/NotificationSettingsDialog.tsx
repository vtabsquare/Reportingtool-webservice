import { useEffect, useState } from 'react';
import { Bell, BellRing, CalendarClock, Globe2, Mail, Pause, Play, RefreshCw, Send, Trash2, X, Pencil } from 'lucide-react';
import { api } from '../api';

type Preferences={timezone:string;locale:string;in_app_enabled:boolean;email_enabled:boolean;collaboration_in_app:boolean;collaboration_email:boolean;refresh_failure_in_app:boolean;refresh_failure_email:boolean;refresh_success_in_app:boolean;refresh_success_email:boolean;subscriptions_in_app:boolean;subscriptions_email:boolean;alerts_in_app:boolean;alerts_email:boolean};
type Subscription={id:string;name:string;status:string;frequency:string;timezone:string;next_run?:string;last_status?:string;last_error?:string;recipients?:{email:string}[];report_id?:string;report_name?:string;subject?:string;message?:string;cron_expr?:string;include_link?:boolean;attachment_format?:string};
type AlertRule={id:string;name:string;status:string;measure_name:string;visual_id?:string;operator:string;threshold:string|number;current_value?:string|number;current_state?:string;last_evaluated_at?:string;last_error?:string;report_id?:string;report_name?:string;channels?:string[];evaluation_mode?:string;cooldown_minutes?:number;recovery_enabled?:boolean};
type Section='preferences'|'subscriptions'|'alerts';
const defaults:Preferences={timezone:'UTC',locale:'en-IN',in_app_enabled:true,email_enabled:true,collaboration_in_app:true,collaboration_email:true,refresh_failure_in_app:true,refresh_failure_email:true,refresh_success_in_app:true,refresh_success_email:true,subscriptions_in_app:true,subscriptions_email:true,alerts_in_app:true,alerts_email:true};
const zones=['UTC','Asia/Kolkata','Asia/Dubai','Asia/Singapore','Europe/London','America/New_York','America/Chicago','America/Los_Angeles'];

export default function NotificationSettingsDialog({onClose}:{onClose:()=>void}){
  const[prefs,setPrefs]=useState<Preferences>(defaults),[subscriptions,setSubscriptions]=useState<Subscription[]>([]),[alerts,setAlerts]=useState<AlertRule[]>([]),[section,setSection]=useState<Section>('preferences'),[busy,setBusy]=useState(true),[action,setAction]=useState(''),[error,setError]=useState(''),[saved,setSaved]=useState(false),[editingSub,setEditingSub]=useState<any>(null),[editingAlert,setEditingAlert]=useState<any>(null);
  const load=async()=>{setBusy(true);setError('');try{const[p,s,a]=await Promise.all([api<Preferences>('/service/notification-preferences'),api<Subscription[]>('/service/subscriptions'),api<AlertRule[]>('/service/alerts')]);setPrefs({...defaults,...p});setSubscriptions(s||[]);setAlerts(a||[])}catch(e:any){setError(e.message||String(e))}finally{setBusy(false)}};
  useEffect(()=>{void load()},[]);
  const toggle=(key:keyof Preferences)=>(event:React.ChangeEvent<HTMLInputElement>)=>setPrefs(value=>({...value,[key]:event.target.checked}));
  const save=async()=>{setBusy(true);setError('');setSaved(false);try{const value=await api<Preferences>('/service/notification-preferences',{method:'PUT',body:JSON.stringify(prefs)});setPrefs({...defaults,...value});setSaved(true)}catch(e:any){setError(e.message||String(e))}finally{setBusy(false)}};
  const run=async(kind:'subscriptions'|'alerts',id:string,operation:'status'|'test'|'delete',status?:string)=>{setAction(`${kind}:${id}:${operation}`);setError('');try{await api(`/service/${kind}/${id}${operation==='delete'?'':`/${operation}`}`,{method:operation==='delete'?'DELETE':'POST',...(operation==='status'?{body:JSON.stringify({status})}:{})});await load()}catch(e:any){setError(e.message||String(e))}finally{setAction('')}};

  const startEditSub=(item:any)=>{
    let time='08:00';
    if(item.cron_expr){
      const parts=item.cron_expr.split(' ');
      if(parts.length>=2&&!isNaN(Number(parts[0]))&&!isNaN(Number(parts[1]))){
        time=`${String(parts[1]).padStart(2,'0')}:${String(parts[0]).padStart(2,'0')}`;
      }
    }
    setEditingSub({
      ...item,
      time,
      recipientsText:(item.recipients||[]).map((r:any)=>r.email).filter(Boolean).join(', '),
      include_link:item.include_link!==false,
      attachment_format:item.attachment_format||'',
    });
  };

  const saveSubEdit=async()=>{
    if(!editingSub)return;
    setBusy(true);setError('');
    try{
      const raw=editingSub.recipientsText?editingSub.recipientsText.split(',').map((x:string)=>x.trim()).filter(Boolean):[];
      await api(`/service/subscriptions/${editingSub.id}`,{
        method:'PUT',
        body:JSON.stringify({
          ...editingSub,
          recipients:raw,
          attachment_format:editingSub.attachment_format||null,
        }),
      });
      setEditingSub(null);
      await load();
    }catch(e:any){setError(e.message||String(e))}finally{setBusy(false)}};

  const startEditAlert=(item:any)=>{
    setEditingAlert({
      ...item,
      channels:item.channels||['in_app','email'],
      cooldown_minutes:item.cooldown_minutes??60,
      recovery_enabled:item.recovery_enabled!==false,
    });
  };

  const saveAlertEdit=async()=>{
    if(!editingAlert)return;
    setBusy(true);setError('');
    try{
      await api(`/service/alerts/${editingAlert.id}`,{
        method:'PUT',
        body:JSON.stringify({
          ...editingAlert,
          threshold:Number(editingAlert.threshold),
        }),
      });
      setEditingAlert(null);
      await load();
    }catch(e:any){setError(e.message||String(e))}finally{setBusy(false)}};

  return <div className="vtabSettingsBackdrop" onMouseDown={onClose}><section className="vtabNotificationSettings vtabAutomationManager" onMouseDown={e=>e.stopPropagation()}>
    <header><div><b>Settings</b><small>Notifications, email subscriptions, and KPI alerts.</small></div><button onClick={onClose} title="Close"><X size={19}/></button></header>
    <nav className="vtabSettingsTabs"><button className={section==='preferences'?'active':''} onClick={()=>{setSection('preferences');setEditingSub(null);setEditingAlert(null)}}><Bell size={15}/>Preferences</button><button className={section==='subscriptions'?'active':''} onClick={()=>{setSection('subscriptions');setEditingSub(null);setEditingAlert(null)}}><CalendarClock size={15}/>Subscriptions <em>{subscriptions.length}</em></button><button className={section==='alerts'?'active':''} onClick={()=>{setSection('alerts');setEditingSub(null);setEditingAlert(null)}}><BellRing size={15}/>Alerts <em>{alerts.length}</em></button><button className="refresh" onClick={()=>void load()} title="Refresh"><RefreshCw size={15}/></button></nav>
    <main>{error&&<div className="vtabSettingsError">{error}</div>}{saved&&section==='preferences'&&<div className="vtabSettingsSaved">Notification preferences saved.</div>}
      {section==='preferences'&&<><section><h3><Globe2 size={17}/>General</h3><div className="vtabSettingsRow"><span><b>Time zone</b><small>Used for notification timestamps and schedules.</small></span><select value={prefs.timezone} onChange={e=>setPrefs({...prefs,timezone:e.target.value})}>{zones.map(zone=><option key={zone}>{zone}</option>)}</select></div><div className="vtabSettingsRow"><span><b>Locale</b><small>Controls date and number presentation.</small></span><select value={prefs.locale} onChange={e=>setPrefs({...prefs,locale:e.target.value})}><option value="en-IN">English (India)</option><option value="en-US">English (United States)</option><option value="en-GB">English (United Kingdom)</option></select></div></section><section><h3><Bell size={17}/>Notification channels</h3><Toggle label="In-app notifications" hint="Show items in the notification center." checked={prefs.in_app_enabled} change={toggle('in_app_enabled')}/><Toggle label="Email notifications" hint="Allow enabled categories to be delivered by email." checked={prefs.email_enabled} change={toggle('email_enabled')}/></section><section><h3><Mail size={17}/>Categories</h3><Matrix label="Sharing and access" inApp={prefs.collaboration_in_app} email={prefs.collaboration_email} setInApp={toggle('collaboration_in_app')} setEmail={toggle('collaboration_email')}/><Matrix label="Refresh failures and disabled schedules" inApp={prefs.refresh_failure_in_app} email={prefs.refresh_failure_email} setInApp={toggle('refresh_failure_in_app')} setEmail={toggle('refresh_failure_email')}/><Matrix label="Successful refreshes (optional)" inApp={prefs.refresh_success_in_app} email={prefs.refresh_success_email} setInApp={toggle('refresh_success_in_app')} setEmail={toggle('refresh_success_email')}/><Matrix label="Subscriptions" inApp={prefs.subscriptions_in_app} email={prefs.subscriptions_email} setInApp={toggle('subscriptions_in_app')} setEmail={toggle('subscriptions_email')}/><Matrix label="KPI and measure alerts" inApp={prefs.alerts_in_app} email={prefs.alerts_email} setInApp={toggle('alerts_in_app')} setEmail={toggle('alerts_email')}/></section></>}
      {section==='subscriptions'&&(
        editingSub ? (
          <div style={{padding:'10px 0'}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:14}}>
              <div><b style={{fontSize:15}}>Edit Subscription</b><small style={{display:'block',color:'var(--svc-muted, #64748b)'}}>Dashboard: {editingSub.report_name || 'Report'}</small></div>
              <button onClick={()=>setEditingSub(null)} style={{background:'transparent',border:'none',cursor:'pointer',fontSize:12,color:'var(--svc-muted, #64748b)'}}>✕ Cancel</button>
            </div>
            <div style={{display:'grid',gap:12}}>
              <label style={fLabel}><span>Subscription name</span><input style={fInput} value={editingSub.name} onChange={e=>setEditingSub({...editingSub,name:e.target.value})}/></label>
              <label style={fLabel}><span>Recipients</span><input style={fInput} value={editingSub.recipientsText||''} onChange={e=>setEditingSub({...editingSub,recipientsText:e.target.value})} placeholder="user@company.com, team@company.com"/></label>
              <label style={fLabel}><span>Email subject</span><input style={fInput} value={editingSub.subject||''} onChange={e=>setEditingSub({...editingSub,subject:e.target.value})}/></label>
              <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(140px,1fr))',gap:10}}>
                <label style={fLabel}><span>Frequency</span><select style={fInput} value={editingSub.frequency} onChange={e=>setEditingSub({...editingSub,frequency:e.target.value})}><option value="hourly">Hourly</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="after_refresh">After successful refresh</option></select></label>
                <label style={fLabel}><span>Delivery time</span><input type="time" disabled={editingSub.frequency==='after_refresh'} style={fInput} value={editingSub.time||'08:00'} onChange={e=>setEditingSub({...editingSub,time:e.target.value})}/></label>
                <label style={fLabel}><span>Time zone</span><select style={fInput} value={editingSub.timezone} onChange={e=>setEditingSub({...editingSub,timezone:e.target.value})}>{zones.map(z=><option key={z}>{z}</option>)}</select></label>
                <label style={fLabel}><span>Attachment</span><select style={fInput} value={editingSub.attachment_format||''} onChange={e=>setEditingSub({...editingSub,attachment_format:e.target.value})}><option value="">Link only</option><option value="pdf">PDF</option></select></label>
              </div>
              <div style={{display:'flex',gap:8,marginTop:10}}>
                <button onClick={()=>setEditingSub(null)} style={{padding:'7px 14px',borderRadius:4,border:'1px solid var(--svc-border, #cbd5e1)',background:'transparent',cursor:'pointer'}}>Cancel</button>
                <button className="primary" disabled={busy} onClick={()=>void saveSubEdit()} style={{padding:'7px 14px',borderRadius:4,background:'#0f6cbd',color:'#fff',border:'none',cursor:'pointer',fontWeight:600}}>{busy?'Saving…':'Save Changes'}</button>
              </div>
            </div>
          </div>
        ) : (
          <AutomationList empty="No report subscriptions yet. Create one from a published report.">{subscriptions.map(item=><article className="vtabAutomationItem" key={item.id}><div className="icon"><CalendarClock size={18}/></div><div className="details"><div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}><b>{item.name}</b><span style={{fontSize:11,padding:'2px 8px',borderRadius:4,background:'var(--svc-surface-3, #f1f5f9)',color:'var(--svc-text, #334155)',border:'1px solid var(--svc-border, #e2e8f0)',fontWeight:600}}>Dashboard: {item.report_name || 'Report'}</span></div><span>{item.frequency.replace('_',' ')} · {item.timezone} · {(item.recipients||[]).map(r=>r.email).join(', ')}</span><small>{item.last_status?`Last delivery: ${item.last_status}`:'Not delivered yet'}{item.next_run?` · Next: ${formatTime(item.next_run)}`:''}{item.last_error?` · ${item.last_error}`:''}</small></div><Status value={item.status}/><Actions busy={action.startsWith(`subscriptions:${item.id}:`)} active={item.status==='active'} onEdit={()=>startEditSub(item)} onToggle={()=>void run('subscriptions',item.id,'status',item.status==='active'?'paused':'active')} onTest={()=>void run('subscriptions',item.id,'test')} onDelete={()=>void run('subscriptions',item.id,'delete')}/></article>)}</AutomationList>
        )
      )}
      {section==='alerts'&&(
        editingAlert ? (
          <div style={{padding:'10px 0'}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:14}}>
              <div><b style={{fontSize:15}}>Edit Data Alert</b><small style={{display:'block',color:'var(--svc-muted, #64748b)'}}>Dashboard: {editingAlert.report_name || 'Report'} · Metric: {editingAlert.measure_name}</small></div>
              <button onClick={()=>setEditingAlert(null)} style={{background:'transparent',border:'none',cursor:'pointer',fontSize:12,color:'var(--svc-muted, #64748b)'}}>✕ Cancel</button>
            </div>
            <div style={{display:'grid',gap:12}}>
              <label style={fLabel}><span>Alert name</span><input style={fInput} value={editingAlert.name} onChange={e=>setEditingAlert({...editingAlert,name:e.target.value})}/></label>
              <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(140px,1fr))',gap:10}}>
                <label style={fLabel}><span>Condition</span><select style={fInput} value={editingAlert.operator} onChange={e=>setEditingAlert({...editingAlert,operator:e.target.value})}><option value="gt">Greater than</option><option value="gte">Greater than or equal</option><option value="lt">Less than</option><option value="lte">Less than or equal</option><option value="eq">Equal to</option><option value="neq">Not equal to</option></select></label>
                <label style={fLabel}><span>Threshold</span><input type="number" style={fInput} value={editingAlert.threshold} onChange={e=>setEditingAlert({...editingAlert,threshold:e.target.value})}/></label>
                <label style={fLabel}><span>Evaluate</span><select style={fInput} value={editingAlert.evaluation_mode||'after_refresh'} onChange={e=>setEditingAlert({...editingAlert,evaluation_mode:e.target.value})}><option value="after_refresh">After successful refresh</option><option value="interval">On an interval</option></select></label>
                <label style={fLabel}><span>Cooldown minutes</span><input type="number" min="0" style={fInput} value={editingAlert.cooldown_minutes??60} onChange={e=>setEditingAlert({...editingAlert,cooldown_minutes:Number(e.target.value)})}/></label>
              </div>
              <div style={{display:'flex',gap:16,flexWrap:'wrap',marginTop:4}}>
                <label style={{display:'flex',alignItems:'center',gap:6,fontSize:13,cursor:'pointer'}}>
                  <input type="checkbox" checked={(editingAlert.channels||[]).includes('in_app')} onChange={e=>setEditingAlert({...editingAlert,channels:e.target.checked?[...new Set([...(editingAlert.channels||[]),'in_app'])]:(editingAlert.channels||[]).filter((x:string)=>x!=='in_app')})}/>
                  In-app notification
                </label>
                <label style={{display:'flex',alignItems:'center',gap:6,fontSize:13,cursor:'pointer'}}>
                  <input type="checkbox" checked={(editingAlert.channels||[]).includes('email')} onChange={e=>setEditingAlert({...editingAlert,channels:e.target.checked?[...new Set([...(editingAlert.channels||[]),'email'])]:(editingAlert.channels||[]).filter((x:string)=>x!=='email')})}/>
                  Email notification
                </label>
                <label style={{display:'flex',alignItems:'center',gap:6,fontSize:13,cursor:'pointer'}}>
                  <input type="checkbox" checked={editingAlert.recovery_enabled!==false} onChange={e=>setEditingAlert({...editingAlert,recovery_enabled:e.target.checked})}/>
                  Notify when KPI recovers
                </label>
              </div>
              <div style={{display:'flex',gap:8,marginTop:10}}>
                <button onClick={()=>setEditingAlert(null)} style={{padding:'7px 14px',borderRadius:4,border:'1px solid var(--svc-border, #cbd5e1)',background:'transparent',cursor:'pointer'}}>Cancel</button>
                <button className="primary" disabled={busy} onClick={()=>void saveAlertEdit()} style={{padding:'7px 14px',borderRadius:4,background:'#0f6cbd',color:'#fff',border:'none',cursor:'pointer',fontWeight:600}}>{busy?'Saving…':'Save Changes'}</button>
              </div>
            </div>
          </div>
        ) : (
          <AutomationList empty="No KPI alerts yet. Create one from a published report.">{alerts.map(item=><article className="vtabAutomationItem" key={item.id}><div className="icon"><BellRing size={18}/></div><div className="details"><div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}><b>{item.name}</b><span style={{fontSize:11,padding:'2px 8px',borderRadius:4,background:'var(--svc-surface-3, #f1f5f9)',color:'var(--svc-text, #334155)',border:'1px solid var(--svc-border, #e2e8f0)',fontWeight:600}}>Dashboard: {item.report_name || 'Report'}</span></div><span>{item.measure_name} {operatorLabel(item.operator)} {item.threshold}</span><small>{item.current_value!==undefined&&item.current_value!==null?`Current value: ${item.current_value} · `:''}{item.current_state||'not evaluated'}{item.last_evaluated_at?` · ${formatTime(item.last_evaluated_at)}`:''}{item.last_error?` · ${item.last_error}`:''}</small></div><Status value={item.status}/><Actions busy={action.startsWith(`alerts:${item.id}:`)} active={item.status==='active'} onEdit={()=>startEditAlert(item)} onToggle={()=>void run('alerts',item.id,'status',item.status==='active'?'paused':'active')} onTest={()=>void run('alerts',item.id,'test')} onDelete={()=>void run('alerts',item.id,'delete')}/></article>)}</AutomationList>
        )
      )}
      {busy&&<div className="vtabAutomationLoading">Loading…</div>}
    </main><footer>{section==='preferences'?<><button onClick={onClose}>Cancel</button><button className="primary" disabled={busy} onClick={()=>void save()}>{busy?'Saving…':'Save settings'}</button></>:<button className="primary" onClick={onClose}>Done</button>}</footer>
  </section></div>;
}
const fLabel:React.CSSProperties={display:'grid',gap:4,fontSize:12,fontWeight:600,color:'var(--svc-text, #334155)'};
const fInput:React.CSSProperties={padding:'7px 10px',border:'1px solid var(--svc-border, #cbd5e1)',borderRadius:5,background:'var(--svc-surface-2, #fff)',color:'var(--svc-text, inherit)',fontSize:13};
function Toggle({label,hint,checked,change}:{label:string;hint:string;checked:boolean;change:(e:React.ChangeEvent<HTMLInputElement>)=>void}){return <label className="vtabSettingsRow vtabSettingsToggle"><span><b>{label}</b><small>{hint}</small></span><input type="checkbox" checked={checked} onChange={change}/></label>}
function Matrix({label,inApp,email,setInApp,setEmail}:{label:string;inApp:boolean;email:boolean;setInApp:(e:React.ChangeEvent<HTMLInputElement>)=>void;setEmail:(e:React.ChangeEvent<HTMLInputElement>)=>void}){return <div className="vtabSettingsRow vtabSettingsMatrix"><b>{label}</b><label><input type="checkbox" checked={inApp} onChange={setInApp}/>In app</label><label><input type="checkbox" checked={email} onChange={setEmail}/>Email</label></div>}
function AutomationList({empty,children}:{empty:string;children:React.ReactNode}){const count=Array.isArray(children)?children.length:1;return <section className="vtabAutomationList">{count===0?<div className="vtabAutomationEmpty">{empty}</div>:children}</section>}
function Status({value}:{value:string}){return <span className={`vtabAutomationStatus ${value}`}>{value}</span>}
function Actions({busy,active,onToggle,onTest,onDelete,onEdit}:{busy:boolean;active:boolean;onToggle:()=>void;onTest:()=>void;onDelete:()=>void;onEdit?:()=>void}){return <div className="vtabAutomationActions">{onEdit&&<button disabled={busy} onClick={onEdit} title="Edit"><Pencil size={14}/></button>}<button disabled={busy} onClick={onToggle} title={active?'Pause':'Resume'}>{active?<Pause size={15}/>:<Play size={15}/>}</button><button disabled={busy} onClick={onTest} title="Run a test now"><Send size={15}/></button><button disabled={busy} onClick={onDelete} title="Delete"><Trash2 size={15}/></button></div>}
function formatTime(value:string){try{return new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(new Date(value))}catch{return value}}
function operatorLabel(value:string){return ({gt:'>',gte:'≥',lt:'<',lte:'≤',eq:'=',neq:'≠'} as Record<string,string>)[value]||value}
