import { useState, useEffect } from "react";

type SourceType = "google_sheets" | "postgres" | "sqlserver";

type Props = {
  reportId: string;
  reportName: string;
  sourceType?: SourceType;
  onClose: () => void;
  supabaseSession: any;
};

const INTERVALS = [
  { label: "Hourly", cron: "0 * * * *" },
  { label: "Daily", cron: "0 9 * * *", hasTime: true },
  { label: "Weekly (Monday)", cron: "0 9 * * 1", hasTime: true },
  { label: "Weekly (Friday)", cron: "0 17 * * 5", hasTime: true },
];

function buildCron(intervalLabel: string, hour: number, minute: number): string {
  if (intervalLabel === "Hourly") return "0 * * * *";
  if (intervalLabel === "Daily") return `${minute} ${hour} * * *`;
  if (intervalLabel === "Weekly (Monday)") return `${minute} ${hour} * * 1`;
  if (intervalLabel === "Weekly (Friday)") return `${minute} ${hour} * * 5`;
  return `${minute} ${hour} * * *`;
}

function CredentialsForm({ sourceType, creds, setCreds }: { sourceType: SourceType; creds: any; setCreds: (c: any) => void }) {
  const f = (key: string) => (e: any) => setCreds((prev: any) => ({ ...prev, [key]: e.target.value }));
  const inputStyle = { width: "100%", border: "1.5px solid #e2e8f0", borderRadius: 10, padding: "10px 14px", fontSize: 13, boxSizing: "border-box" as any, outline: "none", transition: "border 0.15s" };
  const onFoc = (e: any) => e.target.style.border = "1.5px solid #0891b2";
  const onBlr = (e: any) => e.target.style.border = "1.5px solid #e2e8f0";

  if (sourceType === "google_sheets") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <label style={{ fontSize: 13, fontWeight: 600, color: "#374151" }}>
          Google Sheets URL (published as CSV or with sharing enabled)
          <div style={{ marginTop: 6 }}>
            <input style={inputStyle} onFocus={onFoc} onBlur={onBlr} type="url" placeholder="https://docs.google.com/spreadsheets/d/..." value={creds.sheet_url || ""} onChange={f("sheet_url")} />
          </div>
        </label>
      </div>
    );
  }
  if (sourceType === "postgres") {
    return (
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <label style={{ fontSize: 13, fontWeight: 600, color: "#374151", gridColumn: "1 / -1" }}>Host<div style={{ marginTop: 6 }}><input style={inputStyle} onFocus={onFoc} onBlur={onBlr} placeholder="db.example.com" value={creds.host || ""} onChange={f("host")} /></div></label>
        <label style={{ fontSize: 13, fontWeight: 600, color: "#374151" }}>Port<div style={{ marginTop: 6 }}><input style={inputStyle} onFocus={onFoc} onBlur={onBlr} placeholder="5432" type="number" value={creds.port || "5432"} onChange={f("port")} /></div></label>
        <label style={{ fontSize: 13, fontWeight: 600, color: "#374151" }}>Database<div style={{ marginTop: 6 }}><input style={inputStyle} onFocus={onFoc} onBlur={onBlr} placeholder="mydb" value={creds.database || ""} onChange={f("database")} /></div></label>
        <label style={{ fontSize: 13, fontWeight: 600, color: "#374151" }}>Username<div style={{ marginTop: 6 }}><input style={inputStyle} onFocus={onFoc} onBlur={onBlr} placeholder="postgres" value={creds.username || ""} onChange={f("username")} /></div></label>
        <label style={{ fontSize: 13, fontWeight: 600, color: "#374151" }}>Password<div style={{ marginTop: 6 }}><input style={inputStyle} onFocus={onFoc} onBlur={onBlr} type="password" placeholder="••••••••" value={creds.password || ""} onChange={f("password")} /></div></label>
      </div>
    );
  }
  if (sourceType === "sqlserver") {
    return (
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <label style={{ fontSize: 13, fontWeight: 600, color: "#374151", gridColumn: "1 / -1" }}>Server Host<div style={{ marginTop: 6 }}><input style={inputStyle} onFocus={onFoc} onBlur={onBlr} placeholder="server.database.windows.net" value={creds.host || ""} onChange={f("host")} /></div></label>
        <label style={{ fontSize: 13, fontWeight: 600, color: "#374151", gridColumn: "1 / -1" }}>Database<div style={{ marginTop: 6 }}><input style={inputStyle} onFocus={onFoc} onBlur={onBlr} placeholder="MyDatabase" value={creds.database || ""} onChange={f("database")} /></div></label>
        <label style={{ fontSize: 13, fontWeight: 600, color: "#374151" }}>Username<div style={{ marginTop: 6 }}><input style={inputStyle} onFocus={onFoc} onBlur={onBlr} placeholder="sa" value={creds.username || ""} onChange={f("username")} /></div></label>
        <label style={{ fontSize: 13, fontWeight: 600, color: "#374151" }}>Password<div style={{ marginTop: 6 }}><input style={inputStyle} onFocus={onFoc} onBlur={onBlr} type="password" placeholder="••••••••" value={creds.password || ""} onChange={f("password")} /></div></label>
      </div>
    );
  }
  return null;
}

