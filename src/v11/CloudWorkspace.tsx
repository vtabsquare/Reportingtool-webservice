import { useEffect, useState, useRef, useMemo } from "react";
import { supabase } from "../supabase";
import { api, apiForm } from "../api";
import PublishedViewer from "./PublishedViewer";
import ShareDialog from "./ShareDialog";
import RefreshCenterDialog from "./RefreshCenterDialog";
import ReportServiceSettings from "./ReportServiceSettings";
import SemanticModelService from "./SemanticModelService";
import NotificationCenter from "./NotificationCenter";
import NotificationSettingsDialog from "./NotificationSettingsDialog";
import HelpSupportView from "./HelpSupportView";
import { 
  Home, Plus, Compass, Layers, User, Search, Settings, HelpCircle, 
  X, ChevronDown, Star, Share2, RefreshCw, Trash2, 
  MoreHorizontal, BarChart2, Database, FileText, Check, Folder, Users, 
  SlidersHorizontal, LogOut, Filter, ArrowLeft, Grid,
  Shield, ExternalLink
} from 'lucide-react';

type Report = { id: string; itemKey?: string; itemType?: string; paginatedId?: string; name: string; published_at: string; updated_at?: string; pages?: number | null; role: string; sourceType?: string; project?: any; workspace_id?: string; workspace_name?: string; workspace_is_personal?: boolean };
type Workspace = { id: string; name: string; created_at: string; role: string; member_count: number; report_count: number; is_personal?: boolean };
type WorkspaceDetail = Workspace & { members: any[]; reports: any[] };

const workspaceTarget = () => {
  const p = new URLSearchParams(location.search);
  return { reportId: p.get('report') || p.get('viewer') || '', share: p.get('share') === '1' };
};

const parseProjectJson = (value: any): any => {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return {};
  try { return JSON.parse(value); } catch { return {}; }
};

const isPersonalWorkspace = (workspace?: { name?: string; is_personal?: boolean } | null) =>
  !!workspace && (workspace.is_personal === true || workspace.name?.trim().toLowerCase() === 'my workspace');

const isPersonalReport = (report?: Report | null) =>
  !!report && (report.workspace_is_personal === true || report.workspace_name?.trim().toLowerCase() === 'my workspace');

const relativeTime = (d: string) => {
  if (!d) return '—';
  const diff = Date.now() - new Date(d).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? 'a month ago' : `${months} months ago`;
};

const roleBadgeStyle = (role: string): React.CSSProperties => {
  const map: Record<string, { bg: string; color: string }> = {
    Owner: { bg: '#ede9fe', color: '#6d28d9' },
    'Co-Owner': { bg: '#ede9fe', color: '#6d28d9' },
    Admin: { bg: '#dbeafe', color: '#1d4ed8' },
    Member: { bg: '#dcfce7', color: '#15803d' },
    Contributor: { bg: '#fef3c7', color: '#b45309' },
    Viewer: { bg: '#f1f5f9', color: '#475569' },
  };
  const s = map[role] || map.Viewer;
  return { fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 4, background: s.bg, color: s.color, whiteSpace: 'nowrap' };
};

// VTAB Signature Emblem
const PowerBiLogo = () => (
  <div style={{ width: 24, height: 24, borderRadius: 6, background: "linear-gradient(135deg, #6366f1, #8b5cf6)", display: "grid", placeItems: "center", fontWeight: 800, color: "#fff", fontSize: 13, flexShrink: 0, lineHeight: 1 }}>
    V
  </div>
);

