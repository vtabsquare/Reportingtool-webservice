import { useEffect, useMemo, useState } from 'react';
import { BellRing, CalendarClock, Mail, X } from 'lucide-react';
import { api } from '../api';

type Mode = 'subscription' | 'alert';
export default function ReportAutomationDialog({ mode, reportId, reportName, project, pageId, filters, workspaceId, onClose }: { mode: Mode; reportId: string; reportName: string; project: any; pageId?: string; filters?: any[]; workspaceId?: string; onClose: () => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false);
  const [workspaceMembers, setWorkspaceMembers] = useState<Array<{ email: string; user_id?: string; role?: string }>>([]);
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [sub, setSub] = useState<any>({ name: `${reportName} subscription`, recipients: '', subject: `VTAB Report: ${reportName}`, message: 'Your scheduled VTAB report is ready.', frequency: 'daily', time: '08:00', timezone: 'Asia/Kolkata', include_link: true, attachment_format: '', page_id: pageId || '', filter_context: filters || [] });

  useEffect(() => {
    if (mode !== 'subscription' || !reportId) return;
    let active = true;
    setLoadingMembers(true);
    api<{ workspace_id: string; members: Array<{ email: string; user_id?: string; role?: string }> }>(`/service/reports/${reportId}/workspace-members`)
      .then(res => {
        if (!active || !res?.members) return;
        setWorkspaceMembers(res.members);
        const emails = res.members.map(m => m.email).filter(Boolean).join(', ');
        if (emails) {
          setSub((prev: any) => ({
            ...prev,
            recipients: prev.recipients ? prev.recipients : emails,
          }));
        }
      })
      .catch(() => {})
      .finally(() => { if (active) setLoadingMembers(false); });
    return () => { active = false; };
  }, [reportId, mode]);

  const eligible = useMemo(() => {
    const allPages = project?.report?.pages || [];
    const currentPage = pageId ? allPages.find((p: any) => String(p.id) === String(pageId)) : null;
    const targetPages = (currentPage && (currentPage.visuals || []).some((v: any) => ['card', 'kpi', 'gauge'].includes(String(v.type || '').toLowerCase())))
      ? [currentPage]
      : allPages;

    const modelMeasures = new Set(Object.keys(project?.model?.measures || {}));

    const found = targetPages.flatMap((page: any) => (page.visuals || [])
      .filter((visual: any) => ['card', 'kpi', 'gauge'].includes(String(visual.type || '').toLowerCase()))
      .flatMap((visual: any) => {
        const b = visual.bindings || {};
        const fmt = visual.format || {};
        const rawCandidates = [
          ...(Array.isArray(b.values) ? b.values : []),
          ...(Array.isArray(b.target) ? b.target : []),
          ...(Array.isArray(b.measures) ? b.measures : []),
          ...(Array.isArray(visual.measures) ? visual.measures : []),
          ...(Array.isArray(visual.values) ? visual.values : []),
          ...(Array.isArray(visual.fields) ? visual.fields : []),
          ...(typeof visual.measure === 'string' ? [visual.measure] : []),
          ...(typeof visual.value === 'string' ? [visual.value] : []),
          ...(typeof visual.field === 'string' ? [visual.field] : []),
          ...(fmt.fieldFormats && typeof fmt.fieldFormats === 'object' ? Object.keys(fmt.fieldFormats) : []),
        ];
        let measures = Array.from(new Set(rawCandidates.filter((v: any) => typeof v === 'string' && v.trim())));
        if (measures.length === 0 && typeof visual.title === 'string' && modelMeasures.has(visual.title)) {
          measures.push(visual.title);
        }
        return measures.map((measure: string) => ({
          visualId: visual.id || '',
          label: `${visual.title || visual.type}: ${measure}`,
          measure,
        }));
      })
    );

    if (!found.length && modelMeasures.size > 0) {
      return Array.from(modelMeasures).map((measure) => ({
        visualId: '',
        label: `Measure: ${measure}`,
        measure,
      }));
    }

    return found;
  }, [project, pageId]);

  const [alert, setAlert] = useState<any>({ name: 'KPI alert', selection: '', operator: 'gte', threshold: 0, channels: ['in_app', 'email'], evaluation_mode: 'after_refresh', evaluation_minutes: 60, cooldown_minutes: 60, repeat_enabled: false, recovery_enabled: true, filter_context: filters || [] });

  useEffect(() => {
    if (eligible.length > 0 && (!alert.selection || !eligible.some((e: any) => `${e.visualId}|${e.measure}` === alert.selection))) {
      setAlert((prev: any) => ({ ...prev, selection: `${eligible[0].visualId}|${eligible[0].measure}` }));
    }
  }, [eligible]);

  const save = async () => {
    setBusy(true); setError('');
    try {
      if (mode === 'subscription') {
        const raw = sub.recipients ? sub.recipients.split(',').map((x: string) => x.trim()).filter(Boolean) : [];
        const recipientsList = raw.length > 0 ? raw : workspaceMembers.map(m => m.email).filter(Boolean);
        await api('/service/subscriptions', { method: 'POST', body: JSON.stringify({ ...sub, report_id: reportId, recipients: recipientsList, attachment_format: sub.attachment_format || null }) });
      } else {
        const selected = eligible.find((item: any) => `${item.visualId}|${item.measure}` === alert.selection) || eligible[0];
        if (!selected) throw new Error('Choose a supported KPI, Card, or Gauge measure.');
        await api('/service/alerts', { method: 'POST', body: JSON.stringify({ ...alert, report_id: reportId, visual_id: selected.visualId || null, measure_name: selected.measure, threshold: Number(alert.threshold) }) });
      }
      setSaved(true);
    } catch (e: any) { setError(e.message || String(e)); } finally { setBusy(false); }
  };
 return <div className="vtabSettingsBackdrop" onMouseDown={onClose}><section className="vtabAutomationDialog" onMouseDown={e=>e.stopPropagation()}><header><div>{mode==='subscription'?<CalendarClock/>:<BellRing/>}<span><b>{mode==='subscription'?'Subscribe to report':'Create data alert'}</b><small>{reportName}</small></span></div><button onClick={onClose}><X/></button></header><main>{error&&<div className="vtabSettingsError">{error}</div>}{saved?<div className="vtabAutomationSuccess"><b>{mode==='subscription'?'Subscription created':'Alert created'}</b><span>You can manage it later from Settings.</span></div>:mode==='subscription'?<>
  <Field label="Subscription name"><input value={sub.name} onChange={e=>setSub({...sub,name:e.target.value})}/></Field><Field label="Recipients"><input value={sub.recipients} onChange={e=>setSub({...sub,recipients:e.target.value})} placeholder={loadingMembers ? "Loading workspace members…" : "name@company.com, team@company.com"}/><span style={{ fontSize: 11, color: '#64748b', marginTop: 4, display: 'block' }}>{loadingMembers ? 'Loading workspace members…' : workspaceMembers.length > 0 ? `Defaulted to all ${workspaceMembers.length} member${workspaceMembers.length > 1 ? 's' : ''} in this workspace. You can add or edit recipients.` : 'All members of this workspace will be included by default.'}</span></Field><Field label="Email subject"><input value={sub.subject} onChange={e=>setSub({...sub,subject:e.target.value})}/></Field><Field label="Message"><textarea value={sub.message} onChange={e=>setSub({...sub,message:e.target.value})}/></Field><div className="vtabAutomationGrid"><Field label="Frequency"><select value={sub.frequency} onChange={e=>setSub({...sub,frequency:e.target.value})}><option value="hourly">Hourly</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="after_refresh">After successful refresh</option></select></Field><Field label="Delivery time"><input type="time" disabled={sub.frequency==='after_refresh'} value={sub.time} onChange={e=>setSub({...sub,time:e.target.value})}/></Field><Field label="Time zone"><select value={sub.timezone} onChange={e=>setSub({...sub,timezone:e.target.value})}><option>Asia/Kolkata</option><option>UTC</option><option>Asia/Dubai</option><option>Europe/London</option><option>America/New_York</option></select></Field><Field label="Attachment"><select value={sub.attachment_format} onChange={e=>setSub({...sub,attachment_format:e.target.value})}><option value="">Link only</option><option value="pdf">PDF</option></select></Field></div><label className="vtabAutomationCheck"><input type="checkbox" checked={sub.include_link} onChange={e=>setSub({...sub,include_link:e.target.checked})}/>Include a secure link to the report</label>
 </>:<>{!eligible.length?<div className="vtabAutomationEmpty">This page has no supported numeric Card, KPI, or Gauge measure.</div>:<><Field label="Metric"><select value={alert.selection} onChange={e=>setAlert({...alert,selection:e.target.value})}><option value="">Select a metric</option>{eligible.map((item:any)=><option key={item.visualId+'|'+item.measure} value={item.visualId+'|'+item.measure}>{item.label}</option>)}</select></Field><div className="vtabAutomationGrid"><Field label="Condition"><select value={alert.operator} onChange={e=>setAlert({...alert,operator:e.target.value})}><option value="gt">Greater than</option><option value="gte">Greater than or equal</option><option value="lt">Less than</option><option value="lte">Less than or equal</option><option value="eq">Equal to</option><option value="neq">Not equal to</option></select></Field><Field label="Threshold"><input type="number" value={alert.threshold} onChange={e=>setAlert({...alert,threshold:e.target.value})}/></Field><Field label="Evaluate"><select value={alert.evaluation_mode} onChange={e=>setAlert({...alert,evaluation_mode:e.target.value})}><option value="after_refresh">After successful refresh</option><option value="interval">On an interval</option></select></Field><Field label="Cooldown minutes"><input type="number" min="0" value={alert.cooldown_minutes} onChange={e=>setAlert({...alert,cooldown_minutes:Number(e.target.value)})}/></Field></div><label className="vtabAutomationCheck"><input type="checkbox" checked={alert.channels.includes('in_app')} onChange={e=>setAlert({...alert,channels:e.target.checked?[...new Set([...alert.channels,'in_app'])]:alert.channels.filter((x:string)=>x!=='in_app')})}/>In-app notification</label><label className="vtabAutomationCheck"><input type="checkbox" checked={alert.channels.includes('email')} onChange={e=>setAlert({...alert,channels:e.target.checked?[...new Set([...alert.channels,'email'])]:alert.channels.filter((x:string)=>x!=='email')})}/>Email notification</label><label className="vtabAutomationCheck"><input type="checkbox" checked={alert.recovery_enabled} onChange={e=>setAlert({...alert,recovery_enabled:e.target.checked})}/>Notify me when the KPI recovers</label></>}</>}</main><footer><button onClick={onClose}>{saved?'Close':'Cancel'}</button>{!saved&&<button className="primary" disabled={busy||(mode==='alert'&&!eligible.length)} onClick={()=>void save()}><Mail size={15}/>{busy?'Saving…':mode==='subscription'?'Create subscription':'Create alert'}</button>}</footer></section></div>
}
function Field({label,children}:{label:string;children:any}){return <label className="vtabAutomationField"><span>{label}</span>{children}</label>}