export default function ScheduleRefreshDialog({ reportId, reportName, sourceType: defaultSource, onClose, supabaseSession }: Props) {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [sourceType, setSourceType] = useState<SourceType>(defaultSource || "postgres");
  const [creds, setCreds] = useState<any>({});
  const [connStatus, setConnStatus] = useState<null | { ok: boolean; message: string }>(null);
  const [connTesting, setConnTesting] = useState(false);
  const [intervalLabel, setIntervalLabel] = useState("Daily");
  const [hour, setHour] = useState(9);
  const [minute, setMinute] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState("");

  // Slide-in/fade animation state
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const handleClose = () => {
    setMounted(false);
    setTimeout(onClose, 300); // Wait for transition
  };

  const authHeader = { Authorization: `Bearer ${supabaseSession?.access_token}`, "Content-Type": "application/json" };
  const cron = buildCron(intervalLabel, hour, minute);
  const showTime = intervalLabel !== "Hourly";

  const testConnection = async () => {
    setConnTesting(true); setConnStatus(null); setErr("");
    try {
      const res = await fetch(`/api/v1/scheduler/jobs/_new/test-connection`, {
        method: "POST", headers: authHeader,
        body: JSON.stringify({ source_type: sourceType, credentials: creds })
      });
      const data = await res.json();
      setConnStatus({ ok: data.ok, message: data.message });
      if (data.ok) setTimeout(() => setStep(3), 800); // Auto-advance on success
    } catch (e: any) {
      setConnStatus({ ok: false, message: e.message || String(e) });
    } finally { setConnTesting(false); }
  };

  const save = async () => {
    setSaving(true); setErr("");
    try {
      const friendlyTime = showTime ? ` at ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} UTC` : "";
      const label = `${intervalLabel}${friendlyTime}`;
      const res = await fetch("/api/v1/scheduler/jobs", {
        method: "POST", headers: authHeader,
        body: JSON.stringify({ report_id: reportId, source_type: sourceType, cron_expr: cron, interval_label: label, credentials: creds })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Failed to save scheduled job");
      setSaved(true);
    } catch (e: any) {
      setErr(e.message || String(e));
    } finally { setSaving(false); }
  };

  const SOURCE_LABELS: Record<SourceType, string> = {
    google_sheets: "Google Sheets",
    postgres: "PostgreSQL",
    sqlserver: "SQL Server"
  };

  const SOURCE_ICONS: Record<SourceType, string> = {
    google_sheets: "📊",
    postgres: "🐘",
    sqlserver: "🗄️"
  };

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 1000,
      background: mounted ? "rgba(15,23,42,0.4)" : "rgba(15,23,42,0)",
      transition: "background 0.3s ease",
      display: "grid", placeItems: "center", padding: 20
    }} onMouseDown={handleClose}>
      
      {/* Modal Card */}
      <div style={{
        width: "100%", maxWidth: 640, background: "#fff",
        borderRadius: 24, boxShadow: "0 24px 64px rgba(15,23,42,0.2)",
        transform: mounted ? "scale(1) translateY(0)" : "scale(0.95) translateY(20px)",
        opacity: mounted ? 1 : 0,
        transition: "all 0.3s cubic-bezier(0.16, 1, 0.3, 1)",
        display: "flex", flexDirection: "column",
        fontFamily: "Inter, -apple-system, sans-serif",
        overflow: "hidden"
      }} onMouseDown={e => e.stopPropagation()}>
        
        {/* Header */}
        <div style={{ padding: "32px 32px 24px", background: "linear-gradient(135deg, #0891b2 0%, #0369a1 100%)", color: "#fff", position: "relative" }}>
          <button onClick={handleClose} style={{ position: "absolute", top: 24, right: 24, background: "rgba(255,255,255,0.2)", border: "none", borderRadius: "50%", width: 32, height: 32, cursor: "pointer", fontSize: 16, display: "grid", placeItems: "center", color: "#fff", transition: "background 0.2s" }} onMouseOver={e=>e.currentTarget.style.background="rgba(255,255,255,0.3)"} onMouseOut={e=>e.currentTarget.style.background="rgba(255,255,255,0.2)"}>✕</button>
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: ".1em", color: "#cffafe", marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
            <span>⏳</span> AUTOMATED REFRESH
          </div>
          <h2 style={{ margin: 0, fontSize: 24, fontWeight: 800, color: "#fff", lineHeight: 1.2 }}>{reportName}</h2>
          
          {/* Progress Bar */}
          {!saved && (
            <div style={{ display: "flex", gap: 8, marginTop: 24 }}>
              {[1, 2, 3, 4].map(i => (
                <div key={i} style={{ flex: 1, height: 4, borderRadius: 2, background: step >= i ? "#fff" : "rgba(255,255,255,0.3)", transition: "background 0.3s" }} />
              ))}
            </div>
          )}
        </div>

        {/* Content Body */}
        <div style={{ padding: 32, flex: 1 }}>
          {saved ? (
            <div style={{ textAlign: "center", padding: "40px 0" }}>
              <div style={{ width: 80, height: 80, borderRadius: "50%", background: "#dcfce7", color: "#16a34a", fontSize: 40, display: "grid", placeItems: "center", margin: "0 auto 24px" }}>✓</div>
              <h3 style={{ fontSize: 24, fontWeight: 800, color: "#0f172a", margin: "0 0 12px" }}>Schedule Active!</h3>
              <p style={{ color: "#64748b", fontSize: 15, margin: "0 auto 32px", maxWidth: 360, lineHeight: 1.5 }}>
                Your data will now refresh automatically on the cloud server. You don't need to keep the app open.
              </p>
              <button onClick={handleClose} style={{ background: "#0f172a", color: "#fff", border: "none", borderRadius: 12, padding: "14px 40px", fontWeight: 700, fontSize: 15, cursor: "pointer", boxShadow: "0 4px 12px rgba(15,23,42,.15)" }}>
                Done
              </button>
            </div>
          ) : (
            <div style={{ position: "relative", minHeight: 320 }}>
              
              {/* Step 1: Select Source Type */}
              {step === 1 && (
                <div style={{ animation: "fadeIn 0.3s" }}>
                  <h3 style={{ fontSize: 18, fontWeight: 700, color: "#0f172a", margin: "0 0 8px" }}>Select Data Source</h3>
                  <p style={{ color: "#64748b", fontSize: 14, margin: "0 0 24px" }}>Where should the cloud server pull fresh data from?</p>
                  
                  <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 12 }}>
                    {(["postgres", "sqlserver", "google_sheets"] as SourceType[]).map(type => (
                      <button key={type} onClick={() => { setSourceType(type); setConnStatus(null); setCreds({}); setStep(2); }}
                        style={{ display: "flex", alignItems: "center", gap: 16, padding: "16px 20px", background: "#fff", border: `2px solid ${sourceType === type ? "#0891b2" : "#e2e8f0"}`, borderRadius: 16, cursor: "pointer", textAlign: "left", transition: "all 0.2s" }}
                        onMouseOver={e => { if(sourceType!==type) e.currentTarget.style.borderColor = "#cbd5e1" }}
                        onMouseOut={e => { if(sourceType!==type) e.currentTarget.style.borderColor = "#e2e8f0" }}>
                        <div style={{ fontSize: 24 }}>{SOURCE_ICONS[type]}</div>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 15, fontWeight: 700, color: "#0f172a" }}>{SOURCE_LABELS[type]}</div>
                        </div>
                        <div style={{ color: sourceType === type ? "#0891b2" : "#cbd5e1", fontSize: 20 }}>→</div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Step 2: Credentials */}
              {step === 2 && (
                <div style={{ animation: "fadeIn 0.3s" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 24 }}>
                    <div style={{ fontSize: 24 }}>{SOURCE_ICONS[sourceType]}</div>
                    <div>
                      <h3 style={{ fontSize: 18, fontWeight: 700, color: "#0f172a", margin: "0 0 4px" }}>{SOURCE_LABELS[sourceType]} Credentials</h3>
                      <p style={{ color: "#64748b", fontSize: 13, margin: 0 }}>Provide access for the cloud runner to fetch data.</p>
                    </div>
                  </div>

                  <CredentialsForm sourceType={sourceType} creds={creds} setCreds={setCreds} />

                  {/* Test Connection Button & Status */}
                  <div style={{ marginTop: 24, padding: "16px", background: "#f8fafc", borderRadius: 12, border: "1px dashed #cbd5e1", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <button onClick={testConnection} disabled={connTesting}
                      style={{ background: "#0f172a", color: "#fff", border: "none", borderRadius: 8, padding: "10px 20px", fontWeight: 700, cursor: connTesting ? "not-allowed" : "pointer", fontSize: 14, display: "flex", alignItems: "center", gap: 8 }}>
                      {connTesting ? <span style={{ width: 14, height: 14, border: "2px solid #fff", borderTopColor: "transparent", borderRadius: "50%", animation: "spin 0.7s linear infinite" }} /> : "🔌"}
                      {connTesting ? "Testing..." : "Test Connection"}
                    </button>
                    
                    {connStatus && (
                      <div style={{ display: "flex", alignItems: "center", gap: 8, color: connStatus.ok ? "#16a34a" : "#dc2626", fontWeight: 600, fontSize: 14 }}>
                        <span style={{ fontSize: 18 }}>{connStatus.ok ? "✅" : "❌"}</span>
                        <span>{connStatus.ok ? "Connection successful!" : "Connection failed"}</span>
                      </div>
                    )}
                  </div>
                  {connStatus && !connStatus.ok && (
                    <div style={{ marginTop: 12, color: "#dc2626", fontSize: 13, background: "#fef2f2", padding: "12px", borderRadius: 8, border: "1px solid #fecaca" }}>
                      <b>Error details:</b> {connStatus.message}
                    </div>
                  )}

                  <div style={{ display: "flex", justifyContent: "space-between", marginTop: 32 }}>
                    <button onClick={() => setStep(1)} style={{ background: "none", border: "none", color: "#64748b", fontWeight: 600, fontSize: 14, cursor: "pointer", padding: "8px 16px" }}>← Back</button>
                    <button onClick={() => setStep(3)} disabled={!connStatus?.ok}
                      style={{ background: connStatus?.ok ? "#0891b2" : "#e2e8f0", color: connStatus?.ok ? "#fff" : "#94a3b8", border: "none", borderRadius: 10, padding: "10px 24px", fontWeight: 700, fontSize: 14, cursor: connStatus?.ok ? "pointer" : "not-allowed", transition: "background 0.2s" }}>
                      Next: Set Schedule →
                    </button>
                  </div>
                </div>
              )}

              {/* Step 3: Frequency */}
              {step === 3 && (
                <div style={{ animation: "fadeIn 0.3s" }}>
                  <h3 style={{ fontSize: 18, fontWeight: 700, color: "#0f172a", margin: "0 0 8px" }}>Refresh Schedule</h3>
                  <p style={{ color: "#64748b", fontSize: 14, margin: "0 0 24px" }}>How often should the data be updated?</p>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 32 }}>
                    {INTERVALS.map(iv => (
                      <button key={iv.label} onClick={() => setIntervalLabel(iv.label)}
                        style={{ padding: "16px", borderRadius: 12, border: `2px solid ${intervalLabel === iv.label ? "#0891b2" : "#e2e8f0"}`,
                          background: intervalLabel === iv.label ? "#ecfeff" : "#fff", color: intervalLabel === iv.label ? "#0891b2" : "#334155",
                          fontWeight: 700, fontSize: 14, cursor: "pointer", transition: "all 0.2s", textAlign: "center" }}>
                        {iv.label}
                      </button>
                    ))}
                  </div>

                  {showTime && (
                    <div style={{ background: "#f8fafc", padding: 24, borderRadius: 16, border: "1px solid #e2e8f0", display: "flex", flexDirection: "column", alignItems: "center" }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: "#475569", marginBottom: 12, textTransform: "uppercase", letterSpacing: ".05em" }}>Time of day (UTC)</div>
                      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                        <input type="number" min={0} max={23} value={hour}
                          onChange={e => setHour(Math.max(0, Math.min(23, parseInt(e.target.value) || 0)))}
                          style={{ width: 80, border: "1.5px solid #cbd5e1", borderRadius: 10, padding: "12px", fontSize: 24, fontWeight: 800, textAlign: "center", color: "#0f172a", outline: "none" }}
                          onFocus={e=>e.target.style.borderColor="#0891b2"} onBlur={e=>e.target.style.borderColor="#cbd5e1"} />
                        <span style={{ fontWeight: 800, fontSize: 24, color: "#94a3b8" }}>:</span>
                        <input type="number" min={0} max={59} step={15} value={minute}
                          onChange={e => setMinute(Math.max(0, Math.min(59, parseInt(e.target.value) || 0)))}
                          style={{ width: 80, border: "1.5px solid #cbd5e1", borderRadius: 10, padding: "12px", fontSize: 24, fontWeight: 800, textAlign: "center", color: "#0f172a", outline: "none" }}
                          onFocus={e=>e.target.style.borderColor="#0891b2"} onBlur={e=>e.target.style.borderColor="#cbd5e1"} />
                        <span style={{ color: "#64748b", fontSize: 14, fontWeight: 600, marginLeft: 8 }}>UTC</span>
                      </div>
                    </div>
                  )}

                  <div style={{ display: "flex", justifyContent: "space-between", marginTop: 32 }}>
                    <button onClick={() => setStep(2)} style={{ background: "none", border: "none", color: "#64748b", fontWeight: 600, fontSize: 14, cursor: "pointer", padding: "8px 16px" }}>← Back</button>
                    <button onClick={() => setStep(4)}
                      style={{ background: "#0891b2", color: "#fff", border: "none", borderRadius: 10, padding: "10px 24px", fontWeight: 700, fontSize: 14, cursor: "pointer", transition: "background 0.2s" }}>
                      Next: Review →
                    </button>
                  </div>
                </div>
              )}

              {/* Step 4: Review */}
              {step === 4 && (
                <div style={{ animation: "fadeIn 0.3s" }}>
                  <h3 style={{ fontSize: 18, fontWeight: 700, color: "#0f172a", margin: "0 0 8px" }}>Review & Activate</h3>
                  <p style={{ color: "#64748b", fontSize: 14, margin: "0 0 24px" }}>Confirm your schedule settings before activating.</p>

                  <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 16, padding: 24, marginBottom: 24 }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                      
                      <div style={{ display: "flex", alignItems: "flex-start", gap: 16 }}>
                        <div style={{ width: 40, height: 40, borderRadius: 10, background: "#e0f2fe", color: "#0284c7", display: "grid", placeItems: "center", fontSize: 20 }}>📊</div>
                        <div>
                          <div style={{ fontSize: 12, color: "#64748b", fontWeight: 600, marginBottom: 2 }}>REPORT</div>
                          <div style={{ fontSize: 15, fontWeight: 700, color: "#0f172a" }}>{reportName}</div>
                        </div>
                      </div>

                      <div style={{ height: 1, background: "#e2e8f0" }} />

                      <div style={{ display: "flex", alignItems: "flex-start", gap: 16 }}>
                        <div style={{ width: 40, height: 40, borderRadius: 10, background: "#e0f2fe", color: "#0284c7", display: "grid", placeItems: "center", fontSize: 20 }}>{SOURCE_ICONS[sourceType]}</div>
                        <div>
                          <div style={{ fontSize: 12, color: "#64748b", fontWeight: 600, marginBottom: 2 }}>DATA SOURCE</div>
                          <div style={{ fontSize: 15, fontWeight: 700, color: "#0f172a" }}>{SOURCE_LABELS[sourceType]}</div>
                        </div>
                      </div>

                      <div style={{ height: 1, background: "#e2e8f0" }} />

                      <div style={{ display: "flex", alignItems: "flex-start", gap: 16 }}>
                        <div style={{ width: 40, height: 40, borderRadius: 10, background: "#e0f2fe", color: "#0284c7", display: "grid", placeItems: "center", fontSize: 20 }}>⏰</div>
                        <div>
                          <div style={{ fontSize: 12, color: "#64748b", fontWeight: 600, marginBottom: 2 }}>FREQUENCY</div>
                          <div style={{ fontSize: 15, fontWeight: 700, color: "#0f172a" }}>{intervalLabel}{showTime ? ` at ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} UTC` : ""}</div>
                          <div style={{ fontSize: 12, color: "#94a3b8", fontFamily: "monospace", marginTop: 4 }}>Cron: {cron}</div>
                        </div>
                      </div>

                    </div>
                  </div>

                  {err && <div style={{ color: "#dc2626", fontSize: 13, background: "#fef2f2", padding: "12px 16px", borderRadius: 10, marginBottom: 24, border: "1px solid #fecaca" }}>⚠️ {err}</div>}

                  <div style={{ display: "flex", justifyContent: "space-between", marginTop: 32 }}>
                    <button onClick={() => setStep(3)} style={{ background: "none", border: "none", color: "#64748b", fontWeight: 600, fontSize: 14, cursor: "pointer", padding: "8px 16px" }}>← Back</button>
                    <button onClick={save} disabled={saving}
                      style={{ background: "linear-gradient(135deg, #16a34a, #15803d)", color: "#fff", border: "none", borderRadius: 10, padding: "12px 32px", fontWeight: 800, fontSize: 15, cursor: saving ? "not-allowed" : "pointer", boxShadow: "0 4px 12px rgba(22,163,74,0.3)" }}>
                      {saving ? "Activating..." : "Activate Schedule"}
                    </button>
                  </div>
                </div>
              )}

            </div>
          )}
        </div>
      </div>
      <style>{`
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
