import { useEffect, useState, useMemo } from 'react';
import { 
  AlertTriangle, 
  ArrowLeft, 
  CheckCircle2, 
  Download, 
  ExternalLink, 
  Filter, 
  HelpCircle, 
  LifeBuoy, 
  Lightbulb, 
  Mail, 
  MessageSquare, 
  Plus, 
  RefreshCw, 
  Search, 
  ShieldAlert, 
  X 
} from 'lucide-react';
import { api } from '../api';

export interface SupportRequest {
  id: string;
  request_number: string;
  issue_title: string;
  description: string;
  service: string;
  severity: string;
  status: string;
  owner_email: string;
  workspace_name?: string;
  created_at: string;
  updated_at: string;
}

interface HelpSupportViewProps {
  onBack: () => void;
  activeWorkspaceName?: string;
  activeWorkspaceId?: string;
  userEmail?: string;
}

export default function HelpSupportView({
  onBack,
  activeWorkspaceName,
  activeWorkspaceId,
  userEmail,
}: HelpSupportViewProps) {
  const [tab, setTab] = useState<'my' | 'open' | 'closed'>('my');
  const [requests, setRequests] = useState<SupportRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [sidePanelOpen, setSidePanelOpen] = useState(true);
  const [briefSearch, setBriefSearch] = useState('');
  const [modalOpen, setModalOpen] = useState(false);

  // New request form state
  const [adminEmail, setAdminEmail] = useState('harishkadhi18022001@gmail.com');
  const [newTitle, setNewTitle] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newService, setNewService] = useState('Reporting Services');
  const [newSeverity, setNewSeverity] = useState('Medium');
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [selectedRequest, setSelectedRequest] = useState<SupportRequest | null>(null);

  // Load config & requests
  const loadConfig = async () => {
    try {
      const cfg = await api<{ admin_email: string }>('/service/support-config');
      if (cfg?.admin_email) {
        setAdminEmail(cfg.admin_email);
      }
    } catch {
      // fallback to default
    }
  };

  const loadRequests = async () => {
    setLoading(true);
    setErrorMsg('');
    try {
      const res = await api<{ requests: SupportRequest[] }>(`/service/support-requests?tab=${tab}`);
      setRequests(res.requests || []);
    } catch (e: any) {
      setErrorMsg(e.message || 'Failed to load support requests');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadConfig();
  }, []);

  useEffect(() => {
    void loadRequests();
    const interval = setInterval(() => {
      void loadRequests();
    }, 15000);
    return () => clearInterval(interval);
  }, [tab]);

  // Filter requests by search term
  const filteredRequests = useMemo(() => {
    if (!search.trim()) return requests;
    const q = search.toLowerCase();
    return requests.filter(r => 
      r.issue_title.toLowerCase().includes(q) ||
      r.request_number.toLowerCase().includes(q) ||
      r.service.toLowerCase().includes(q) ||
      r.owner_email.toLowerCase().includes(q)
    );
  }, [requests, search]);

  const openNewRequestModal = (initialTitle = '') => {
    setNewTitle(initialTitle || briefSearch || '');
    setNewDesc('');
    setErrorMsg('');
    setSuccessMsg('');
    setModalOpen(true);
  };

  const submitRequest = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!newTitle.trim()) {
      setErrorMsg('Please enter an issue title.');
      return;
    }
    if (!newDesc.trim()) {
      setErrorMsg('Please describe the problem.');
      return;
    }

    setSubmitting(true);
    setErrorMsg('');
    try {
      const res = await api<{ ok: boolean; request: SupportRequest }>('/service/support-requests', {
        method: 'POST',
        body: JSON.stringify({
          issue_title: newTitle.trim(),
          description: newDesc.trim(),
          service: newService,
          severity: newSeverity,
          admin_email: adminEmail,
          workspace_id: activeWorkspaceId,
          workspace_name: activeWorkspaceName || 'Workspace',
          owner_email: userEmail || '',
        }),
      });

      if (res?.ok && res.request) {
        setSuccessMsg(`Support request ${res.request.request_number} submitted and sent to ${adminEmail}.`);
        setModalOpen(false);
        setBriefSearch('');
        // Reload list
        await loadRequests();
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to submit support request');
    } finally {
      setSubmitting(false);
    }
  };

  const exportCsv = () => {
    if (!requests.length) return;
    const headers = ['Request ID', 'Title', 'Service', 'Severity', 'Status', 'Owner', 'Created At'];
    const rows = requests.map(r => [
      r.request_number,
      `"${r.issue_title.replace(/"/g, '""')}"`,
      r.service,
      r.severity,
      r.status,
      r.owner_email,
      r.created_at,
    ]);
    const csv = [headers.join(','), ...rows.map(row => row.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `VTAB_Support_Requests_${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0, background: '#f8fafc', color: '#1e293b', overflow: 'hidden' }}>
      {/* MAIN VIEW AREA */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'auto' }}>
        
        {/* Top bar header banner */}
        <div style={{ padding: '20px 28px 16px', background: '#ffffff', borderBottom: '1px solid #e2e8f0' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <button 
                onClick={onBack}
                title="Back to workspace"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '6px 12px',
                  borderRadius: 6,
                  border: '1px solid #cbd5e1',
                  background: '#ffffff',
                  color: '#475569',
                  fontSize: 13,
                  fontWeight: 500,
                  cursor: 'pointer',
                }}
              >
                <ArrowLeft size={15} />
                Back
              </button>
              <div>
                <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, color: '#0f172a' }}>Help + support</h1>
                <p style={{ margin: '4px 0 0', fontSize: 13, color: '#64748b' }}>
                  Review and submit new cases for your support requests.
                </p>
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <a 
                href="http://admin-reporting.139.59.32.39.nip.io/"
                target="_blank"
                rel="noreferrer"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  fontSize: 12,
                  color: '#0f6cbd',
                  textDecoration: 'none',
                  fontWeight: 500,
                }}
              >
                Known issues in VTAB Services
                <ExternalLink size={12} />
              </a>

              {!sidePanelOpen && (
                <button
                  onClick={() => setSidePanelOpen(true)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '6px 12px',
                    borderRadius: 6,
                    border: '1px solid #cce4f7',
                    background: '#f0f7fc',
                    color: '#0f6cbd',
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  <HelpCircle size={15} />
                  Help Panel
                </button>
              )}
            </div>
          </div>

          {/* Action buttons bar */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, marginTop: 16, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button
                onClick={() => openNewRequestModal()}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '7px 14px',
                  borderRadius: 6,
                  background: '#0f6cbd',
                  color: '#ffffff',
                  border: 'none',
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: 'pointer',
                  boxShadow: '0 1px 2px rgba(0,0,0,0.06)',
                }}
              >
                <Plus size={16} />
                New support request
              </button>

              <button
                onClick={loadRequests}
                disabled={loading}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '7px 12px',
                  borderRadius: 6,
                  border: '1px solid #cbd5e1',
                  background: '#ffffff',
                  color: '#475569',
                  fontSize: 13,
                  cursor: 'pointer',
                }}
              >
                <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
                Refresh
              </button>
              </div>

            {/* Filter tabs and search */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ display: 'flex', background: '#f1f5f9', borderRadius: 6, padding: 3, border: '1px solid #e2e8f0' }}>
                <button
                  onClick={() => setTab('my')}
                  style={{
                    padding: '5px 12px',
                    borderRadius: 4,
                    border: 'none',
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: 'pointer',
                    background: tab === 'my' ? '#ffffff' : 'transparent',
                    color: tab === 'my' ? '#0f172a' : '#64748b',
                    boxShadow: tab === 'my' ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
                  }}
                >
                  My requests
                </button>
                <button
                  onClick={() => setTab('open')}
                  style={{
                    padding: '5px 12px',
                    borderRadius: 4,
                    border: 'none',
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: 'pointer',
                    background: tab === 'open' ? '#ffffff' : 'transparent',
                    color: tab === 'open' ? '#0f172a' : '#64748b',
                    boxShadow: tab === 'open' ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
                  }}
                >
                  Open requests
                </button>
                <button
                  onClick={() => setTab('closed')}
                  style={{
                    padding: '5px 12px',
                    borderRadius: 4,
                    border: 'none',
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: 'pointer',
                    background: tab === 'closed' ? '#ffffff' : 'transparent',
                    color: tab === 'closed' ? '#0f172a' : '#64748b',
                    boxShadow: tab === 'closed' ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
                  }}
                >
                  Closed requests
                </button>
              </div>

              <div style={{ position: 'relative', width: 200 }}>
                <Filter size={13} style={{ position: 'absolute', left: 9, top: 9, color: '#94a3b8' }} />
                <input
                  type="text"
                  placeholder="Filter by keyword"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '6px 10px 6px 28px',
                    fontSize: 12,
                    borderRadius: 6,
                    border: '1px solid #cbd5e1',
                    outline: 'none',
                    background: '#ffffff',
                  }}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Success toast notification */}
        {successMsg && (
          <div style={{ margin: '14px 28px 0', padding: '10px 16px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#166534', fontSize: 13, fontWeight: 500 }}>
              <CheckCircle2 size={16} />
              {successMsg}
            </div>
            <button onClick={() => setSuccessMsg('')} style={{ background: 'none', border: 'none', color: '#166534', cursor: 'pointer' }}><X size={15} /></button>
          </div>
        )}

        {/* Requests Table Content */}
        <div style={{ padding: '20px 28px', flex: 1 }}>
          <div style={{ background: '#ffffff', borderRadius: 8, border: '1px solid #e2e8f0', boxShadow: '0 1px 3px rgba(0,0,0,0.04)', overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f8fafc', borderBottom: '1px solid #e2e8f0', color: '#64748b', fontWeight: 600, fontSize: 12 }}>
                  <th style={{ width: 40, padding: '12px 14px', textAlign: 'center' }}>
                    <input type="checkbox" style={{ cursor: 'pointer' }} />
                  </th>
                  <th style={{ padding: '12px 14px' }}>Issue title</th>
                  <th style={{ padding: '12px 14px' }}>Request ID</th>
                  <th style={{ padding: '12px 14px' }}>Service</th>
                  <th style={{ padding: '12px 14px' }}>Created at</th>
                  <th style={{ padding: '12px 14px' }}>Last modified</th>
                  <th style={{ padding: '12px 14px' }}>Owner email</th>
                  <th style={{ padding: '12px 14px' }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={8} style={{ padding: 40, textAlign: 'center', color: '#64748b' }}>
                      <RefreshCw size={20} className="animate-spin" style={{ margin: '0 auto 8px', display: 'block' }} />
                      Loading support requests…
                    </td>
                  </tr>
                ) : filteredRequests.length === 0 ? (
                  <tr>
                    <td colSpan={8} style={{ padding: 50, textAlign: 'center' }}>
                      <LifeBuoy size={36} color="#94a3b8" style={{ margin: '0 auto 12px', display: 'block' }} />
                      <b style={{ fontSize: 15, color: '#334155', display: 'block' }}>No support requests</b>
                      <span style={{ fontSize: 13, color: '#64748b', display: 'block', margin: '4px 0 16px' }}>
                        {search ? 'No requests match your filter keyword.' : 'You have not submitted any support requests yet.'}
                      </span>
                      <button
                        onClick={() => openNewRequestModal()}
                        style={{
                          padding: '7px 16px',
                          borderRadius: 6,
                          background: '#0f6cbd',
                          color: '#ffffff',
                          border: 'none',
                          fontSize: 13,
                          fontWeight: 600,
                          cursor: 'pointer',
                        }}
                      >
                        + Create support request
                      </button>
                    </td>
                  </tr>
                ) : (
                  filteredRequests.map(req => (
                    <tr 
                      key={req.id} 
                      onClick={() => setSelectedRequest(req)}
                      style={{ borderBottom: '1px solid #f1f5f9', cursor: 'pointer', transition: 'background 0.15s' }}
                      onMouseEnter={e => e.currentTarget.style.background = '#f8fafc'}
                      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                    >
                      <td style={{ width: 40, padding: '12px 14px', textAlign: 'center' }} onClick={e => e.stopPropagation()}>
                        <input type="checkbox" style={{ cursor: 'pointer' }} />
                      </td>
                      <td style={{ padding: '12px 14px', fontWeight: 600, color: '#0f6cbd' }}>
                        {req.issue_title}
                      </td>
                      <td style={{ padding: '12px 14px', color: '#475569', fontFamily: 'monospace', fontSize: 12 }}>
                        {req.request_number}
                      </td>
                      <td style={{ padding: '12px 14px', color: '#334155' }}>
                        {req.service}
                      </td>
                      <td style={{ padding: '12px 14px', color: '#64748b', fontSize: 12 }}>
                        {new Date(req.created_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
                      </td>
                      <td style={{ padding: '12px 14px', color: '#64748b', fontSize: 12 }}>
                        {new Date(req.updated_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
                      </td>
                      <td style={{ padding: '12px 14px', color: '#334155', fontSize: 12 }}>
                        {req.owner_email}
                      </td>
                      <td style={{ padding: '12px 14px' }}>
                        <span style={{
                          display: 'inline-block',
                          padding: '2px 8px',
                          borderRadius: 12,
                          fontSize: 11,
                          fontWeight: 600,
                          background: req.status.toLowerCase() === 'open' ? '#dcfce7' : req.status.toLowerCase() === 'closed' ? '#f1f5f9' : '#fef3c7',
                          color: req.status.toLowerCase() === 'open' ? '#15803d' : req.status.toLowerCase() === 'closed' ? '#475569' : '#b45309',
                        }}>
                          {req.status}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>

            {/* Table footer / count */}
            <div style={{ padding: '10px 16px', background: '#fafafa', borderTop: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, color: '#64748b' }}>
              <span>Items: {filteredRequests.length}</span>
              <span>Default Admin: {adminEmail}</span>
            </div>
          </div>
        </div>
      </div>

      {/* RIGHT SIDE PANEL: "Help and Support" (matching Power BI sidebar) */}
      {sidePanelOpen && (
        <aside style={{ width: 340, background: '#ffffff', borderLeft: '1px solid #e2e8f0', display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
          {/* Panel Header */}
          <div style={{ padding: '18px 20px', borderBottom: '1px solid #e2e8f0', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0, color: '#0f172a' }}>Help and Support</h2>
            <button 
              onClick={() => setSidePanelOpen(false)}
              style={{ background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', padding: 4 }}
              title="Close help panel"
            >
              <X size={18} />
            </button>
          </div>

          <div style={{ padding: '18px 20px', flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 20 }}>
            {/* Quick search/describe input */}
            <div>
              <p style={{ margin: '0 0 8px', fontSize: 12, color: '#475569', lineHeight: 1.4 }}>
                Describe the issue to find solutions or open a support request:
              </p>
              <div style={{ position: 'relative' }}>
                <Search size={14} style={{ position: 'absolute', left: 10, top: 10, color: '#94a3b8' }} />
                <input
                  type="text"
                  placeholder="Brief description"
                  value={briefSearch}
                  onChange={e => setBriefSearch(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && briefSearch.trim()) {
                      openNewRequestModal(briefSearch);
                    }
                  }}
                  style={{
                    width: '100%',
                    padding: '8px 10px 8px 30px',
                    fontSize: 13,
                    borderRadius: 6,
                    border: '1px solid #cbd5e1',
                    outline: 'none',
                    background: '#f8fafc',
                  }}
                />
              </div>

              {briefSearch.trim() && (
                <button
                  onClick={() => openNewRequestModal(briefSearch)}
                  style={{
                    marginTop: 8,
                    width: '100%',
                    padding: '7px 12px',
                    borderRadius: 6,
                    background: '#0f6cbd',
                    color: '#ffffff',
                    border: 'none',
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  Open request for "{briefSearch.slice(0, 25)}..."
                </button>
              )}
            </div>

            {/* Service Health Incident banner card */}
            <div style={{ padding: 14, background: '#fffbeb', border: '1px solid #fef3c7', borderRadius: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#b45309', fontWeight: 600, fontSize: 13, marginBottom: 6 }}>
                <AlertTriangle size={16} />
                Service health status
              </div>
              <div style={{ fontSize: 11, color: '#78350f', display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <span>Last updated: Oct 2026</span>
                <b style={{ color: '#15803d' }}>Operational</b>
              </div>
              <p style={{ margin: 0, fontSize: 12, color: '#92400e', lineHeight: 1.4 }}>
                All VTAB reporting studio services, scheduled refreshes, and PDF generation workers are operational.
              </p>
            </div>

            {/* Service health and known issues links */}
            <div>
              <b style={{ fontSize: 13, color: '#0f172a', display: 'block', marginBottom: 8 }}>
                Service health and known issues
              </b>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13 }}>
                <a href="#status" onClick={e => { e.preventDefault(); alert("System Status: All services running normally on http://127.0.0.1:8830"); }} style={{ color: '#0f6cbd', textDecoration: 'none' }}>
                  Check service status
                </a>
                <a href="http://admin-reporting.139.59.32.39.nip.io/" target="_blank" rel="noreferrer" style={{ color: '#0f6cbd', textDecoration: 'none' }}>
                  View our current known issues
                </a>
              </div>
            </div>

            {/* Other resources list */}
            <div>
              <b style={{ fontSize: 13, color: '#0f172a', display: 'block', marginBottom: 8 }}>
                Other Resources
              </b>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 12 }}>
                <a href="mailto:harishkadhi18022001@gmail.com?subject=VTAB Feature Idea" style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#0f6cbd', textDecoration: 'none' }}>
                  <Lightbulb size={14} color="#0f6cbd" />
                  Submit an idea
                  <ExternalLink size={11} style={{ marginLeft: 'auto', opacity: 0.6 }} />
                </a>
                <a href="http://admin-reporting.139.59.32.39.nip.io/" target="_blank" rel="noreferrer" style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#0f6cbd', textDecoration: 'none' }}>
                  <MessageSquare size={14} color="#0f6cbd" />
                  Admin portal & settings
                  <ExternalLink size={11} style={{ marginLeft: 'auto', opacity: 0.6 }} />
                </a>
                <a href="mailto:harishkadhi18022001@gmail.com?subject=VTAB Support Assistance" style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#0f6cbd', textDecoration: 'none' }}>
                  <LifeBuoy size={14} color="#0f6cbd" />
                  Support Center
                  <ExternalLink size={11} style={{ marginLeft: 'auto', opacity: 0.6 }} />
                </a>
                <a href="#admin" onClick={e => { e.preventDefault(); alert(`Admin Email: ${adminEmail}\nBrevo Email Delivery: Active`); }} style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#0f6cbd', textDecoration: 'none' }}>
                  <ShieldAlert size={14} color="#0f6cbd" />
                  Administrator contact info
                </a>
              </div>
            </div>
          </div>

          <div style={{ padding: '12px 20px', borderTop: '1px solid #e2e8f0', fontSize: 11, color: '#94a3b8', display: 'flex', justifyContent: 'space-between' }}>
            <span>VTAB Services 5.2.6</span>
            <span>Support routing active</span>
          </div>
        </aside>
      )}

      {/* NEW SUPPORT REQUEST MODAL */}
      {modalOpen && (
        <div 
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
          onMouseDown={() => setModalOpen(false)}
        >
          <div 
            style={{ width: 540, maxWidth: '92vw', background: '#ffffff', borderRadius: 10, boxShadow: '0 20px 40px rgba(0,0,0,0.2)', overflow: 'hidden' }}
            onMouseDown={e => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div style={{ padding: '18px 24px', borderBottom: '1px solid #e2e8f0', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#f8fafc' }}>
              <div>
                <b style={{ fontSize: 16, color: '#0f172a', display: 'block' }}>New support request</b>
                <span style={{ fontSize: 12, color: '#64748b' }}>Briefly describe the problem to send a ticket to the administrator.</span>
              </div>
              <button onClick={() => setModalOpen(false)} style={{ background: 'none', border: 'none', color: '#64748b', cursor: 'pointer' }}>
                <X size={18} />
              </button>
            </div>

            {/* Modal Form */}
            <form onSubmit={submitRequest} style={{ padding: '20px 24px' }}>
              {errorMsg && (
                <div style={{ padding: '8px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, color: '#991b1b', fontSize: 12, marginBottom: 16 }}>
                  {errorMsg}
                </div>
              )}

              {/* Recipient admin notification badge */}
              <div style={{ padding: '8px 12px', background: '#f0f7fc', border: '1px solid #cce4f7', borderRadius: 6, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#0f6cbd' }}>
                <Mail size={15} />
                <span>Default recipient: <b>{adminEmail}</b></span>
              </div>

              {/* Title */}
              <div style={{ marginBottom: 14 }}>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#334155', marginBottom: 4 }}>
                  Brief description / Issue title *
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g., Subscription PDF not showing charts properly"
                  value={newTitle}
                  onChange={e => setNewTitle(e.target.value)}
                  style={{ width: '100%', padding: '8px 10px', fontSize: 13, borderRadius: 6, border: '1px solid #cbd5e1', outline: 'none' }}
                />
              </div>

              {/* Service & Severity */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#334155', marginBottom: 4 }}>
                    Service
                  </label>
                  <select
                    value={newService}
                    onChange={e => setNewService(e.target.value)}
                    style={{ width: '100%', padding: '8px 10px', fontSize: 13, borderRadius: 6, border: '1px solid #cbd5e1', outline: 'none', background: '#fff' }}
                  >
                    <option>Reporting Services</option>
                    <option>Data Refresh / Bridge</option>
                    <option>Semantic Models</option>
                    <option>Workspaces & Access</option>
                    <option>PDF / Export</option>
                    <option>General</option>
                  </select>
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#334155', marginBottom: 4 }}>
                    Severity
                  </label>
                  <select
                    value={newSeverity}
                    onChange={e => setNewSeverity(e.target.value)}
                    style={{ width: '100%', padding: '8px 10px', fontSize: 13, borderRadius: 6, border: '1px solid #cbd5e1', outline: 'none', background: '#fff' }}
                  >
                    <option>Low</option>
                    <option>Medium</option>
                    <option>High</option>
                    <option>Critical</option>
                  </select>
                </div>
              </div>

              {/* Description */}
              <div style={{ marginBottom: 14 }}>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#334155', marginBottom: 4 }}>
                  Detailed problem description *
                </label>
                <textarea
                  rows={4}
                  required
                  placeholder="Describe what occurred, any error text you received, and the workspace or report affected..."
                  value={newDesc}
                  onChange={e => setNewDesc(e.target.value)}
                  style={{ width: '100%', padding: '8px 10px', fontSize: 13, borderRadius: 6, border: '1px solid #cbd5e1', outline: 'none', resize: 'vertical' }}
                />
              </div>

              {/* Workspace info */}
              <div style={{ fontSize: 12, color: '#64748b', marginBottom: 20 }}>
                <span>Workspace: <b>{activeWorkspaceName || 'Default Workspace'}</b></span>
                {userEmail && <span style={{ marginLeft: 16 }}>From: <b>{userEmail}</b></span>}
              </div>

              {/* Buttons */}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  style={{
                    padding: '8px 16px',
                    borderRadius: 6,
                    border: '1px solid #cbd5e1',
                    background: '#ffffff',
                    color: '#475569',
                    fontSize: 13,
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>

                <button
                  type="submit"
                  disabled={submitting}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '8px 18px',
                    borderRadius: 6,
                    border: 'none',
                    background: '#0f6cbd',
                    color: '#ffffff',
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: submitting ? 'not-allowed' : 'pointer',
                    opacity: submitting ? 0.7 : 1,
                  }}
                >
                  {submitting ? 'Sending to admin…' : 'Submit request'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* REQUEST DETAIL MODAL */}
      {selectedRequest && (
        <div 
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
          onMouseDown={() => setSelectedRequest(null)}
        >
          <div 
            style={{ width: 520, maxWidth: '92vw', background: '#ffffff', borderRadius: 10, boxShadow: '0 20px 40px rgba(0,0,0,0.2)', overflow: 'hidden' }}
            onMouseDown={e => e.stopPropagation()}
          >
            <div style={{ padding: '16px 20px', borderBottom: '1px solid #e2e8f0', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#f8fafc' }}>
              <div>
                <b style={{ fontSize: 15, color: '#0f172a' }}>{selectedRequest.request_number}</b>
                <span style={{ marginLeft: 8, fontSize: 11, padding: '2px 8px', borderRadius: 10, background: selectedRequest.status.toLowerCase() === 'open' ? '#dcfce7' : '#f1f5f9', color: selectedRequest.status.toLowerCase() === 'open' ? '#15803d' : '#475569', fontWeight: 600 }}>
                  {selectedRequest.status}
                </span>
              </div>
              <button onClick={() => setSelectedRequest(null)} style={{ background: 'none', border: 'none', color: '#64748b', cursor: 'pointer' }}>
                <X size={18} />
              </button>
            </div>
            <div style={{ padding: '20px' }}>
              <h3 style={{ fontSize: 17, fontWeight: 700, margin: '0 0 12px', color: '#0f172a' }}>
                {selectedRequest.issue_title}
              </h3>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, fontSize: 12, color: '#64748b', marginBottom: 16 }}>
                <div><b>Service:</b> {selectedRequest.service}</div>
                <div><b>Severity:</b> {selectedRequest.severity}</div>
                <div><b>Submitted By:</b> {selectedRequest.owner_email}</div>
                <div><b>Workspace:</b> {selectedRequest.workspace_name || 'N/A'}</div>
                <div><b>Created At:</b> {new Date(selectedRequest.created_at).toLocaleString()}</div>
              </div>
              <div style={{ background: '#f8fafc', padding: 14, borderRadius: 6, border: '1px solid #e2e8f0' }}>
                <b style={{ fontSize: 12, color: '#334155', display: 'block', marginBottom: 6 }}>Problem description:</b>
                <p style={{ margin: 0, fontSize: 13, color: '#1e293b', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
                  {selectedRequest.description}
                </p>
              </div>
            </div>
            <div style={{ padding: '12px 20px', borderTop: '1px solid #e2e8f0', display: 'flex', justifyContent: 'flex-end', background: '#fafafa' }}>
              <button onClick={() => setSelectedRequest(null)} style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid #cbd5e1', background: '#fff', fontSize: 13, cursor: 'pointer' }}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
