import { useEffect, useRef, useState } from "react";
import { supabase } from "../supabase";
import { api } from "../api";

type Role = "Viewer" | "Co-Owner";
type Grant = { email: string; role: Role; granted_at?: string };
type UserSuggestion = { id: string; email: string; display_name: string };

type Props = {
  reportId: string;
  reportName: string;
  onClose: () => void;
  supabaseSession: any;
};

const Avatar = ({ name, email, size = 32 }: { name?: string; email?: string; size?: number }) => {
  const label = (name || email || '?')[0].toUpperCase();
  const colors = ['#6366f1','#8b5cf6','#ec4899','#10b981','#f59e0b'];
  const bg = colors[(label.charCodeAt(0)) % colors.length];
  return <div style={{ width: size, height: size, borderRadius: '50%', background: bg, color: '#fff', fontWeight: 700, fontSize: size * 0.4, display: 'grid', placeItems: 'center', flexShrink: 0 }}>{label}</div>;
};

export default function ShareDialog({ reportId, reportName, onClose, supabaseSession }: Props) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("Viewer");
  const [grants, setGrants] = useState<Grant[]>([]);
  const [sharesBusy, setSharesBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [success, setSuccess] = useState("");

  // Autocomplete
  const [suggestions, setSuggestions] = useState<UserSuggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const suggestTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Workspaces
  const [workspaces, setWorkspaces] = useState<any[]>([]);
  const [selectedWs, setSelectedWs] = useState<string>("");
  const [wsBusy, setWsBusy] = useState(false);

  // Slide-in animation state
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const handleClose = () => {
    setMounted(false);
    setTimeout(onClose, 300); // Wait for transition
  };

  const reportUrl = `${window.location.origin}/?workspace=1&report=${encodeURIComponent(reportId)}`;
  const authHeader = { Authorization: `Bearer ${supabaseSession?.access_token}` };

  const loadShares = async () => {
    if (!supabase) return;
    setSharesBusy(true);
    try {
      const { data, error } = await supabase.rpc("list_report_shares", { p_report_id: reportId });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      setGrants((data?.shares || []).filter((g: Grant) => g.role === "Viewer" || g.role === "Co-Owner"));
    } catch (e: any) {
      setErr(e.message || String(e));
    } finally {
      setSharesBusy(false);
    }
  };

  const loadWorkspaces = async () => {
    if (!supabaseSession?.access_token) return;
    try {
      const res = await fetch("/api/v1/cloud/workspaces", { headers: authHeader });
      if (res.ok) {
        const data = await res.json();
        setWorkspaces(data.filter((w: any) => w.role === "Admin"));
      }
    } catch (e) {}
  };

  useEffect(() => { loadShares(); loadWorkspaces(); }, [reportId]);

  const handleEmailChange = (val: string) => {
    setEmail(val);
    setShowSuggestions(false);
    if (suggestTimeout.current) clearTimeout(suggestTimeout.current);
    if (val.trim().length < 2) { setSuggestions([]); return; }
    suggestTimeout.current = setTimeout(async () => {
      setSuggestLoading(true);
      try {
        const res = await fetch(`/api/v1/cloud/users/search?q=${encodeURIComponent(val.trim())}`, { headers: authHeader });
        if (res.ok) {
          const data: UserSuggestion[] = await res.json();
          setSuggestions(data);
          setShowSuggestions(data.length > 0);
        }
      } catch {} finally { setSuggestLoading(false); }
    }, 300);
  };

  const selectSuggestion = (u: UserSuggestion) => {
    setEmail(u.email);
    setSuggestions([]);
    setShowSuggestions(false);
  };

  const copyLink = async () => {
    try { await navigator.clipboard.writeText(reportUrl); setSuccess("Access link copied to clipboard."); }
    catch { window.prompt("Copy access link for registered users", reportUrl); }
    setTimeout(() => setSuccess(""), 3000);
  };

  const shareEmail = async () => {
    const targetEmail = email.trim().toLowerCase();
    if (!targetEmail) return;
    setBusy(true); setErr(""); setSuccess("");
    try {
      if (!supabase) throw new Error("Supabase client is not configured.");
      const granterId = supabaseSession?.user?.id;
      if (!granterId) throw new Error("Please sign in again before sharing.");
      const internalRole: Role = role === "Co-Owner" ? "Co-Owner" : "Viewer";
      const { data, error } = await supabase.rpc("share_report_by_email", {
        p_report_id: reportId, p_target_email: targetEmail,
        p_role: internalRole, p_granter_id: granterId
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      const sharedEmail = data?.email || targetEmail;
      setGrants(g => [{ email: sharedEmail, role: internalRole }, ...g.filter(x => x.email !== sharedEmail)]);
      setSuccess(`${sharedEmail} added as ${role === "Co-Owner" ? "Admin" : "Viewer"}.`);
      setEmail("");
      loadShares();
      api(`/published/${reportId}/share-email`, {
        method: "POST",
        body: JSON.stringify({ to: sharedEmail, role: internalRole, reportUrl })
      }).catch(e => console.warn("Email notification failed:", e));
      setTimeout(() => setSuccess(""), 4000);
    } catch (e: any) {
      setErr(e.message || String(e));
    } finally { setBusy(false); }
  };

  const shareToWorkspace = async () => {
    if (!selectedWs) return;
    setWsBusy(true); setErr(""); setSuccess("");
    try {
      const res = await fetch(`/api/v1/cloud/workspaces/${selectedWs}/reports`, {
        method: "POST",
        headers: { ...authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ report_id: reportId })
      });
      const data = await res.json();
      if (res.ok) {
        setSuccess("Report successfully shared to the workspace!");
        setSelectedWs("");
      } else {
        throw new Error(data.detail || "Failed to share report to workspace");
      }
      setTimeout(() => setSuccess(""), 4000);
    } catch (e: any) {
      setErr(e.message || String(e));
    } finally { setWsBusy(false); }
  };

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 1000,
      background: mounted ? "rgba(15,23,42,0.4)" : "rgba(15,23,42,0)",
      transition: "background 0.3s ease",
      display: "flex", justifyContent: "flex-end"
    }} onMouseDown={handleClose}>
      
      {/* Slide-in panel */}
      <div style={{
        width: "100%", maxWidth: 440, height: "100%", background: "#fff",
        boxShadow: "-8px 0 32px rgba(15,23,42,0.1)",
        transform: mounted ? "translateX(0)" : "translateX(100%)",
        transition: "transform 0.3s cubic-bezier(0.16, 1, 0.3, 1)",
        display: "flex", flexDirection: "column",
        fontFamily: "Inter, -apple-system, sans-serif"
      }} onMouseDown={e => e.stopPropagation()}>
        
        {/* Header */}
        <div style={{ padding: "24px 32px", borderBottom: "1px solid #e2e8f0", display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: ".1em", color: "#6366f1", marginBottom: 6 }}>SHARE REPORT</div>
            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: "#0f172a", lineHeight: 1.3 }}>{reportName}</h2>
          </div>
          <button onClick={handleClose} style={{ background: "#f1f5f9", border: "none", borderRadius: 8, width: 32, height: 32, cursor: "pointer", fontSize: 16, display: "grid", placeItems: "center", color: "#64748b" }}>✕</button>
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: "auto", padding: "32px" }}>
          
          {/* Notifications */}
          {err && <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 10, padding: "12px 16px", color: "#dc2626", fontSize: 13, marginBottom: 20 }}>⚠️ {err}</div>}
          {success && <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 10, padding: "12px 16px", color: "#16a34a", fontSize: 13, marginBottom: 20 }}>✅ {success}</div>}

          {/* Access Link */}
          <div style={{ marginBottom: 32 }}>
            <h3 style={{ fontSize: 14, fontWeight: 700, color: "#0f172a", margin: "0 0 12px" }}>Access Link</h3>
            <p style={{ margin: "0 0 12px", fontSize: 13, color: "#64748b" }}>Anyone with this link can view if they have been granted access.</p>
            <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
              <div style={{ flex: 1, border: "1.5px solid #e2e8f0", borderRadius: 10, padding: "0 12px", background: "#f8fafc", display: "flex", alignItems: "center", overflow: "hidden" }}>
                <span style={{ color: "#475569", fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{reportUrl}</span>
              </div>
              <button onClick={copyLink} style={{ background: "#fff", border: "1.5px solid #e2e8f0", borderRadius: 10, padding: "0 16px", fontWeight: 600, color: "#374151", cursor: "pointer", fontSize: 13, transition: "background 0.15s" }} onMouseOver={e=>e.currentTarget.style.background="#f8fafc"} onMouseOut={e=>e.currentTarget.style.background="#fff"}>
                Copy Link
              </button>
            </div>
          </div>

          {/* Invite User */}
          <div style={{ marginBottom: 32 }}>
            <h3 style={{ fontSize: 14, fontWeight: 700, color: "#0f172a", margin: "0 0 12px" }}>Share with people</h3>
            <div style={{ position: "relative" }}>
              <div style={{ display: "flex", gap: 8 }}>
                <div style={{ flex: 1, position: "relative" }}>
                  <input
                    style={{ width: "100%", border: "1.5px solid #e2e8f0", borderRadius: 10, padding: "10px 14px", fontSize: 13, boxSizing: "border-box", outline: "none", transition: "border 0.15s" }}
                    placeholder="Search by email address…" value={email}
                    onChange={e => handleEmailChange(e.target.value)}
                    onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
                    onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
                    onKeyDown={e => e.key === "Enter" && shareEmail()}
                    autoComplete="off"
                  />
                  {suggestLoading && <span style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", color: "#94a3b8", fontSize: 12 }}>…</span>}
                </div>
                <select
                  style={{ border: "1.5px solid #e2e8f0", borderRadius: 10, padding: "0 12px", fontSize: 13, fontWeight: 600, color: "#374151", outline: "none", background: "#fff", minWidth: 100 }}
                  value={role} onChange={e => setRole(e.target.value as Role)}>
                  <option value="Viewer">Viewer</option>
                  <option value="Co-Owner">Admin</option>
                </select>
                <button onClick={shareEmail} disabled={busy || !email.trim()}
                  style={{ background: busy || !email.trim() ? "#c7d2fe" : "linear-gradient(135deg,#6366f1,#8b5cf6)", color: "#fff", border: "none", borderRadius: 10, padding: "0 20px", fontWeight: 700, fontSize: 13, cursor: busy || !email.trim() ? "not-allowed" : "pointer" }}>
                  {busy ? "Sharing" : "Share"}
                </button>
              </div>

              {/* Autocomplete Dropdown */}
              {showSuggestions && suggestions.length > 0 && (
                <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 50, background: "#fff", border: "1.5px solid #e2e8f0", borderRadius: 10, boxShadow: "0 8px 32px rgba(15,23,42,.12)", overflow: "hidden", marginTop: 4 }}>
                  {suggestions.map((u: any) => (
                    <div key={u.id} onMouseDown={() => selectSuggestion(u)}
                      style={{ padding: "10px 14px", cursor: "pointer", display: "flex", alignItems: "center", gap: 10 }}
                      onMouseOver={e => e.currentTarget.style.background = "#f8fafc"}
                      onMouseOut={e => e.currentTarget.style.background = "#fff"}>
                      <Avatar email={u.email} size={28} />
                      <div>
                        <b style={{ fontSize: 13, color: "#0f172a" }}>{u.email}</b>
                        {u.display_name && u.display_name !== u.email.split("@")[0] && (
                          <span style={{ fontSize: 11, color: "#64748b", marginLeft: 6 }}>{u.display_name}</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Role legend */}
            <div style={{ background: "#f8fafc", borderRadius: 8, padding: "12px", marginTop: 12, fontSize: 12, color: "#64748b", lineHeight: 1.5, border: "1px dashed #cbd5e1" }}>
              <span style={{ color: "#334155", fontWeight: 600 }}>Viewer</span>: Can interact with charts. Cannot share.<br />
              <span style={{ color: "#334155", fontWeight: 600 }}>Admin</span>: Can view, copy links, and share report with others.
            </div>
          </div>

          {/* Share to Workspace */}
          {workspaces.length > 0 && (
            <div style={{ marginBottom: 32, background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 12, padding: 16 }}>
              <h3 style={{ fontSize: 14, fontWeight: 700, color: "#166534", margin: "0 0 12px", display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 16 }}>🏢</span> Share to Workspace
              </h3>
              <div style={{ display: "flex", gap: 8 }}>
                <select style={{ flex: 1, border: "1.5px solid #86efac", borderRadius: 10, padding: "10px 12px", fontSize: 13, outline: "none", background: "#fff" }}
                  value={selectedWs} onChange={e => setSelectedWs(e.target.value)}>
                  <option value="">Select a team workspace…</option>
                  {workspaces.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                </select>
                <button onClick={shareToWorkspace} disabled={wsBusy || !selectedWs}
                  style={{ background: wsBusy || !selectedWs ? "#bbf7d0" : "#16a34a", color: "#fff", border: "none", borderRadius: 10, padding: "0 20px", fontWeight: 700, fontSize: 13, cursor: wsBusy || !selectedWs ? "not-allowed" : "pointer" }}>
                  {wsBusy ? "Sharing…" : "Add"}
                </button>
              </div>
            </div>
          )}

          {/* Shared List */}
          <div>
            <h3 style={{ fontSize: 14, fontWeight: 700, color: "#0f172a", margin: "0 0 16px" }}>Who has access</h3>
            {sharesBusy ? (
              <div style={{ color: "#64748b", fontSize: 13 }}>Loading…</div>
            ) : grants.length === 0 ? (
              <div style={{ color: "#64748b", fontSize: 13, background: "#f8fafc", padding: "16px", borderRadius: 10, textAlign: "center" }}>No one else has access yet.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {grants.map((g, i) => (
                  <div key={`${g.email}-${i}`} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", borderRadius: 10, background: "#fff", border: "1px solid #f1f5f9" }}>
                    <Avatar email={g.email} size={36} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: "#0f172a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.email}</div>
                    </div>
                    <span style={{ fontSize: 11, fontWeight: 700, padding: "4px 10px", borderRadius: 999,
                      background: g.role === "Co-Owner" ? "#f5f3ff" : "#f1f5f9",
                      color: g.role === "Co-Owner" ? "#6d28d9" : "#475569" }}>
                      {g.role === "Co-Owner" ? "Admin" : "Viewer"}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

        </div>
      </div>
    </div>
  );
}
