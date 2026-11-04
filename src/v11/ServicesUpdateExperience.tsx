import { useCallback, useEffect, useRef, useState } from 'react';
import { Bell, ChevronDown, ChevronUp, FileText, GitCommit, Clock, RotateCw, ShieldCheck, X } from 'lucide-react';
import { api } from '../api';
import PixelBuildScreen, { type ServicesUpdateStatus } from './PixelBuildScreen';

const activeStates = new Set(['queued', 'applying', 'deploying', 'building', 'restarting']);

export default function ServicesUpdateExperience() {
  const [status, setStatus] = useState<ServicesUpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const mounted = useRef(true);

  const poll = useCallback(async () => {
    try {
      const next = await api<ServicesUpdateStatus>('/update/status');
      if (mounted.current) setStatus(next);
    } catch {
      /* Keep the current update UI while a managed service restarts. */
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    poll();
    const timer = window.setInterval(poll,5000);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, [poll]);

  useEffect(() => {
    if (status && activeStates.has(status.status)) {
      localStorage.setItem('vtab_building_update', '1');
    } else if (
      status &&
      (status.status === 'completed' ||
        status.status === 'cancelled' ||
        status.status === 'idle' ||
        status.status === 'available' ||
        !status.update_available)
    ) {
      localStorage.removeItem('vtab_building_update');
    }
  }, [status]);

  const apply = async () => {
    setBusy(true);
    setDismissed(false);
    localStorage.setItem('vtab_building_update', '1');
    try {
      setStatus(await api<ServicesUpdateStatus>('/update/apply', { method: 'POST', body: '{}' }));
    } finally {
      setBusy(false);
    }
  };

  const building = !!status && activeStates.has(status.status);
  if (building && status) {
    return (
      <PixelBuildScreen
        status={status}
        onClose={() => (status.status === 'completed' ? location.reload() : setStatus({ ...status, status: 'idle' }))}
      />
    );
  }

  if (!status?.update_available || dismissed) return null;

  // Format version text to match the requested header:
  // "Update available: Reporting Services vcommit-cf8bc1d094f0" or "v6.1.10"
  const versionDisplay = status.available_version
    ? (status.available_version.startsWith('v') ? status.available_version : `v${status.available_version}`)
    : (status.target_commit_sha ? `vcommit-${status.target_commit_sha.slice(0, 12)}` : 'vlatest');

  const notesText = status.release_notes?.trim() || '';

  return (
    <div className="vtabUpdateBannerContainer">
      <aside className="vtabUpdateBanner">
        <div className="vtabUpdateBannerLeft">
          <span className="vtabUpdateBellIcon" aria-hidden="true">
            <Bell size={16} />
          </span>
          <span className="vtabUpdateBannerText">
            Update available: Reporting Services {versionDisplay}
          </span>
        </div>

        <div className="vtabUpdateBannerRight">
          <button
            type="button"
            className="vtabUpdateNotesToggle"
            onClick={() => setExpanded((prev) => !prev)}
            aria-expanded={expanded}
            title="View release notes from Manager application"
          >
            <FileText size={13} />
            <span>Release Notes</span>
            {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>

          <button
            type="button"
            className="vtabUpdateNow"
            disabled={busy}
            onClick={apply}
            title="Deploy and apply this update now"
          >
            {busy ? <RotateCw className="spin" size={13} /> : null}
            <span>Update Now</span>
          </button>

          <button
            type="button"
            className="vtabUpdateDismiss"
            aria-label="Dismiss update notice"
            onClick={() => setDismissed(true)}
            title="Dismiss"
          >
            <X size={16} />
          </button>
        </div>
      </aside>

      {expanded && (
        <div className="vtabUpdateNotesCard" role="region" aria-label="Release notes">
          <div className="vtabUpdateNotesCardHeader">
            <div className="vtabUpdateNotesCardTitle">
              <FileText size={15} className="vtabNotesIcon" />
              <b>Manager Release Notes</b>
              <span className="vtabNotesBadge">{versionDisplay}</span>
              {status.target_commit_sha && (
                <span className="vtabCommitBadge">
                  <GitCommit size={12} /> {status.target_commit_sha.slice(0, 8)}
                </span>
              )}
            </div>
            {status.requested_at && (
              <span className="vtabNotesTime">
                <Clock size={12} /> {new Date(status.requested_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
              </span>
            )}
          </div>

          <div className="vtabUpdateNotesCardBody">
            {notesText ? (
              <div className="vtabNotesContent">
                {notesText.split('\n').map((line, idx) => {
                  const trimmed = line.trim();
                  if (!trimmed) return <div key={idx} className="vtabNotesSpacer" />;
                  if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
                    return (
                      <div key={idx} className="vtabNotesBullet">
                        <span className="vtabBulletDot">•</span>
                        <span>{trimmed.slice(2)}</span>
                      </div>
                    );
                  }
                  return (
                    <p key={idx} className="vtabNotesParagraph">
                      {trimmed}
                    </p>
                  );
                })}
              </div>
            ) : (
              <p className="vtabNotesEmpty">
                No custom release notes provided for this release. Dispatched from the VTAB Reporting Manager deployment pipeline.
              </p>
            )}
          </div>

          <div className="vtabUpdateNotesCardFooter">
            <span className="vtabNotesHint">
              <ShieldCheck size={13} /> Approved and verified release artifact
            </span>
            <div className="vtabNotesActions">
              <button
                type="button"
                className="vtabNotesCollapseBtn"
                onClick={() => setExpanded(false)}
              >
                Collapse
              </button>
              <button
                type="button"
                className="vtabUpdateNow"
                disabled={busy}
                onClick={apply}
              >
                {busy ? <RotateCw className="spin" size={13} /> : null}
                <span>Apply Update Now</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
