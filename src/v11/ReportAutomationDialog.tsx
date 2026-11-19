import { useEffect, useMemo, useState } from 'react';
import { BellRing, CalendarClock, Mail, Pause, Play, Plus, RefreshCw, Send, Trash2, X, Pencil } from 'lucide-react';
import { api } from '../api';

type Mode = 'subscription' | 'alert';
type ViewTab = 'manage' | 'create';

type Subscription = {
  id: string;
  name: string;
  status: string;
  frequency: string;
  timezone: string;
  next_run?: string;
  last_status?: string;
  last_error?: string;
  recipients?: { email: string }[];
  report_id?: string;
  report_name?: string;
  subject?: string;
  message?: string;
  cron_expr?: string;
  include_link?: boolean;
  attachment_format?: string;
  page_id?: string;
  filter_context?: any[];
};

type AlertRule = {
  id: string;
  name: string;
  status: string;
  measure_name: string;
  visual_id?: string;
  operator: string;
  threshold: string | number;
  current_value?: string | number;
  current_state?: string;
  last_evaluated_at?: string;
  last_error?: string;
  report_id?: string;
  report_name?: string;
  channels?: string[];
  evaluation_mode?: string;
  evaluation_minutes?: number;
  cooldown_minutes?: number;
  repeat_enabled?: boolean;
  recovery_enabled?: boolean;
  filter_context?: any[];
};

