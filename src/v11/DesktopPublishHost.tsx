import { useEffect, useState } from 'react';
import { api } from '../api';
import { useStudio } from '../store';
import PublishToServiceDialog, { type PublishOptions, type PublishResult, type Workspace } from './PublishToServiceDialog';

function workspaceUrl(): string {
  const configured = String(import.meta.env.VITE_WEB_URL || localStorage.getItem('vtab_web_workspace_url') || '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  const entered = (window.prompt('Web Workspace URL', 'http://127.0.0.1:4173') || '').trim().replace(/\/+$/, '');
  if (entered) localStorage.setItem('vtab_web_workspace_url', entered);
  return entered;
}

export default function DesktopPublishHost() {
  const { project, save, update } = useStudio() as any;
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener('vtab:open-publish', show);
    return () => window.removeEventListener('vtab:open-publish', show);
  }, []);

  if (!open || !project) return null;

  const publish = async (
    workspace: Workspace,
    reportName: string,
    changeDescription: string,
    options: PublishOptions,
  ): Promise<PublishResult> => {
    await save();
    let snapshot = structuredClone(project);
    const targetReportId = options.reportId || snapshot.report?.id;
    if (targetReportId) snapshot.report.id = targetReportId;
    const sync = await api<any>('/cloud/sync-data', { method: 'POST', body: JSON.stringify(snapshot) });
    if (sync?.project) snapshot = sync.project;
    const result = await api<PublishResult>('/service/publish', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId: workspace.id,
        reportId: targetReportId,
        reportName,
        project: snapshot,
        overwrite: options.overwrite,
        desktopVersion: import.meta.env.VITE_APP_VERSION || '5.0.16',
        reportSchemaVersion: '1.0',
        changeDescription,
        metadata: {
          pageCount: snapshot.report?.pages?.length || 0,
          visualCount: (snapshot.report?.pages || []).reduce((count: number, page: any) => count + (page.visuals?.length || 0), 0),
        },
      }),
    });
    if (result.reportId && result.reportId !== project.report?.id) {
      update((current: any) => {
        current.report.id = result.reportId;
        return current;
      });
    }
    return result;
  };

  const openReport = (result: PublishResult) => {
    const base = workspaceUrl();
    if (!base) return;
    window.open(`${base}/?workspace=1&report=${encodeURIComponent(result.reportId)}`, '_blank');
  };

  return <PublishToServiceDialog
    reportId={project.report?.id}
    reportName={project.report?.name || project.name || 'Untitled Report'}
    onClose={() => setOpen(false)}
    onPublish={publish}
    onOpenReport={openReport}
  />;
}