export default function CloudWorkspace({ session }: { session: any }) {
  // Navigation & View mode: 'home' | 'workspaces' | 'help_support'
  const [viewMode, setViewMode] = useState<'home' | 'workspaces' | 'help_support'>(() => {
    try {
      const p = new URLSearchParams(window.location.search);
      if (p.get('help') === '1' || p.get('view') === 'help') return 'help_support';
    } catch {}
    return 'home';
  });
  const [workspacesDrawerOpen, setWorkspacesDrawerOpen] = useState(false);
  const [workspaceSearch, setWorkspaceSearch] = useState("");
  const [homeFilter, setHomeFilter] = useState<'recent' | 'favorites' | 'shared' | 'all'>('recent');
  
  // Data states
  const [reports, setReports] = useState<Report[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [targetDenied, setTargetDenied] = useState("");
  const [viewing, setViewing] = useState<Report | null>(null);
  const [sharing, setSharing] = useState<Report | null>(null);
  const [scheduling, setScheduling] = useState<Report | null>(null);
  const [settingsReport, setSettingsReport] = useState<Report | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [search, setSearch] = useState("");

  // Favorites in localStorage
  const [favorites, setFavorites] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('vtab_pbi_favorites') || '[]');
    } catch { return []; }
  });

  const toggleFavorite = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setFavorites(prev => {
      const next = prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id];
      localStorage.setItem('vtab_pbi_favorites', JSON.stringify(next));
      return next;
    });
  };

  // Options Menu (Column Customizer - Image 3)
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [visibleCols, setVisibleCols] = useState({
    type: true,
    opened: true,
    refreshed: true,
    modified: true,
    location: true,
    endorsement: true,
  });

  // Action Menu for rows
  const [menuReportId, setMenuReportId] = useState<string | null>(null);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [notificationSettingsOpen, setNotificationSettingsOpen] = useState(false);

  // Add Member modal state
  const [addMemberOpen, setAddMemberOpen] = useState(false);
  const [memberEmail, setMemberEmail] = useState("");
  const [memberRole, setMemberRole] = useState<"Admin" | "Member" | "Contributor" | "Viewer">("Viewer");
  const [registeredUsers, setRegisteredUsers] = useState<any[]>([]);
  const [memberBusy, setMemberBusy] = useState(false);
  const [memberErr, setMemberErr] = useState("");

  const fetchReports = async () => {
    return await api<any[]>('/cloud/reports');
  };

  const loadData = async () => {
    try {
      setLoading(true); setErr(""); setTargetDenied("");
      const r = await fetchReports();
      setReports(r);
      const res = await api<Workspace[]>('/cloud/workspaces');
      if (res) {
        const ordered = [...res].sort((a, b) => (a.name.toLowerCase() === 'my workspace' ? 0 : 1) - (b.name.toLowerCase() === 'my workspace' ? 0 : 1) || a.name.localeCompare(b.name));
        setWorkspaces(ordered);
        if (!activeWorkspace && ordered[0]) void loadWorkspace(ordered[0].id);
      }
      const target = workspaceTarget();
      if (target.reportId && !r.some((x: any) => x.id === target.reportId)) {
        setTargetDenied("This report is not shared with the signed-in account.");
      }
      void loadRegisteredUsers();
    } catch (e: any) { setErr(e.message || String(e)); } finally { setLoading(false); }
  };

  useEffect(() => { loadData(); }, [session?.user?.id]);

  useEffect(() => {
    if (loading || viewing) return;
    const target = workspaceTarget();
    if (!target.reportId) return;
    const report = reports.find(r => r.id === target.reportId);
    if (report) {
      setTargetDenied(""); setViewing(report);
      const canShare = ['Owner', 'Co-Owner', 'Admin'].includes(report.role) && !isPersonalReport(report);
      if (target.share && canShare) setSharing(report);
      return;
    }
    if (!supabase) return;
    supabase.from('published_reports').select('id, name, published_at, project_json')
      .eq('id', target.reportId).eq('owner_id', session?.user?.id).maybeSingle()
      .then(({ data }) => {
        if (!data) { if (!loading) setTargetDenied('This report is not shared with the signed-in account.'); return; }
        const r: Report = {
          id: data.id, name: data.name, published_at: data.published_at, role: 'Owner',
          pages: parseProjectJson(data.project_json)?.report?.pages?.length || 1,
          project: parseProjectJson(data.project_json)
        };
        setTargetDenied(''); setViewing(r);
        if (target.share) setSharing(r);
      });
  }, [loading, reports, viewing]);

  // Click outside listener for menus
  useEffect(() => {
    const closeAll = () => {
      setMenuReportId(null);
      setOptionsOpen(false);
      setUserMenuOpen(false);
    };
    window.addEventListener('click', closeAll);
    return () => window.removeEventListener('click', closeAll);
  }, []);

  const signOut = async () => { await supabase?.auth.signOut(); location.reload(); };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    const form = new FormData(); form.append('file', file);
    try {
      await apiForm('/cloud/upload-package', form);
      alert('Package uploaded successfully!');
      loadData();
    } catch (err: any) { alert(err.message); } finally { setUploading(false); if (fileInput.current) fileInput.current.value = ''; }
  };

  const createWorkspace = async () => {
    const name = prompt("Enter workspace name:");
    if (!name) return;
    try {
      const data = await api<any>('/cloud/workspaces', { method: 'POST', body: JSON.stringify({ name }) });
      await loadData();
      if (data.id) {
        loadWorkspace(data.id);
        setViewMode('workspaces');
        setWorkspacesDrawerOpen(false);
      }
    } catch (err: any) { alert(err.message || String(err)); }
  };

  const loadWorkspace = async (id: string) => {
    try {
      const data = await api<WorkspaceDetail>(`/cloud/workspaces/${id}`);
      setActiveWorkspace(data);
    } catch (err: any) { alert(err.message || 'Failed to load workspace details'); }
  };

  const deleteWorkspace = async () => {
    if (!activeWorkspace) return;
    if (!confirm(`Are you sure you want to delete workspace "${activeWorkspace.name}"? This action cannot be undone.`)) return;
    try {
      await api(`/cloud/workspaces/${activeWorkspace.id}`, { method: 'DELETE' });
      alert('Workspace deleted successfully!');
      setActiveWorkspace(null); 
      loadData();
      setViewMode('home');
    } catch (err: any) { alert(err.message || String(err)); }
  };

  const submitAddMember = async () => {
    if (!memberEmail.trim() || !activeWorkspace) return;
    setMemberBusy(true); setMemberErr("");
    try {
      await api(`/cloud/workspaces/${activeWorkspace.id}/members`, {
        method: 'POST', body: JSON.stringify({ email: memberEmail.trim(), role: memberRole })
      });
      setAddMemberOpen(false);
      setMemberEmail(""); setMemberRole("Viewer");
      loadWorkspace(activeWorkspace.id); loadData();
    } catch (e: any) { setMemberErr(e.message || String(e)); } finally { setMemberBusy(false); }
  };

  const removeMember = async (targetUserId: string, targetEmail: string) => {
    if (!activeWorkspace) return;
    if (!confirm(`Are you sure you want to remove ${targetEmail} from workspace "${activeWorkspace.name}"? They will no longer receive alerts, emails, or have access to reports in this workspace.`)) return;
    try {
      await api(`/cloud/workspaces/${activeWorkspace.id}/members/${targetUserId}`, { method: 'DELETE' });
      await loadWorkspace(activeWorkspace.id);
      loadData();
    } catch (err: any) {
      alert(err.message || 'Failed to remove member');
    }
  };

  const loadRegisteredUsers = async () => {
    try {
      const users = await api<any[]>('/cloud/users/search?q=');
      if (Array.isArray(users) && users.length) {
        setRegisteredUsers(users);
        return;
      }
    } catch {}

    try {
      const { supabase } = await import('../supabase');
      if (supabase) {
        const { data } = await supabase.from('vtab_users').select('id, email, display_name').order('email');
        if (data && data.length) {
          const mapped = data.map((u: any) => ({
            id: u.id,
            email: u.email,
            display_name: u.display_name || u.email.split('@')[0]
          }));
          setRegisteredUsers(mapped);
        }
      }
    } catch {}
  };

  const addMember = async () => {
    setMemberEmail("");
    setMemberRole("Viewer");
    setMemberErr("");
    setAddMemberOpen(true);
    void loadRegisteredUsers();
  };

  const userEmail = session?.user?.email || '';
  const userDisplay = session?.user?.user_metadata?.display_name || userEmail.split('@')[0];

  // Filtering for Home View
  const filteredHomeReports = useMemo(() => {
    return reports.filter(r => {
      const matchesSearch = !search.trim() || r.name.toLowerCase().includes(search.toLowerCase());
      if (!matchesSearch) return false;
      if (homeFilter === 'favorites') return favorites.includes(r.id);
      if (homeFilter === 'shared') return r.role === 'Viewer' || r.role === 'Contributor';
      return true;
    });
  }, [reports, search, homeFilter, favorites]);

  // Workspaces list filtered for Drawer
  const filteredWorkspaces = useMemo(() => {
    if (!workspaceSearch.trim()) return workspaces;
    return workspaces.filter(w => w.name.toLowerCase().includes(workspaceSearch.toLowerCase()));
  }, [workspaces, workspaceSearch]);

  const myWorkspace = useMemo(() => {
    return workspaces.find(w => w.name.toLowerCase() === 'my workspace') || workspaces[0];
  }, [workspaces]);

  // ─── VIEWER MODE ─────────────────────────────────────────────────────────────
  if (viewing) {
    return (
      <div className="pbi-app-shell">
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <PublishedViewer 
            reportId={viewing.id} 
            userRole={viewing.role} 
            initialItem={{ id: viewing.id, name: viewing.name, published_at: viewing.published_at, updated_at: viewing.updated_at || viewing.published_at, project: viewing.project, role: viewing.role }} 
            embedded 
            cloudMode 
            initialPaginatedId={viewing.paginatedId}
            onBack={() => { setViewing(null); setSharing(null); history.replaceState(null, '', location.pathname + '?workspace=1'); }}
            onManageAccess={(viewing.role === "Co-Owner" || viewing.role === "Owner" || viewing.role === "Admin") && !isPersonalReport(viewing) ? () => setSharing(viewing) : undefined}
          />
        </div>

        {sharing && (
          <ShareDialog 
            reportId={sharing.id} 
            reportName={sharing.name} 
            workspaceIsPersonal={isPersonalReport(sharing)} 
            onClose={() => setSharing(null)} 
            supabaseSession={session} 
          />
        )}
      </div>
    );
  }

  // ─── MAIN POWER BI APP SHELL ──────────────────────────────────────────────────
  return (
    <div className="pbi-app-shell">
      {/* GLOBAL TOPBAR */}
      <header className="pbi-topbar">
        <button className="pbi-waffle-btn" title="App launcher" onClick={() => setViewMode('home')}>
          <Grid size={18} />
        </button>

        <div className="pbi-brand-wrap" onClick={() => setViewMode('home')}>
          <div className="pbi-brand-logo">
            <PowerBiLogo />
          </div>
          <span className="pbi-brand-title">VTAB</span>
        </div>

        <span className="pbi-breadcrumb-separator">/</span>
        <span className="pbi-breadcrumb-crumb">
          {viewMode === 'help_support' ? 'Help + support' : viewMode === 'home' ? 'Home' : activeWorkspace?.name || 'Workspace'}
        </span>

        {/* Search */}
        <div className="pbi-search-wrap">
          <Search size={15} className="pbi-search-icon" />
          <input 
            type="text" 
            className="pbi-search-input" 
            placeholder="Search" 
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>

        {/* Right header actions */}
        <div className="pbi-header-actions">
          <a
            href="http://admin-reporting.139.59.32.39.nip.io/"
            target="_blank"
            rel="noopener noreferrer"
            title="Open Admin Portal in new tab"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: 30,
              padding: '0 12px',
              borderRadius: 4,
              border: '1px solid #cce4f7',
              background: '#f0f7fc',
              color: '#0f6cbd',
              fontSize: 12,
              fontWeight: 600,
              textDecoration: 'none',
              cursor: 'pointer',
              transition: 'all 0.15s ease',
              marginRight: 4,
            }}
            onMouseEnter={e => {
              e.currentTarget.style.background = '#e0f0fb';
              e.currentTarget.style.borderColor = '#99d0f5';
            }}
            onMouseLeave={e => {
              e.currentTarget.style.background = '#f0f7fc';
              e.currentTarget.style.borderColor = '#cce4f7';
            }}
          >
            <Shield size={14} />
            <span>Admin Portal</span>
            <ExternalLink size={12} style={{ opacity: 0.7 }} />
          </a>

          <NotificationCenter userId={session?.user?.id}/>
          <button className="pbi-header-icon-btn" title="Settings" onClick={() => setNotificationSettingsOpen(true)}>
            <Settings size={17} />
          </button>
          <button 
            className={`pbi-header-icon-btn ${viewMode === 'help_support' ? 'active' : ''}`} 
            title="Help + support"
            onClick={() => setViewMode('help_support')}
            style={viewMode === 'help_support' ? { background: '#f0f0f0', borderRadius: 4 } : undefined}
          >
            <HelpCircle size={17} color={viewMode === 'help_support' ? '#0f6cbd' : undefined} />
          </button>

          {/* User profile avatar */}
          <div style={{ position: 'relative' }} onClick={e => e.stopPropagation()}>
            <button className="pbi-avatar-btn" onClick={() => setUserMenuOpen(!userMenuOpen)}>
              {(userDisplay || '?')[0].toUpperCase()}
            </button>

            {userMenuOpen && (
              <div style={{
                position: 'absolute', right: 0, top: 40, width: 260, background: '#fff',
                borderRadius: 8, boxShadow: '0 8px 30px rgba(0,0,0,0.14)', border: '1px solid #e1e1e1',
                padding: 16, zIndex: 200, color: '#242424'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
                  <div className="pbi-avatar-btn" style={{ width: 40, height: 40, fontSize: 16 }}>
                    {(userDisplay || '?')[0].toUpperCase()}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <b style={{ display: 'block', fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{userDisplay}</b>
                    <small style={{ color: '#616161', fontSize: 11, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{userEmail}</small>
                  </div>
                </div>
                <div style={{ height: 1, background: '#edebe9', margin: '8px 0 10px' }} />
                <a
                  href="http://admin-reporting.139.59.32.39.nip.io/"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '8px 10px', border: '1px solid #cce4f7', background: '#f0f7fc',
                    color: '#0f6cbd', borderRadius: 6, fontSize: 13, fontWeight: 600,
                    textDecoration: 'none', marginBottom: 8, cursor: 'pointer', boxSizing: 'border-box'
                  }}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Shield size={15} /> Admin Portal
                  </span>
                  <ExternalLink size={13} />
                </a>
                <button 
                  onClick={signOut}
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px',
                    border: '1px solid #fecaca', background: '#fff5f5', color: '#dc2626',
                    borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer'
                  }}
                >
                  <LogOut size={15} /> Sign out
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* BODY (RAIL + DRAWER + CANVAS) */}
      <div className="pbi-body-container">
        {/* LEFT ICON RAIL (Matching Power BI Reference Screenshots 1, 2, 4, 5) */}
        <nav className="pbi-rail">
          <button 
            className={`pbi-rail-item ${viewMode === 'home' && !workspacesDrawerOpen ? 'active' : ''}`}
            title="Home"
            onClick={() => { setViewMode('home'); setWorkspacesDrawerOpen(false); }}
          >
            <Home size={18} />
            <span className="pbi-rail-label">Home</span>
          </button>

          <button 
            className="pbi-rail-item" 
            title="Create / Import package"
            onClick={() => fileInput.current?.click()}
          >
            <Plus size={18} />
            <span className="pbi-rail-label">Create</span>
          </button>

          <button 
            className={`pbi-rail-item ${workspacesDrawerOpen ? 'active' : ''}`} 
            title="Workspaces"
            onClick={() => setWorkspacesDrawerOpen(!workspacesDrawerOpen)}
          >
            <Layers size={18} />
            <span className="pbi-rail-label">Workspaces</span>
          </button>

          <div className="pbi-rail-divider" />

          {/* Direct link to My workspace (Personal workspace) */}
          {myWorkspace && (
            <button 
              className={`pbi-rail-item ${!workspacesDrawerOpen && viewMode === 'workspaces' && activeWorkspace?.id === myWorkspace.id ? 'active' : ''}`}
              title="My workspace"
              onClick={() => {
                loadWorkspace(myWorkspace.id);
                setViewMode('workspaces');
                setWorkspacesDrawerOpen(false);
              }}
            >
              <User size={18} />
              <span className="pbi-rail-label">My workspace</span>
            </button>
          )}

          {/* Currently open team workspace pinned to left rail (Matching Reference Image 1 "BRNZ Layer" & Image 5 "Enhanced Reports") */}
          {activeWorkspace && activeWorkspace.id !== myWorkspace?.id && (
            <button 
              className={`pbi-rail-item ${!workspacesDrawerOpen && viewMode === 'workspaces' && activeWorkspace.id !== myWorkspace?.id ? 'active' : ''}`}
              title={activeWorkspace.name}
              onClick={() => {
                setViewMode('workspaces');
                setWorkspacesDrawerOpen(false);
              }}
            >
              <Users size={18} />
              <span className="pbi-rail-label">{activeWorkspace.name}</span>
            </button>
          )}

          <div style={{ marginTop: 'auto', paddingBottom: 6, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
            <a
              href="http://admin-reporting.139.59.32.39.nip.io/"
              target="_blank"
              rel="noopener noreferrer"
              className="pbi-rail-item"
              title="Admin Portal (opens in new tab)"
              style={{ textDecoration: 'none', height: 42, width: 44, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}
            >
              <Shield size={18} color="#0f6cbd" />
              <span className="pbi-rail-label" style={{ fontSize: 9, color: '#0f6cbd', fontWeight: 600 }}>Admin</span>
            </a>
            <PowerBiLogo />
            <span className="pbi-rail-label" style={{ fontSize: 9, color: '#616161' }}>VTAB</span>
          </div>
        </nav>

        {/* WORKSPACES FLYOUT DRAWER (Image 4) */}
        {workspacesDrawerOpen && (
          <>
            <div className="pbi-drawer-backdrop" onClick={() => setWorkspacesDrawerOpen(false)} />
            <aside className="pbi-workspaces-drawer" onClick={e => e.stopPropagation()}>
              <div className="pbi-drawer-header">
                <h3 className="pbi-drawer-title">Workspaces</h3>
                <button 
                  onClick={() => setWorkspacesDrawerOpen(false)} 
                  style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: '#616161', padding: 4 }}
                >
                  <X size={18} />
                </button>
              </div>

              <div className="pbi-drawer-search-wrap">
                <div style={{ position: 'relative' }}>
                  <Search size={14} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: '#616161' }} />
                  <input 
                    type="text" 
                    className="pbi-drawer-search-input" 
                    placeholder="Search"
                    value={workspaceSearch}
                    onChange={e => setWorkspaceSearch(e.target.value)}
                  />
                </div>
              </div>

              <div className="pbi-drawer-body">
                {/* My workspace section */}
                {myWorkspace && (
                  <div style={{ marginBottom: 16 }}>
                    <div className="pbi-drawer-section-label">Admin monitoring</div>
                    <button 
                      className={`pbi-workspace-card ${activeWorkspace?.id === myWorkspace.id && viewMode === 'workspaces' ? 'active' : ''}`}
                      onClick={() => {
                        loadWorkspace(myWorkspace.id);
                        setViewMode('workspaces');
                        setWorkspacesDrawerOpen(false);
                      }}
                    >
                      <div className="pbi-workspace-icon-box" style={{ background: '#ecfdf5', color: '#047857' }}>
                        <User size={17} />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: '#242424' }}>My workspace</div>
                        <small style={{ color: '#616161', fontSize: 11 }}>Personal workspace</small>
                      </div>
                      <span style={{ fontSize: 10, background: '#fef3c7', color: '#b45309', padding: '2px 6px', borderRadius: 99, fontWeight: 700 }}>PRO</span>
                    </button>
                  </div>
                )}

                {/* All workspaces section */}
                <div>
                  <div className="pbi-drawer-section-label">All</div>
                  {filteredWorkspaces.filter(w => w.id !== myWorkspace?.id).map(w => (
                    <button 
                      key={w.id}
                      className={`pbi-workspace-card ${activeWorkspace?.id === w.id && viewMode === 'workspaces' ? 'active' : ''}`}
                      onClick={() => {
                        loadWorkspace(w.id);
                        setViewMode('workspaces');
                        setWorkspacesDrawerOpen(false);
                      }}
                    >
                      <div className="pbi-workspace-icon-box">
                        <Users size={16} />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: '#242424', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {w.name}
                        </div>
                        <small style={{ color: '#616161', fontSize: 11 }}>
                          {w.report_count} report{w.report_count !== 1 ? 's' : ''} · {w.role}
                        </small>
                      </div>
                    </button>
                  ))}
                  {filteredWorkspaces.length === 0 && (
                    <div style={{ padding: '16px 12px', fontSize: 12, color: '#797775', textAlign: 'center' }}>
                      No workspaces found
                    </div>
                  )}
                </div>
              </div>

              {/* Drawer Footer with + New workspace button */}
              <div className="pbi-drawer-footer">
                <button className="pbi-btn-new-workspace" onClick={createWorkspace}>
                  <Plus size={16} /> New workspace
                </button>
              </div>
            </aside>
          </>
        )}

        {/* MAIN CANVAS */}
        <main className="pbi-canvas">
          {loading && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: 320, gap: 12 }}>
              <div style={{ width: 32, height: 32, border: '3px solid #e1e1e1', borderTopColor: '#0d6257', borderRadius: '50%', animation: 'pbiSpin 0.7s linear infinite' }} />
              <span style={{ color: '#616161', fontSize: 13 }}>Loading VTAB…</span>
            </div>
          )}

          {err && (
            <div style={{ margin: 20, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, padding: '12px 16px', color: '#dc2626', fontSize: 13 }}>
              ⚠️ {err}
            </div>
          )}
          {targetDenied && (
            <div style={{ margin: 20, background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 6, padding: '12px 16px', color: '#b45309', fontSize: 13 }}>
              ⚠️ {targetDenied}
            </div>
          )}

          {/* ══════════════════════════════════════════════════════════════
              HOME VIEW (Matching Image 2 & Image 3)
             ══════════════════════════════════════════════════════════════ */}
          {!loading && viewMode === 'home' && (
            <div>
              {/* Quick access cards carousel (Reports + Workspaces matching Image 2) */}
              {(reports.length > 0 || workspaces.length > 0) && (
                <div className="pbi-cards-carousel">
                  {reports.slice(0, 5).map(r => (
                    <div key={`card-r-${r.id}`} className="pbi-quick-card">
                      <div className="pbi-quick-card-thumb">
                        <BarChart2 size={34} />
                      </div>
                      <div className="pbi-quick-card-info">
                        <div className="pbi-quick-card-title" title={r.name}>{r.name}</div>
                        <div className="pbi-quick-card-meta">Report · {relativeTime(r.published_at)}</div>
                      </div>
                      <div className="pbi-quick-card-footer">
                        <button 
                          className="pbi-btn-card-open"
                          onClick={() => {
                            history.replaceState(null, '', `${location.pathname}?workspace=1&report=${encodeURIComponent(r.id)}`);
                            setViewing(r);
                          }}
                        >
                          Open
                        </button>
                      </div>
                    </div>
                  ))}
                  {workspaces.slice(0, 4).map(w => (
                    <div key={`card-w-${w.id}`} className="pbi-quick-card">
                      <div className="pbi-quick-card-thumb" style={{ background: 'linear-gradient(135deg, #f0fdf4, #dcfce7)', color: '#0d6257' }}>
                        {isPersonalWorkspace(w) ? <User size={34} /> : <Users size={34} />}
                      </div>
                      <div className="pbi-quick-card-info">
                        <div className="pbi-quick-card-title" title={w.name}>{w.name}</div>
                        <div className="pbi-quick-card-meta">Workspace · {w.report_count} item{w.report_count !== 1 ? 's' : ''}</div>
                      </div>
                      <div className="pbi-quick-card-footer">
                        <button 
                          className="pbi-btn-card-open"
                          onClick={() => {
                            loadWorkspace(w.id);
                            setViewMode('workspaces');
                          }}
                        >
                          Open
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Filter Pills row (Image 2) */}
              <div className="pbi-pills-row">
                <button 
                  className={`pbi-pill ${homeFilter === 'recent' ? 'active' : ''}`}
                  onClick={() => setHomeFilter('recent')}
                >
                  Recent
                </button>
                <button 
                  className={`pbi-pill ${homeFilter === 'favorites' ? 'active' : ''}`}
                  onClick={() => setHomeFilter('favorites')}
                >
                  Favorites
                </button>
                <button 
                  className={`pbi-pill ${homeFilter === 'shared' ? 'active' : ''}`}
                  onClick={() => setHomeFilter('shared')}
                >
                  Shared with me
                </button>
                <button 
                  className={`pbi-pill ${homeFilter === 'all' ? 'active' : ''}`}
                  onClick={() => setHomeFilter('all')}
                >
                  All
                </button>
              </div>

              {/* Table Toolbar (Filter & Options column picker) */}
              <div className="pbi-table-toolbar">
                <div className="pbi-table-search">
                  <Search size={14} />
                  <input 
                    type="text" 
                    placeholder="Filter by keyword"
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                  />
                </div>

                <div style={{ flex: 1 }} />

                <button className="pbi-btn-tool" onClick={() => fileInput.current?.click()} disabled={uploading}>
                  <Plus size={15} /> {uploading ? 'Uploading…' : 'Import package'}
                </button>

                {/* Options dropdown button (Image 3) */}
                <div style={{ position: 'relative' }} onClick={e => e.stopPropagation()}>
                  <button className="pbi-btn-tool" onClick={() => setOptionsOpen(!optionsOpen)}>
                    <SlidersHorizontal size={14} /> Options <ChevronDown size={14} />
                  </button>

                  {optionsOpen && (
                    <div style={{
                      position: 'absolute', right: 0, top: 38, width: 230, background: '#fff',
                      borderRadius: 6, boxShadow: '0 8px 24px rgba(0,0,0,0.12)', border: '1px solid #e1e1e1',
                      padding: '12px 14px', zIndex: 120, fontSize: 13
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, borderBottom: '1px solid #edebe9', paddingBottom: 8 }}>
                        <span style={{ fontWeight: 600, color: '#242424' }}>Columns</span>
                        <button 
                          onClick={() => setVisibleCols({ type: true, opened: true, refreshed: true, modified: true, location: true, endorsement: true })}
                          style={{ border: 'none', background: 'transparent', color: '#0d6257', fontSize: 11, cursor: 'pointer', fontWeight: 600 }}
                        >
                          Reset to default
                        </button>
                      </div>

                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', color: '#616161' }}>
                          <input type="checkbox" checked disabled /> Name
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                          <input type="checkbox" checked={visibleCols.type} onChange={e => setVisibleCols({ ...visibleCols, type: e.target.checked })} /> Type
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                          <input type="checkbox" checked={visibleCols.opened} onChange={e => setVisibleCols({ ...visibleCols, opened: e.target.checked })} /> Opened
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                          <input type="checkbox" checked={visibleCols.refreshed} onChange={e => setVisibleCols({ ...visibleCols, refreshed: e.target.checked })} /> Data refreshed
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                          <input type="checkbox" checked={visibleCols.location} onChange={e => setVisibleCols({ ...visibleCols, location: e.target.checked })} /> Location
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                          <input type="checkbox" checked={visibleCols.endorsement} onChange={e => setVisibleCols({ ...visibleCols, endorsement: e.target.checked })} /> Access
                        </label>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Modern Power BI Table (Reports + Workspaces matching Image 2) */}
              <div className="pbi-table-container">
                <table className="pbi-table">
                  <thead>
                    <tr>
                      <th style={{ width: 34, paddingLeft: 24 }}><input type="checkbox" style={{ cursor: 'pointer' }} /></th>
                      <th>Name</th>
                      {visibleCols.type && <th>Type</th>}
                      {visibleCols.opened && <th>Opened</th>}
                      {visibleCols.refreshed && <th>Data refreshed</th>}
                      {visibleCols.location && <th>Location</th>}
                      {visibleCols.endorsement && <th>Access</th>}
                      <th style={{ width: 44, textAlign: 'center' }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredHomeReports.map(r => {
                      const isFav = favorites.includes(r.id);
                      const isMenuOpen = menuReportId === r.id;
                      const canManage = ['Owner', 'Co-Owner', 'Admin'].includes(r.role);

                      return (
                        <tr 
                          key={`row-r-${r.id}`} 
                          style={{ cursor: 'pointer' }}
                          onClick={() => {
                            history.replaceState(null, '', `${location.pathname}?workspace=1&report=${encodeURIComponent(r.id)}`);
                            setViewing(r);
                          }}
                        >
                          <td style={{ paddingLeft: 24 }} onClick={e => e.stopPropagation()}>
                            <input type="checkbox" style={{ cursor: 'pointer' }} />
                          </td>

                          {/* Name + Icon */}
                          <td>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                              <div className="pbi-item-icon-report">
                                <BarChart2 size={16} />
                              </div>
                              <b style={{ color: '#242424', fontWeight: 600 }}>{r.name}</b>
                              <button 
                                onClick={e => toggleFavorite(r.id, e)}
                                title={isFav ? "Remove from favorites" : "Add to favorites"}
                                style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: isFav ? '#d97706' : '#c8c6c4', padding: 2, display: 'grid', placeItems: 'center' }}
                              >
                                <Star size={14} fill={isFav ? '#d97706' : 'none'} />
                              </button>
                            </div>
                          </td>

                          {visibleCols.type && (
                            <td style={{ color: '#616161' }}>
                              {r.itemType || 'Report'}
                            </td>
                          )}

                          {visibleCols.opened && (
                            <td style={{ color: '#616161' }}>{relativeTime(r.published_at)}</td>
                          )}

                          {visibleCols.refreshed && (
                            <td style={{ color: '#616161' }}>{r.updated_at ? new Date(r.updated_at).toLocaleString() : '—'}</td>
                          )}

                          {visibleCols.location && (
                            <td style={{ color: '#616161' }}>
                              {r.workspace_name || 'My workspace'}
                            </td>
                          )}

                          {visibleCols.endorsement && (
                            <td>
                              <span style={roleBadgeStyle(r.role)}>{r.role}</span>
                            </td>
                          )}

                          {/* 3-dots actions menu */}
                          <td style={{ position: 'relative' }} onClick={e => e.stopPropagation()}>
                            <button 
                              onClick={() => setMenuReportId(isMenuOpen ? null : r.id)}
                              style={{ width: 28, height: 28, borderRadius: 4, border: 'none', background: isMenuOpen ? '#edebe9' : 'transparent', cursor: 'pointer', display: 'grid', placeItems: 'center', color: '#616161' }}
                            >
                              <MoreHorizontal size={16} />
                            </button>

                            {isMenuOpen && (
                              <div style={{
                                position: 'absolute', right: 12, top: 32, width: 210, background: '#fff',
                                borderRadius: 6, boxShadow: '0 8px 24px rgba(0,0,0,0.12)', border: '1px solid #e1e1e1',
                                padding: '6px 4px', zIndex: 110, fontSize: 13, textAlign: 'left'
                              }}>
                                <button 
                                  onClick={() => {
                                    setMenuReportId(null);
                                    history.replaceState(null, '', `${location.pathname}?workspace=1&report=${encodeURIComponent(r.id)}`);
                                    setViewing(r);
                                  }}
                                  style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', border: 'none', background: 'transparent', textAlign: 'left', cursor: 'pointer', borderRadius: 4, color: '#242424' }}
                                >
                                  <BarChart2 size={15} color="#d97706" /> Open report
                                </button>

                                {canManage && !isPersonalReport(r) && (
                                  <button 
                                    onClick={() => { setMenuReportId(null); setSharing(r); }}
                                    style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', border: 'none', background: 'transparent', textAlign: 'left', cursor: 'pointer', borderRadius: 4, color: '#242424' }}
                                  >
                                    <Share2 size={15} color="#0f6cbd" /> Manage permissions
                                  </button>
                                )}

                                <button 
                                  onClick={() => { setMenuReportId(null); setScheduling(r); }}
                                  style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', border: 'none', background: 'transparent', textAlign: 'left', cursor: 'pointer', borderRadius: 4, color: '#242424' }}
                                >
                                  <RefreshCw size={15} color="#0d6257" /> Refresh now
                                </button>

                                <button 
                                  onClick={() => { setMenuReportId(null); setSettingsReport(r); }}
                                  style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', border: 'none', background: 'transparent', textAlign: 'left', cursor: 'pointer', borderRadius: 4, color: '#242424' }}
                                >
                                  <Settings size={15} color="#616161" /> Settings
                                </button>

                                {canManage && (
                                  <>
                                    <div style={{ height: 1, background: '#edebe9', margin: '4px 0' }} />
                                    <button 
                                      onClick={async () => {
                                        setMenuReportId(null);
                                        if (!confirm(`Delete report "${r.name}"? This cannot be undone.`)) return;
                                        try {
                                          await api(`/cloud/reports/${r.id}`, { method: 'DELETE' });
                                          loadData();
                                        } catch (e: any) { alert(e.message || String(e)); }
                                      }}
                                      style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', border: 'none', background: 'transparent', textAlign: 'left', cursor: 'pointer', borderRadius: 4, color: '#dc2626' }}
                                    >
                                      <Trash2 size={15} color="#dc2626" /> Delete
                                    </button>
                                  </>
                                )}
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}

                    {/* Workspaces rows in Home Table (Matching Reference Image 2) */}
                    {homeFilter !== 'favorites' && homeFilter !== 'shared' && workspaces
                      .filter(w => !search.trim() || w.name.toLowerCase().includes(search.toLowerCase()))
                      .map(w => (
                        <tr
                          key={`row-w-${w.id}`}
                          style={{ cursor: 'pointer' }}
                          onClick={() => {
                            loadWorkspace(w.id);
                            setViewMode('workspaces');
                          }}
                        >
                          <td style={{ paddingLeft: 24 }} onClick={e => e.stopPropagation()}>
                            <input type="checkbox" style={{ cursor: 'pointer' }} />
                          </td>
                          <td>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                              <div className="pbi-workspace-icon-box" style={{ width: 26, height: 26, borderRadius: 4 }}>
                                {isPersonalWorkspace(w) ? <User size={15} /> : <Users size={15} />}
                              </div>
                              <b style={{ color: '#242424', fontWeight: 600 }}>{w.name}</b>
                            </div>
                          </td>
                          {visibleCols.type && <td style={{ color: '#616161' }}>Workspace</td>}
                          {visibleCols.opened && <td style={{ color: '#616161' }}>{w.created_at ? relativeTime(w.created_at) : 'Recently'}</td>}
                          {visibleCols.refreshed && <td style={{ color: '#a19f9d' }}>—</td>}
                          {visibleCols.location && <td style={{ color: '#616161' }}>Workspaces</td>}
                          {visibleCols.endorsement && (
                            <td>
                              <span style={roleBadgeStyle(w.role)}>{w.role}</span>
                            </td>
                          )}
                          <td></td>
                        </tr>
                      ))}

                    {filteredHomeReports.length === 0 && workspaces.length === 0 && (
                      <tr>
                        <td colSpan={8} style={{ padding: '48px 24px', textAlign: 'center', color: '#616161' }}>
                          <div style={{ fontSize: 32, marginBottom: 8 }}>📊</div>
                          <b style={{ display: 'block', fontSize: 15, color: '#242424', marginBottom: 4 }}>No items found</b>
                          <small>Publish reports from Desktop or upload a package to see them here.</small>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ══════════════════════════════════════════════════════════════
              WORKSPACE DETAIL VIEW (Matching Image 1 & Image 5)
             ══════════════════════════════════════════════════════════════ */}
          {!loading && viewMode === 'workspaces' && activeWorkspace && (
            <div>
              {/* Workspace Top Title Bar (Matching Reference Image 1 "BRNZ Layer") */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 28px 12px', background: '#ffffff', borderBottom: '1px solid #edebe9', flexWrap: 'wrap', gap: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ width: 38, height: 38, borderRadius: 8, background: '#e4f2ef', color: '#0d6257', display: 'grid', placeItems: 'center' }}>
                    {isPersonalWorkspace(activeWorkspace) ? <User size={20} /> : <Users size={20} />}
                  </div>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <h2 style={{ margin: 0, fontSize: 19, fontWeight: 600, color: '#242424' }}>
                        {activeWorkspace.name}
                      </h2>
                      <span style={roleBadgeStyle(activeWorkspace.role)}>{activeWorkspace.role}</span>
                    </div>
                    <small style={{ color: '#616161', fontSize: 12 }}>
                      {isPersonalWorkspace(activeWorkspace) ? 'Personal workspace · Private to your account' : `${activeWorkspace.member_count ?? activeWorkspace.members?.length ?? 1} member${(activeWorkspace.member_count ?? activeWorkspace.members?.length ?? 1) !== 1 ? 's' : ''}`}
                    </small>
                  </div>
                </div>

                {/* Right-side Workspace Header Utilities (Matching Reference Image 1: Manage access, Workspace settings/delete) */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {!isPersonalWorkspace(activeWorkspace) && (
                    <button onClick={addMember} className="pbi-btn-tool" style={{ borderColor: 'transparent' }}>
                      <Users size={15} color="#0d6257" /> Manage access
                    </button>
                  )}

                  {activeWorkspace.role === 'Admin' && !isPersonalWorkspace(activeWorkspace) && (
                    <button onClick={deleteWorkspace} className="pbi-btn-tool" style={{ borderColor: 'transparent', color: '#dc2626' }}>
                      <Trash2 size={15} /> Delete workspace
                    </button>
                  )}
                </div>
              </div>

              {/* Semantic Model & Reports Service (Includes unified toolbar & table) */}
              <SemanticModelService 
                workspace={activeWorkspace} 
                reports={activeWorkspace.reports} 
                onNewItem={() => fileInput.current?.click()}
                otherWorkspaces={workspaces.filter(w => w.id !== activeWorkspace.id)}
                onSelectWorkspace={id => void loadWorkspace(id)}
                onOpenReport={r => {
                  const report = reports.find(item => (r.itemKey && item.itemKey === r.itemKey) || (item.id === r.id && item.paginatedId === r.paginatedId)) || { ...r, role: activeWorkspace.role, pages: 0, published_at: r.published_at || r.updated_at || new Date().toISOString() };
                  history.replaceState(null, '', `${location.pathname}?workspace=1&report=${encodeURIComponent(r.id)}`);
                  setViewing(report as Report);
                }} 
                onReportSettings={r => setSettingsReport({ ...(reports.find(item => item.id === r.id && !item.paginatedId) || r), role: activeWorkspace.role, pages: 0, published_at: r.published_at || r.updated_at || new Date().toISOString() } as Report)} 
                onShareReport={r => setSharing({ ...(reports.find(item => item.id === r.id && !item.paginatedId) || r), role: activeWorkspace.role, pages: 0, published_at: r.published_at || r.updated_at || new Date().toISOString() } as Report)} 
                onDeleteReport={async r => {
                  if (!confirm(`Delete report "${r.name}"? This cannot be undone.`)) return;
                  try {
                    await api(`/cloud/reports/${r.id}`, { method: 'DELETE' });
                    await loadWorkspace(activeWorkspace.id);
                    await loadData();
                  } catch (e: any) { alert(e.message || String(e)); }
                }} 
                onRefresh={model => {
                  const linked = model.reports?.[0] || { id: model.report_id || '', name: model.name };
                  if (linked.id) {
                    setScheduling({ id: linked.id, name: linked.name, published_at: model.updated_at || new Date().toISOString(), updated_at: model.updated_at, pages: 0, role: activeWorkspace.role });
                  }
                }} 
              />
            </div>
          )}

          {/* ══════════════════════════════════════════════════════════════
              HELP + SUPPORT VIEW (Image matching user request)
             ══════════════════════════════════════════════════════════════ */}
          {!loading && viewMode === 'help_support' && (
            <HelpSupportView
              onBack={() => setViewMode(activeWorkspace ? 'workspaces' : 'home')}
              activeWorkspaceName={activeWorkspace?.name}
              activeWorkspaceId={activeWorkspace?.id}
              userEmail={session?.user?.email}
            />
          )}
        </main>
      </div>

      {/* Hidden file input for uploads */}
      <input type="file" ref={fileInput} hidden accept=".vtabapp,.vtabpkg,.vtabdata" onChange={handleUpload} />

      {/* Dialogs */}
      {scheduling && (
        <RefreshCenterDialog 
          reportId={scheduling.id} 
          reportName={scheduling.name} 
          sourceType={(scheduling.project?.sourceType || scheduling.project?.dataSourceType) as any} 
          onClose={() => setScheduling(null)} 
          supabaseSession={session} 
        />
      )}

      {settingsReport && (
        <ReportServiceSettings 
          report={settingsReport} 
          onClose={() => setSettingsReport(null)} 
          onShare={() => { setSharing(settingsReport); setSettingsReport(null); }} 
          onRefresh={() => { setScheduling(settingsReport); setSettingsReport(null); }} 
          onDelete={async () => {
            const r = settingsReport;
            if (!confirm(`Delete report "${r.name}"? This cannot be undone.`)) return;
            try {
              await api(`/cloud/reports/${r.id}`, { method: 'DELETE' });
              setSettingsReport(null);
              loadData();
            } catch (e: any) { alert(e.message || String(e)); }
          }} 
        />
      )}
      {notificationSettingsOpen && <NotificationSettingsDialog onClose={() => setNotificationSettingsOpen(false)}/>}

      {sharing && !viewing && (
        <ShareDialog 
          reportId={sharing.id} 
          reportName={sharing.name} 
          workspaceIsPersonal={isPersonalReport(sharing) || isPersonalWorkspace(activeWorkspace)} 
          onClose={() => setSharing(null)} 
          supabaseSession={session} 
        />
      )}

      {/* Manage Access Modal (Power BI Style — Shows Members & Add Member) */}
      {addMemberOpen && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", zIndex: 999, display: "grid", placeItems: "center" }} onMouseDown={() => setAddMemberOpen(false)}>
          <div style={{ background: "#fff", borderRadius: 8, padding: 24, width: 480, maxWidth: "92vw", maxHeight: "88vh", display: "flex", flexDirection: "column", boxShadow: "0 16px 40px rgba(0,0,0,.2)" }} onMouseDown={e => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <div>
                <b style={{ fontSize: 16, color: "#242424" }}>Manage access</b>
                <small style={{ color: "#616161", display: "block" }}>{activeWorkspace?.name}</small>
              </div>
              <button onClick={() => setAddMemberOpen(false)} style={{ background: "none", border: "none", cursor: "pointer", color: "#616161" }}>
                <X size={18} />
              </button>
            </div>

            {activeWorkspace?.role === 'Admin' && (
              <div style={{ display: "flex", flexDirection: "column", gap: 12, paddingBottom: 16, marginBottom: 16, borderBottom: "1px solid #edebe9" }}>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: "#242424", display: "block", marginBottom: 6 }}>
                    Add people
                  </label>
                  <select 
                    style={{ width: "100%", border: "1px solid #c8c6c4", borderRadius: 4, padding: "8px 10px", fontSize: 13, outline: "none", background: "#fff" }}
                    value={memberEmail}
                    onChange={e => setMemberEmail(e.target.value)}
                  >
                    <option value="">-- Choose registered user --</option>
                    {registeredUsers.map((u: any) => (
                      <option key={u.id} value={u.email}>
                        {u.email} {u.display_name && u.display_name !== u.email.split('@')[0] ? `(${u.display_name})` : ''}
                      </option>
                    ))}
                  </select>
                </div>

                <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
                  <div style={{ flex: 1 }}>
                    <label style={{ fontSize: 12, fontWeight: 600, color: "#242424", display: "block", marginBottom: 6 }}>Role</label>
                    <select 
                      style={{ width: "100%", border: "1px solid #c8c6c4", borderRadius: 4, padding: "8px 10px", fontSize: 13, outline: "none" }}
                      value={memberRole} 
                      onChange={e => setMemberRole(e.target.value as any)}
                    >
                      <option value="Viewer">Viewer (can only view reports)</option>
                      <option value="Contributor">Contributor (can view & export reports)</option>
                      <option value="Admin">Admin (full workspace access)</option>
                    </select>
                  </div>
                  <button 
                    onClick={submitAddMember} 
                    disabled={memberBusy || !memberEmail.trim()}
                    style={{ 
                      height: 35, padding: "0 18px", border: "none", borderRadius: 4, 
                      cursor: memberBusy || !memberEmail.trim() ? "not-allowed" : "pointer", 
                      background: memberBusy || !memberEmail.trim() ? "#c8c6c4" : "#0d6257", 
                      color: "#fff", fontWeight: 600, fontSize: 13 
                    }}
                  >
                    {memberBusy ? "Adding…" : "Add"}
                  </button>
                </div>

                {memberErr && (
                  <div style={{ color: "#dc2626", fontSize: 12, background: "#fef2f2", padding: "8px 10px", borderRadius: 4 }}>
                    ⚠️ {memberErr}
                  </div>
                )}
              </div>
            )}

            <div style={{ flex: 1, overflowY: "auto" }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#616161", marginBottom: 8 }}>
                People with access ({activeWorkspace?.members?.length || 1})
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {(activeWorkspace?.members || []).map((m: any, idx: number) => {
                  const email = m.email || m.user_email || 'Member';
                  const name = m.display_name || email.split('@')[0];
                  const canRemove = activeWorkspace?.role === 'Admin' && m.user_id && m.user_id !== session?.user?.id;
                  return (
                    <div key={m.user_id || idx} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", background: "#f8fafc", borderRadius: 6, border: "1px solid #edebe9" }}>
                      <div className="pbi-avatar-btn" style={{ margin: 0, width: 30, height: 30, fontSize: 12 }}>
                        {(name || '?')[0].toUpperCase()}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: "#242424", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</div>
                        <small style={{ fontSize: 11, color: "#616161", display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{email}</small>
                      </div>
                      <span style={roleBadgeStyle(m.role || 'Viewer')}>{m.role || 'Viewer'}</span>
                      {canRemove && (
                        <button
                          title={`Remove ${email}`}
                          onClick={() => removeMember(m.user_id, email)}
                          style={{
                            border: 'none', background: 'transparent', cursor: 'pointer',
                            color: '#a80000', padding: '4px 6px', borderRadius: 4, display: 'grid', placeItems: 'center'
                          }}
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
              <button 
                onClick={() => setAddMemberOpen(false)} 
                style={{ padding: "7px 18px", border: "1px solid #c8c6c4", borderRadius: 4, cursor: "pointer", background: "#fff", fontWeight: 600, fontSize: 13, color: "#242424" }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes pbiSpin { to { transform: rotate(360deg); } }
        * { box-sizing: border-box; }
      `}</style>
    </div>
  );
}