export default function ReportAutomationDialog({
  mode,
  reportId,
  reportName,
  project,
  pageId,
  filters,
  workspaceId,
  onClose,
}: {
  mode: Mode;
  reportId: string;
  reportName: string;
  project: any;
  pageId?: string;
  filters?: any[];
  workspaceId?: string;
  onClose: () => void;
}) {
  const [activeKind, setActiveKind] = useState<Mode>(mode);
  const [viewTab, setViewTab] = useState<ViewTab>('manage');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState('');
  const [error, setError] = useState('');
  const [savedMessage, setSavedMessage] = useState('');

  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [alerts, setAlerts] = useState<AlertRule[]>([]);
  const [loadingItems, setLoadingItems] = useState(true);

  const [workspaceMembers, setWorkspaceMembers] = useState<Array<{ email: string; user_id?: string; role?: string }>>([]);
  const [loadingMembers, setLoadingMembers] = useState(false);

  // Subscription form state
  const [sub, setSub] = useState<any>({
    name: `${reportName} subscription`,
    recipients: '',
    subject: `VTAB Report: ${reportName}`,
    message: 'Your scheduled VTAB report is ready.',
    frequency: 'daily',
    time: '08:00',
    timezone: 'Asia/Kolkata',
    include_link: true,
    attachment_format: '',
    page_id: pageId || '',
    filter_context: filters || [],
  });

  // Load existing items for this specific report
  const loadReportAutomations = async () => {
    if (!reportId) return;
    setLoadingItems(true);
    try {
      const [subs, alts] = await Promise.all([
        api<Subscription[]>(`/service/subscriptions?report_id=${encodeURIComponent(reportId)}`),
        api<AlertRule[]>(`/service/alerts?report_id=${encodeURIComponent(reportId)}`),
      ]);
      setSubscriptions(subs || []);
      setAlerts(alts || []);

      // If opening for the first time and there are items for the requested mode, show manage; else show create
      const targetCount = mode === 'subscription' ? (subs || []).length : (alts || []).length;
      setViewTab(targetCount > 0 ? 'manage' : 'create');
    } catch (e: any) {
      console.warn('Could not load report automations:', e);
    } finally {
      setLoadingItems(false);
    }
  };

  useEffect(() => {
    void loadReportAutomations();
  }, [reportId]);

  // Load workspace members for subscription recipient defaults
  useEffect(() => {
    if (!reportId) return;
    let active = true;
    setLoadingMembers(true);
    api<{ workspace_id: string; members: Array<{ email: string; user_id?: string; role?: string }> }>(
      `/service/reports/${reportId}/workspace-members`
    )
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
      .finally(() => {
        if (active) setLoadingMembers(false);
      });
    return () => {
      active = false;
    };
  }, [reportId]);

  // Measure candidates for alerts
  const eligible = useMemo(() => {
    const allPages = project?.report?.pages || [];
    const currentPage = pageId ? allPages.find((p: any) => String(p.id) === String(pageId)) : null;
    const targetPages =
      currentPage &&
      (currentPage.visuals || []).some((v: any) => ['card', 'kpi', 'gauge'].includes(String(v.type || '').toLowerCase()))
        ? [currentPage]
        : allPages;

    const modelMeasures = new Set(Object.keys(project?.model?.measures || {}));

    const found = targetPages.flatMap((page: any) =>
      (page.visuals || [])
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

    if (!found.length) {
      if (modelMeasures.size > 0) {
        return Array.from(modelMeasures).map(measure => ({
          visualId: '',
          label: `Measure: ${measure}`,
          measure,
        }));
      }
      const tableCols: any[] = [];
      const tables = project?.model?.tables || {};
      for (const [tName, tDef] of Object.entries<any>(tables)) {
        const cols = tDef?.columns ? (Array.isArray(tDef.columns) ? tDef.columns : Object.keys(tDef.columns)) : [];
        for (const col of cols) {
          tableCols.push({
            visualId: '',
            label: `${tName}.${col}`,
            measure: `${tName}.${col}`,
          });
        }
      }
      return tableCols;
    }

    return found;
  }, [project, pageId]);

  // Alert form state
  const [alert, setAlert] = useState<any>({
    name: 'KPI alert',
    selection: '',
    operator: 'gte',
    threshold: 0,
    channels: ['in_app', 'email'],
    evaluation_mode: 'after_refresh',
    evaluation_minutes: 60,
    cooldown_minutes: 60,
    repeat_enabled: false,
    recovery_enabled: true,
    filter_context: filters || [],
  });

  useEffect(() => {
    if (
      eligible.length > 0 &&
      (!alert.selection || !eligible.some((e: any) => `${e.visualId}|${e.measure}` === alert.selection))
    ) {
      setAlert((prev: any) => ({ ...prev, selection: `${eligible[0].visualId}|${eligible[0].measure}` }));
    }
  }, [eligible]);

  const startEditSubscription = (item: Subscription) => {
    let time = '08:00';
    if (item.cron_expr) {
      const parts = item.cron_expr.split(' ');
      if (parts.length >= 2 && !isNaN(Number(parts[0])) && !isNaN(Number(parts[1]))) {
        time = `${String(parts[1]).padStart(2, '0')}:${String(parts[0]).padStart(2, '0')}`;
      }
    }
    setSub({
      name: item.name || `${reportName} subscription`,
      recipients: (item.recipients || []).map((r: any) => r.email).filter(Boolean).join(', '),
      subject: item.subject || `VTAB Report: ${reportName}`,
      message: item.message || 'Your scheduled VTAB report is ready.',
      frequency: item.frequency || 'daily',
      time,
      timezone: item.timezone || 'Asia/Kolkata',
      include_link: item.include_link !== false,
      attachment_format: item.attachment_format || '',
      page_id: item.page_id || pageId || '',
      filter_context: item.filter_context || filters || [],
    });
    setEditingId(item.id);
    setViewTab('create');
    setError('');
    setSavedMessage('');
  };

  const startEditAlert = (item: AlertRule) => {
    const match = eligible.find((e: any) =>
      item.visual_id ? e.visualId === item.visual_id && e.measure === item.measure_name : e.measure === item.measure_name
    ) || eligible.find((e: any) => e.measure === item.measure_name);

    const selection = match
      ? `${match.visualId}|${match.measure}`
      : item.visual_id
      ? `${item.visual_id}|${item.measure_name}`
      : `|${item.measure_name}`;

    setAlert({
      name: item.name || 'KPI alert',
      selection,
      operator: item.operator || 'gte',
      threshold: item.threshold ?? 0,
      channels: item.channels || ['in_app', 'email'],
      evaluation_mode: item.evaluation_mode || 'after_refresh',
      evaluation_minutes: item.evaluation_minutes || 60,
      cooldown_minutes: item.cooldown_minutes ?? 60,
      repeat_enabled: !!item.repeat_enabled,
      recovery_enabled: item.recovery_enabled !== false,
      filter_context: item.filter_context || filters || [],
    });
    setEditingId(item.id);
    setViewTab('create');
    setError('');
    setSavedMessage('');
  };

  const resetForm = () => {
    setEditingId(null);
    if (activeKind === 'subscription') {
      const emails = workspaceMembers.map(m => m.email).filter(Boolean).join(', ');
      setSub({
        name: `${reportName} subscription`,
        recipients: emails,
        subject: `VTAB Report: ${reportName}`,
        message: 'Your scheduled VTAB report is ready.',
        frequency: 'daily',
        time: '08:00',
        timezone: 'Asia/Kolkata',
        include_link: true,
        attachment_format: '',
        page_id: pageId || '',
        filter_context: filters || [],
      });
    } else {
      setAlert({
        name: 'KPI alert',
        selection: eligible.length > 0 ? `${eligible[0].visualId}|${eligible[0].measure}` : '',
        operator: 'gte',
        threshold: 0,
        channels: ['in_app', 'email'],
        evaluation_mode: 'after_refresh',
        evaluation_minutes: 60,
        cooldown_minutes: 60,
        repeat_enabled: false,
        recovery_enabled: true,
        filter_context: filters || [],
      });
    }
  };

  // Save new or updated automation item
  const save = async () => {
    setBusy(true);
    setError('');
    setSavedMessage('');
    try {
      if (activeKind === 'subscription') {
        const raw = sub.recipients ? sub.recipients.split(',').map((x: string) => x.trim()).filter(Boolean) : [];
        const recipientsList = raw.length > 0 ? raw : workspaceMembers.map(m => m.email).filter(Boolean);
        const endpoint = editingId ? `/service/subscriptions/${editingId}` : '/service/subscriptions';
        const method = editingId ? 'PUT' : 'POST';
        await api(endpoint, {
          method,
          body: JSON.stringify({
            ...sub,
            report_id: reportId,
            recipients: recipientsList,
            attachment_format: sub.attachment_format || null,
          }),
        });
        setSavedMessage(editingId ? 'Subscription updated successfully.' : 'Subscription created successfully.');
      } else {
        const selected = eligible.find((item: any) => `${item.visualId}|${item.measure}` === alert.selection);
        let visualId = selected?.visualId || null;
        let measureName = selected?.measure || '';
        if (!measureName && alert.selection) {
          const parts = alert.selection.split('|');
          visualId = parts[0] || null;
          measureName = parts[1] || parts[0];
        }
        if (!measureName && eligible.length > 0) {
          visualId = eligible[0].visualId || null;
          measureName = eligible[0].measure;
        }
        if (!measureName) throw new Error('Choose a supported KPI, Card, or Gauge measure.');
        const endpoint = editingId ? `/service/alerts/${editingId}` : '/service/alerts';
        const method = editingId ? 'PUT' : 'POST';
        await api(endpoint, {
          method,
          body: JSON.stringify({
            ...alert,
            report_id: reportId,
            visual_id: visualId,
            measure_name: measureName,
            threshold: Number(alert.threshold),
          }),
        });
        setSavedMessage(editingId ? 'Alert updated successfully.' : 'Alert created successfully.');
      }
      setEditingId(null);
      await loadReportAutomations();
      setViewTab('manage');
    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  // Manage operations (toggle status, test, delete)
  const runOperation = async (kind: 'subscriptions' | 'alerts', id: string, operation: 'status' | 'test' | 'delete', status?: string) => {
    setActionBusy(`${kind}:${id}:${operation}`);
    setError('');
    try {
      await api(`/service/${kind}/${id}${operation === 'delete' ? '' : `/${operation}`}`, {
        method: operation === 'delete' ? 'DELETE' : 'POST',
        ...(operation === 'status' ? { body: JSON.stringify({ status }) } : {}),
      });
      await loadReportAutomations();
    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      setActionBusy('');
    }
  };

  const currentItems = activeKind === 'subscription' ? subscriptions : alerts;

  return (
    <div className="vtabSettingsBackdrop" onMouseDown={onClose}>
      <section className="vtabAutomationDialog vtabAutomationManager" onMouseDown={e => e.stopPropagation()} style={{ width: 'min(780px, calc(100vw - 32px))' }}>
        <header>
          <div>
            {activeKind === 'subscription' ? <CalendarClock size={20} /> : <BellRing size={20} />}
            <span>
              <b>{editingId ? (activeKind === 'subscription' ? 'Edit Report Subscription' : 'Edit Data Alert') : (activeKind === 'subscription' ? 'Report Subscriptions' : 'Data Alerts')}</b>
              <small>{reportName}</small>
            </span>
          </div>
          <button onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </header>

        {/* Category Tabs: Subscriptions vs Alerts */}
        <nav className="vtabSettingsTabs" style={{ padding: '6px 16px' }}>
          <button
            className={activeKind === 'subscription' ? 'active' : ''}
            onClick={() => {
              setActiveKind('subscription');
              setEditingId(null);
              setViewTab('manage');
              setError('');
              setSavedMessage('');
            }}
          >
            <CalendarClock size={14} /> Subscriptions <em>{subscriptions.length}</em>
          </button>
          <button
            className={activeKind === 'alert' ? 'active' : ''}
            onClick={() => {
              setActiveKind('alert');
              setEditingId(null);
              setViewTab('manage');
              setError('');
              setSavedMessage('');
            }}
          >
            <BellRing size={14} /> Alerts <em>{alerts.length}</em>
          </button>
          <button className="refresh" onClick={() => void loadReportAutomations()} title="Refresh list">
            <RefreshCw size={14} />
          </button>
        </nav>

        {/* View Toggle: Manage Existing vs Add New */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 20px', borderBottom: '1px solid var(--svc-border, #edebe9)', background: 'var(--svc-surface-2, #faf9f8)' }}>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              onClick={() => { setViewTab('manage'); setEditingId(null); setSavedMessage(''); }}
              style={{
                border: '1px solid ' + (viewTab === 'manage' ? '#0f6cbd' : 'var(--svc-border, #d1d5db)'),
                background: viewTab === 'manage' ? 'var(--svc-nav-active-bg, #e6f2fb)' : 'transparent',
                color: viewTab === 'manage' ? '#0f6cbd' : 'inherit',
                fontWeight: 650,
                fontSize: 12,
                borderRadius: 4,
                padding: '5px 12px',
                cursor: 'pointer',
              }}
            >
              Manage {activeKind === 'subscription' ? 'Subscriptions' : 'Alerts'} ({currentItems.length})
            </button>
            <button
              onClick={() => { resetForm(); setViewTab('create'); setSavedMessage(''); }}
              style={{
                border: '1px solid ' + (viewTab === 'create' && !editingId ? '#0f6cbd' : 'var(--svc-border, #d1d5db)'),
                background: viewTab === 'create' && !editingId ? 'var(--svc-nav-active-bg, #e6f2fb)' : 'transparent',
                color: viewTab === 'create' && !editingId ? '#0f6cbd' : 'inherit',
                fontWeight: 650,
                fontSize: 12,
                borderRadius: 4,
                padding: '5px 12px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 5,
              }}
            >
              <Plus size={13} /> Add New
            </button>
            {editingId && (
              <button
                style={{
                  border: '1px solid #0f6cbd',
                  background: 'var(--svc-nav-active-bg, #e6f2fb)',
                  color: '#0f6cbd',
                  fontWeight: 650,
                  fontSize: 12,
                  borderRadius: 4,
                  padding: '5px 12px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5,
                  cursor: 'default',
                }}
              >
                <Pencil size={13} /> Edit {activeKind === 'subscription' ? 'Subscription' : 'Alert'}
              </button>
            )}
          </div>
          <span style={{ fontSize: 11, color: 'var(--svc-muted, #616161)' }}>
            Showing items for: <b>{reportName}</b>
          </span>
        </div>

        <main style={{ padding: '16px 20px', maxHeight: '520px', overflowY: 'auto' }}>
          {error && <div className="vtabSettingsError" style={{ marginBottom: 12 }}>{error}</div>}
          {savedMessage && (
            <div className="vtabSettingsSaved" style={{ marginBottom: 12, padding: '8px 12px', background: '#f0fdf4', color: '#166534', border: '1px solid #bbf7d0', borderRadius: 6, fontSize: 12 }}>
              {savedMessage}
            </div>
          )}

          {/* ════════════════ VIEW 1: MANAGE EXISTING ════════════════ */}
          {viewTab === 'manage' && (
            <div>
              {loadingItems ? (
                <div className="vtabAutomationLoading">Loading {activeKind === 'subscription' ? 'subscriptions' : 'alerts'}…</div>
              ) : activeKind === 'subscription' ? (
                subscriptions.length === 0 ? (
                  <div className="vtabAutomationEmpty" style={{ padding: '32px 16px' }}>
                    <CalendarClock size={28} style={{ opacity: 0.5, marginBottom: 6 }} />
                    <b>No subscriptions for this dashboard yet.</b>
                    <span>Schedule automated email snapshots of this dashboard for your team.</span>
                    <button
                      onClick={() => setViewTab('create')}
                      className="primary"
                      style={{ marginTop: 12, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: 4, border: 'none', background: '#0f6cbd', color: '#fff', cursor: 'pointer', fontWeight: 600, fontSize: 12 }}
                    >
                      <Plus size={14} /> Create Subscription
                    </button>
                  </div>
                ) : (
                  <div className="vtabAutomationList">
                    {subscriptions.map(item => (
                      <article className="vtabAutomationItem" key={item.id}>
                        <div className="icon">
                          <CalendarClock size={18} />
                        </div>
                        <div className="details">
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <b>{item.name}</b>
                          </div>
                          <span>
                            {item.frequency.replace('_', ' ')} · {item.timezone} · {(item.recipients || []).map(r => r.email).join(', ')}
                          </span>
                          <small>
                            {item.last_status ? `Last delivery: ${item.last_status}` : 'Not delivered yet'}
                            {item.next_run ? ` · Next: ${formatTime(item.next_run)}` : ''}
                            {item.last_error ? ` · ${item.last_error}` : ''}
                          </small>
                        </div>
                        <span className={`vtabAutomationStatus ${item.status}`}>{item.status}</span>
                        <div className="vtabAutomationActions">
                          <button
                            onClick={() => startEditSubscription(item)}
                            title="Edit subscription"
                          >
                            <Pencil size={14} />
                          </button>
                          <button
                            disabled={actionBusy.startsWith(`subscriptions:${item.id}:`)}
                            onClick={() => void runOperation('subscriptions', item.id, 'status', item.status === 'active' ? 'paused' : 'active')}
                            title={item.status === 'active' ? 'Pause subscription' : 'Resume subscription'}
                          >
                            {item.status === 'active' ? <Pause size={14} /> : <Play size={14} />}
                          </button>
                          <button
                            disabled={actionBusy.startsWith(`subscriptions:${item.id}:`)}
                            onClick={() => void runOperation('subscriptions', item.id, 'test')}
                            title="Send test email now"
                          >
                            <Send size={14} />
                          </button>
                          <button
                            disabled={actionBusy.startsWith(`subscriptions:${item.id}:`)}
                            onClick={() => void runOperation('subscriptions', item.id, 'delete')}
                            title="Delete subscription"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                )
              ) : alerts.length === 0 ? (
                <div className="vtabAutomationEmpty" style={{ padding: '32px 16px' }}>
                  <BellRing size={28} style={{ opacity: 0.5, marginBottom: 6 }} />
                  <b>No KPI alerts for this dashboard yet.</b>
                  <span>Track critical measures and get notified when thresholds are crossed.</span>
                  <button
                    onClick={() => setViewTab('create')}
                    className="primary"
                    style={{ marginTop: 12, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: 4, border: 'none', background: '#0f6cbd', color: '#fff', cursor: 'pointer', fontWeight: 600, fontSize: 12 }}
                  >
                    <Plus size={14} /> Create Alert
                  </button>
                </div>
              ) : (
                <div className="vtabAutomationList">
                  {alerts.map(item => (
                    <article className="vtabAutomationItem" key={item.id}>
                      <div className="icon">
                        <BellRing size={18} />
                      </div>
                      <div className="details">
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <b>{item.name}</b>
                        </div>
                        <span>
                          {item.measure_name} {operatorLabel(item.operator)} {item.threshold}
                        </span>
                        <small>
                          {item.current_value !== undefined && item.current_value !== null ? `Current: ${item.current_value} · ` : ''}
                          {item.current_state || 'not evaluated'}
                          {item.last_evaluated_at ? ` · ${formatTime(item.last_evaluated_at)}` : ''}
                          {item.last_error ? ` · ${item.last_error}` : ''}
                        </small>
                      </div>
                      <span className={`vtabAutomationStatus ${item.status}`}>{item.status}</span>
                      <div className="vtabAutomationActions">
                        <button
                          onClick={() => startEditAlert(item)}
                          title="Edit alert"
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          disabled={actionBusy.startsWith(`alerts:${item.id}:`)}
                          onClick={() => void runOperation('alerts', item.id, 'status', item.status === 'active' ? 'paused' : 'active')}
                          title={item.status === 'active' ? 'Pause alert' : 'Resume alert'}
                        >
                          {item.status === 'active' ? <Pause size={14} /> : <Play size={14} />}
                        </button>
                        <button
                          disabled={actionBusy.startsWith(`alerts:${item.id}:`)}
                          onClick={() => void runOperation('alerts', item.id, 'test')}
                          title="Evaluate and test alert now"
                        >
                          <Send size={14} />
                        </button>
                        <button
                          disabled={actionBusy.startsWith(`alerts:${item.id}:`)}
                          onClick={() => void runOperation('alerts', item.id, 'delete')}
                          title="Delete alert"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ════════════════ VIEW 2: CREATE NEW / EDIT ════════════════ */}
          {viewTab === 'create' &&
            (activeKind === 'subscription' ? (
              <>
                <Field label="Subscription name">
                  <input value={sub.name} onChange={e => setSub({ ...sub, name: e.target.value })} />
                </Field>
                <Field label="Recipients">
                  <input
                    value={sub.recipients}
                    onChange={e => setSub({ ...sub, recipients: e.target.value })}
                    placeholder={loadingMembers ? 'Loading workspace members…' : 'name@company.com, team@company.com'}
                  />
                  <span className="vtabAutomationHelper" style={{ fontSize: 11, color: 'var(--svc-muted, #64748b)', marginTop: 4, display: 'block' }}>
                    {loadingMembers
                      ? 'Loading workspace members…'
                      : workspaceMembers.length > 0
                      ? `Defaulted to all ${workspaceMembers.length} member${workspaceMembers.length > 1 ? 's' : ''} in this workspace. You can edit recipients.`
                      : 'All members of this workspace will be included by default.'}
                  </span>
                </Field>
                <Field label="Email subject">
                  <input value={sub.subject} onChange={e => setSub({ ...sub, subject: e.target.value })} />
                </Field>
                <Field label="Message">
                  <textarea value={sub.message} onChange={e => setSub({ ...sub, message: e.target.value })} />
                </Field>
                <div className="vtabAutomationGrid">
                  <Field label="Frequency">
                    <select value={sub.frequency} onChange={e => setSub({ ...sub, frequency: e.target.value })}>
                      <option value="hourly">Hourly</option>
                      <option value="daily">Daily</option>
                      <option value="weekly">Weekly</option>
                      <option value="monthly">Monthly</option>
                      <option value="after_refresh">After successful refresh</option>
                    </select>
                  </Field>
                  <Field label="Delivery time">
                    <input type="time" disabled={sub.frequency === 'after_refresh'} value={sub.time} onChange={e => setSub({ ...sub, time: e.target.value })} />
                  </Field>
                  <Field label="Time zone">
                    <select value={sub.timezone} onChange={e => setSub({ ...sub, timezone: e.target.value })}>
                      <option>Asia/Kolkata</option>
                      <option>UTC</option>
                      <option>Asia/Dubai</option>
                      <option>Europe/London</option>
                      <option>America/New_York</option>
                    </select>
                  </Field>
                  <Field label="Attachment">
                    <select value={sub.attachment_format} onChange={e => setSub({ ...sub, attachment_format: e.target.value })}>
                      <option value="">Link only</option>
                      <option value="pdf">PDF</option>
                    </select>
                  </Field>
                </div>
                <label className="vtabAutomationCheck">
                  <input type="checkbox" checked={sub.include_link} onChange={e => setSub({ ...sub, include_link: e.target.checked })} />
                  Include a secure link to the report
                </label>
              </>
            ) : !eligible.length ? (
              <div className="vtabAutomationEmpty">This page has no supported numeric Card, KPI, or Gauge measure.</div>
            ) : (
              <>
                <Field label="Metric">
                  <select value={alert.selection} onChange={e => setAlert({ ...alert, selection: e.target.value })}>
                    <option value="">Select a metric</option>
                    {alert.selection && !eligible.some((item: any) => `${item.visualId}|${item.measure}` === alert.selection) && (
                      <option value={alert.selection}>
                        {alert.selection.includes('|') ? alert.selection.split('|')[1] : alert.selection}
                      </option>
                    )}
                    {eligible.map((item: any) => (
                      <option key={item.visualId + '|' + item.measure} value={item.visualId + '|' + item.measure}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <div className="vtabAutomationGrid">
                  <Field label="Condition">
                    <select value={alert.operator} onChange={e => setAlert({ ...alert, operator: e.target.value })}>
                      <option value="gt">Greater than</option>
                      <option value="gte">Greater than or equal</option>
                      <option value="lt">Less than</option>
                      <option value="lte">Less than or equal</option>
                      <option value="eq">Equal to</option>
                      <option value="neq">Not equal to</option>
                    </select>
                  </Field>
                  <Field label="Threshold">
                    <input type="number" value={alert.threshold} onChange={e => setAlert({ ...alert, threshold: e.target.value })} />
                  </Field>
                  <Field label="Evaluate">
                    <select value={alert.evaluation_mode} onChange={e => setAlert({ ...alert, evaluation_mode: e.target.value })}>
                      <option value="after_refresh">After successful refresh</option>
                      <option value="interval">On an interval</option>
                    </select>
                  </Field>
                  <Field label="Cooldown minutes">
                    <input type="number" min="0" value={alert.cooldown_minutes} onChange={e => setAlert({ ...alert, cooldown_minutes: Number(e.target.value) })} />
                  </Field>
                </div>
                <label className="vtabAutomationCheck">
                  <input
                    type="checkbox"
                    checked={alert.channels.includes('in_app')}
                    onChange={e =>
                      setAlert({
                        ...alert,
                        channels: e.target.checked ? [...new Set([...alert.channels, 'in_app'])] : alert.channels.filter((x: string) => x !== 'in_app'),
                      })
                    }
                  />
                  In-app notification
                </label>
                <label className="vtabAutomationCheck">
                  <input
                    type="checkbox"
                    checked={alert.channels.includes('email')}
                    onChange={e =>
                      setAlert({
                        ...alert,
                        channels: e.target.checked ? [...new Set([...alert.channels, 'email'])] : alert.channels.filter((x: string) => x !== 'email'),
                      })
                    }
                  />
                  Email notification
                </label>
                <label className="vtabAutomationCheck">
                  <input type="checkbox" checked={alert.recovery_enabled} onChange={e => setAlert({ ...alert, recovery_enabled: e.target.checked })} />
                  Notify me when the KPI recovers
                </label>
              </>
            ))}
        </main>

        <footer>
          {viewTab === 'create' && editingId ? (
            <>
              <button onClick={() => { setEditingId(null); setViewTab('manage'); }}>Cancel</button>
              <button className="primary" disabled={busy || (activeKind === 'alert' && !eligible.length)} onClick={() => void save()}>
                <Pencil size={15} />
                {busy ? 'Saving…' : activeKind === 'subscription' ? 'Save subscription' : 'Save alert'}
              </button>
            </>
          ) : viewTab === 'create' ? (
            <>
              <button onClick={onClose}>Done</button>
              <button className="primary" disabled={busy || (activeKind === 'alert' && !eligible.length)} onClick={() => void save()}>
                <Mail size={15} />
                {busy ? 'Saving…' : activeKind === 'subscription' ? 'Create subscription' : 'Create alert'}
              </button>
            </>
          ) : (
            <>
              <button onClick={onClose}>Done</button>
              <button
                className="primary"
                onClick={() => {
                  resetForm();
                  setViewTab('create');
                  setSavedMessage('');
                }}
              >
                <Plus size={15} />
                {activeKind === 'subscription' ? 'New subscription' : 'New alert'}
              </button>
            </>
          )}
        </footer>
      </section>
    </div>
  );
}

function Field({ label, children }: { label: string; children: any }) {
  return (
    <label className="vtabAutomationField">
      <span>{label}</span>
      {children}
    </label>
  );
}

function formatTime(value: string) {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
  } catch {
    return value;
  }
}

function operatorLabel(value: string) {
  return ({ gt: '>', gte: '≥', lt: '<', lte: '≤', eq: '=', neq: '≠' } as Record<string, string>)[value] || value;
}
