import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, ExternalLink, LoaderCircle, Replace, Send, TriangleAlert, X } from 'lucide-react';
import { api } from '../api';

export type Workspace = {
  id: string;
  name: string;
  description?: string;
  organizationId?: string;
  role: 'Admin' | 'Member' | 'Contributor' | 'Viewer';
  canPublish: boolean;
  isPersonal?: boolean;
};

type PublishContext = {
  workspaces: Workspace[];
  serviceApiVersion: string;
  reportSchemaVersion: string;
};

type ExistingReport = {
  id: string;
  name: string;
  workspace_id: string;
  updated_at?: string;
  current_version_id?: string;
};

export type PublishOptions = { overwrite: boolean; reportId?: string; paginatedMode?: 'together'|'separate' };

export type PublishResult = {
  reportId: string;
  workspaceId: string;
  versionId: string;
  version: string;
  semanticModelId?: string;
  semanticModelName?: string;
  semanticModelVersionId?: string;
  semanticModelVersion?: string;
  semantic_model_name?: string;
  reportUrl: string;
  publishedAt: string;
};

export default function PublishToServiceDialog({
  reportId,
  reportName,
  onClose,
  onPublish,
  onOpenReport,
  paginatedReportCount = 0,
}: {
  reportId?: string;
  reportName: string;
  onClose: () => void;
  onPublish: (workspace: Workspace, name: string, changeDescription: string, options: PublishOptions) => Promise<PublishResult>;
  onOpenReport: (result: PublishResult) => void;
  paginatedReportCount?: number;
}) {
  const [context, setContext] = useState<PublishContext | null>(null);
  const [workspaceId, setWorkspaceId] = useState('');
  const [name, setName] = useState(reportName);
  const [changeDescription, setChangeDescription] = useState('');
  const [reports, setReports] = useState<ExistingReport[]>([]);
  const [reportsBusy, setReportsBusy] = useState(false);
  const [reportsError, setReportsError] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<PublishResult | null>(null);
  const [replaceTarget, setReplaceTarget] = useState<ExistingReport | null>(null);
  const [paginatedMode, setPaginatedMode] = useState<'together'|'separate'>('together');

  const loadContext = () => {
    setError('');
    api<PublishContext>('/service/publish-context')
      .then(data => {
        setContext(data);
        const first = data.workspaces.find(workspace => workspace.canPublish);
        if (first) setWorkspaceId(first.id);
      })
      .catch(reason => setError(reason?.message || String(reason)));
  };

  useEffect(() => {
    loadContext();
  }, []);

  const authError = (message: string) => {
    const normalized=message.toLowerCase();
    return normalized.includes('401')||normalized.includes('session')||normalized.includes('sign in')||normalized.includes('auth')||normalized.includes('not signed in');
  };
  const requestSignIn = () => {
    localStorage.removeItem('vtab_supabase_token');
    localStorage.removeItem('vtab_workspace_token');
    window.dispatchEvent(new CustomEvent('vtab:session-expired'));
    onClose();
  };

  const publishable = useMemo(
    () => context?.workspaces.filter(workspace => workspace.canPublish) || [],
    [context],
  );
  const selected = publishable.find(workspace => workspace.id === workspaceId);

  const loadReports = async (selectedWorkspaceId: string) => {
    if (!selectedWorkspaceId) return;
    setReportsBusy(true);
    setReportsError('');
    try {
      setReports(await api<ExistingReport[]>(`/service/workspaces/${encodeURIComponent(selectedWorkspaceId)}/reports`));
    } catch (reason: any) {
      setReports([]);
      setReportsError(reason?.message || String(reason));
    } finally {
      setReportsBusy(false);
    }
  };

  useEffect(() => {
    setReplaceTarget(null);
    setResult(null);
    if (workspaceId) void loadReports(workspaceId);
  }, [workspaceId]);

  const conflict = useMemo(() => {
    const byId = reportId ? reports.find(report => report.id === reportId) : undefined;
    if (byId) return byId;
    const normalized = name.trim().toLocaleLowerCase();
    return normalized ? reports.find(report => report.name.trim().toLocaleLowerCase() === normalized) : undefined;
  }, [reports, reportId, name]);

  const performPublish = async (overwrite: boolean, target?: ExistingReport) => {
    if (!selected || !name.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      setResult(await onPublish(selected, name.trim(), changeDescription.trim(), {
        overwrite,
        reportId: target?.id || reportId,
        paginatedMode: paginatedReportCount ? paginatedMode : undefined,
      }));
      setReplaceTarget(null);
    } catch (reason: any) {
      setError(reason?.message || String(reason));
    } finally {
      setBusy(false);
    }
  };

  const publish = () => {
    if (conflict) {
      setReplaceTarget(conflict);
      setError('');
      return;
    }
    void performPublish(false);
  };

  return (
    <div className="servicePublishBackdrop" role="presentation" onMouseDown={event => event.target === event.currentTarget && !busy && onClose()}>
      <section className="servicePublishDialog" role="dialog" aria-modal="true" aria-labelledby="servicePublishTitle">
        <header>
          <div><small>REPORTING SERVICE</small><h2 id="servicePublishTitle">Publish report</h2></div>
          <button className="icon" onClick={onClose} disabled={busy} aria-label="Close"><X size={18}/></button>
        </header>

        {result ? (
          <div className="servicePublishSuccess">
            <CheckCircle2 size={42}/>
            <h3>{result.version === '1.0' ? 'Published successfully' : 'Report replaced successfully'}</h3>
            <dl>
              <div><dt>Workspace</dt><dd>{selected?.name}</dd></div>
              <div><dt>Report</dt><dd>{name}</dd></div>
              <div><dt>Unified Data Model</dt><dd>{result.semanticModelName || result.semantic_model_name || `${name} Unified Data Model`}</dd></div>
              <div><dt>Version</dt><dd>{result.version}</dd></div>
            </dl>
            <p className="servicePublishDescription">The report and its connected Unified Data Model were created or updated together by the service.</p>
            <button className="primary" onClick={() => onOpenReport(result)}><ExternalLink size={16}/>Open in Reporting Service</button>
          </div>
        ) : replaceTarget ? (
          <div className="servicePublishReplace">
            <TriangleAlert size={40}/>
            <h3>Replace existing report?</h3>
            <p><b>{replaceTarget.name}</b> already exists in <b>{selected?.name}</b>.</p>
            <p>Replacing it updates the published report for viewers and keeps the previous version in version history.</p>
            {error && <div className="servicePublishError" style={{display: 'flex', flexDirection: 'column', gap: '8px'}}>
              <span>{error}</span>
              {authError(error)&&<button className="primary" onClick={requestSignIn}>Sign in to Reporting Service</button>}
            </div>}
            <div className="servicePublishReplaceActions">
              <button onClick={() => setReplaceTarget(null)} disabled={busy}>No, go back</button>
              <button className="primary" onClick={() => void performPublish(true, replaceTarget)} disabled={busy}>
                {busy ? <LoaderCircle className="spin" size={16}/> : <Replace size={16}/>}
                {busy ? 'Replacing…' : 'Yes, replace'}
              </button>
            </div>
          </div>
        ) : (
          <div className="servicePublishBody">
            {!context && !error && <div className="servicePublishLoading"><LoaderCircle className="spin" size={22}/>Loading your workspaces…</div>}
            {context && !publishable.length && <div className="servicePublishWarning">Your account has Viewer access only. Ask a workspace Admin for Contributor, Member, or Admin access.</div>}
            {!!publishable.length && <>
              <label>Workspace<select value={workspaceId} onChange={event => setWorkspaceId(event.target.value)}>{publishable.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.name} · {workspace.role}</option>)}</select></label>
              {selected?.isPersonal ? <div className="servicePublishWarning"><b>Private destination.</b><span>Reports in My Workspace are visible only to you and cannot be shared. Choose or create a team workspace for collaboration.</span></div> : <div className="servicePublishDescription"><b>Team workspace.</b> Workspace members can access published content according to their role. Viewer access remains restricted by RLS.</div>}
              {selected?.description && <p className="servicePublishDescription">{selected.description}</p>}
              <label>Report name<input value={name} maxLength={160} onChange={event => setName(event.target.value)}/></label>
              <label>What changed? <span>Optional</span><textarea rows={3} value={changeDescription} maxLength={500} onChange={event => setChangeDescription(event.target.value)} placeholder="Describe this version"/></label>
              {paginatedReportCount>0&&<fieldset className="paginatedPublishChoice"><legend>Publish paginated reports</legend><p>{paginatedReportCount} paginated report{paginatedReportCount===1?' is':'s are'} included in this project.</p><label className={paginatedMode==='together'?'selected':''}><input type="radio" name="paginatedMode" value="together" checked={paginatedMode==='together'} onChange={()=>setPaginatedMode('together')}/><span><b>Publish together</b><small>Keep one package and add a Paginated Reports entry inside the published dashboard.</small></span></label><label className={paginatedMode==='separate'?'selected':''}><input type="radio" name="paginatedMode" value="separate" checked={paginatedMode==='separate'} onChange={()=>setPaginatedMode('separate')}/><span><b>Publish separately</b><small>Publish the dashboard and each paginated report as separate workspace items using the same Unified Data Model.</small></span></label></fieldset>}
              <div className="servicePublishWarning"><CheckCircle2 size={16}/><span>Publish automatically creates or updates the report and its connected Unified Data Model. No separate model setup is required.</span></div>
              {reportsBusy && <div className="servicePublishLoading"><LoaderCircle className="spin" size={16}/>Checking existing reports…</div>}
              {conflict && !reportsBusy && <div className="servicePublishWarning"><Replace size={16}/><span><b>{conflict.name}</b> already exists. Publish will ask before replacing it.</span></div>}
              {reportsError && <div className="servicePublishError"><span>{reportsError}</span><button onClick={() => void loadReports(workspaceId)}>Retry check</button></div>}
              <div className="servicePublishCompatibility"><span>Desktop {import.meta.env.VITE_APP_VERSION || '5.0.19'}</span><span>Report schema {context?.reportSchemaVersion || '1.0'}</span><span>Service API {context?.serviceApiVersion || 'v1'}</span></div>
            </>}
            {error && <div className="servicePublishError" style={{display: 'flex', flexDirection: 'column', gap: '8px'}}>
              <span>{error}</span>
              <div style={{display:'flex',gap:8,alignItems:'center',marginTop:4}}>
                {!context&&<button type="button" onClick={loadContext}>Retry</button>}
                {authError(error)&&<button type="button" className="primary" onClick={requestSignIn}>Sign in to Reporting Service</button>}
              </div>
            </div>}
          </div>
        )}

        {!result && !replaceTarget && <footer><button onClick={onClose} disabled={busy}>Cancel</button><button className="primary" onClick={publish} disabled={!selected || !name.trim() || busy || reportsBusy}>{busy ? <LoaderCircle className="spin" size={16}/> : <Send size={16}/>} {busy ? 'Publishing…' : 'Publish'}</button></footer>}
      </section>
    </div>
  );
}
