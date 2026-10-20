import { useEffect, useState } from 'react';
import { api } from '../api';
import { useStudio } from '../store';
import PublishToServiceDialog, { type PublishOptions, type PublishResult, type Workspace } from './PublishToServiceDialog';

function workspaceUrl(): string {
  const configured = String(import.meta.env.VITE_WEB_URL || localStorage.getItem('vtab_web_workspace_url') || '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  return 'https://vtab-reporting-web-uzpg.onrender.com';
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
    try {
      await save();
    } catch (saveError) {
      console.warn('Pre-publish auto-save note:', saveError);
    }
    let snapshot = structuredClone(project);
    if (!snapshot.report) snapshot.report = { id: '', name: reportName, pages: [] };
    const targetReportId = options.reportId || snapshot.report?.id;
    if (targetReportId) snapshot.report.id = targetReportId;
    snapshot.paginatedPublishMode = options.paginatedMode || snapshot.paginatedPublishMode || 'together';
    try {
      const sync = await api<any>('/cloud/sync-data', { method: 'POST', body: JSON.stringify(snapshot) });
      if (sync?.project) snapshot = sync.project;
    } catch (syncError: any) {
      const message = String(syncError?.message || syncError).toLowerCase();
      if (message.includes('401') || message.includes('session') || message.includes('sign in') || message.includes('auth')) throw syncError;
      console.warn('Cloud data sync note:', syncError);
    }
    const result = await api<PublishResult>('/service/publish', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId: workspace.id,
        reportId: targetReportId,
        reportName,
        project: snapshot,
        overwrite: options.overwrite,
        desktopVersion: import.meta.env.VITE_APP_VERSION || '5.0.19',
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
        if (!current.report) current.report = {};
        current.report.id = result.reportId;
        return current;
      });
    }
    return result;
  };

  const openReport = (result: PublishResult) => {
    const targetUrl = result.reportUrl || `${workspaceUrl()}/?workspace=1&report=${encodeURIComponent(result.reportId)}`;
    window.open(targetUrl, '_blank');
  };

  return <PublishToServiceDialog
    reportId={project.report?.id}
    reportName={project.report?.name || project.name || 'Untitled Report'}
    onClose={() => setOpen(false)}
    onPublish={publish}
    onOpenReport={openReport}
    paginatedReportCount={project.paginatedReports?.length || 0}
  />;
}
