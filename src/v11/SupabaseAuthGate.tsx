import { useEffect, useState } from "react";
import { api } from "../api";
import { supabase } from "../supabase";

type Props = { onSignedIn: (session: any) => void };

export default function SupabaseAuthGate({ onSignedIn }: Props) {
  // --- ALL EXISTING STATE AND LOGIC ---
  const [mode, setMode] = useState<"login" | "register" | "forgot" | "reset">("login");
  const [form, setForm] = useState({ email: "", password: "", name: "", otp: "", newPassword: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");
  const [resetProvider, setResetProvider] = useState<"backend" | "supabase">("backend");
  const [showPass, setShowPass] = useState(false);
  const [showNewPass, setShowNewPass] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has("error") && !params.has("error_code") && !params.has("error_description")) return;
    params.delete("error"); params.delete("error_code"); params.delete("error_description");
    const query = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
    setMode("forgot");
    setErr("That reset link is expired. Request a fresh 6-digit OTP below.");
  }, []);

  const submit = async () => {
    if (!supabase) { setErr("Cloud not configured. Contact your administrator."); return; }
    setBusy(true); setErr(""); setInfo("");
    try {
      if (mode === "forgot") {
        const email = form.email.trim().toLowerCase();
        if (!email) throw new Error("Enter your registered email address.");
        try {
          await api("/auth/password-reset/request", { method: "POST", body: JSON.stringify({ email }) });
          setResetProvider("backend");
        } catch (apiError: any) {
          const apiMessage = apiError.message || String(apiError);
          if (!apiMessage.includes("Cannot reach VTAB API")) throw apiError;
          const recoveryUrl = `${window.location.origin}${window.location.pathname}?workspace=1`;
          const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: recoveryUrl });
          if (error) throw error;
          setResetProvider("supabase");
        }
        setForm(p => ({ ...p, email }));
        setInfo("A 6-digit reset code was sent to your email.");
        setMode("reset");
      } else if (mode === "reset") {
        const email = form.email.trim().toLowerCase();
        const token = form.otp.trim();
        if (!email || !token || !form.newPassword) throw new Error("Enter email, 6-digit OTP and new password.");
        if (token.length !== 6) throw new Error("Enter the 6-digit OTP from your email.");
        if (form.newPassword.length < 6) throw new Error("Password must be at least 6 characters.");
        if (resetProvider === "backend") {
          await api("/auth/password-reset/confirm", { method: "POST", body: JSON.stringify({ email, otp: token, newPassword: form.newPassword }) });
          const { data, error } = await supabase.auth.signInWithPassword({ email, password: form.newPassword });
          if (error) throw error;
          if (data.session) localStorage.setItem('vtab_supabase_token', data.session.access_token);
          setInfo("Password reset successfully.");
          onSignedIn(data.session);
        } else {
          const { data, error } = await supabase.auth.verifyOtp({ email, token, type: "recovery" });
          if (error) throw error;
          const { error: updateError } = await supabase.auth.updateUser({ password: form.newPassword });
          if (updateError) throw updateError;
          if (data.session) localStorage.setItem('vtab_supabase_token', data.session.access_token);
          setInfo("Password reset successfully.");
          onSignedIn(data.session);
        }
      } else if (mode === "register") {
        const { data, error } = await supabase.auth.signUp({
          email: form.email, password: form.password,
          options: { data: { display_name: form.name } }
        });
        if (error) throw error;
        if (data.session) { localStorage.setItem('vtab_supabase_token', data.session.access_token); onSignedIn(data.session); }
        else setErr("Check your email for a confirmation link.");
      } else {
        const { data, error } = await supabase.auth.signInWithPassword({ email: form.email, password: form.password });
        if (error) throw error;
        if (data.session) localStorage.setItem('vtab_supabase_token', data.session.access_token);
        onSignedIn(data.session);
      }
    } catch (e: any) {
      const message = e.message || String(e);
      const recoveryEmailFailed = message.includes("Error sending recovery email") || message.includes("HTTP 500") || message.includes("HTTP 504") || message.includes("unexpected_failure");
      setErr(recoveryEmailFailed ? "Supabase could not send the OTP email. Fix Supabase SMTP/Brevo settings: verified sender email, correct Brevo SMTP login/key, port 587, and Reset Password template using {{ .Token }}." : message);
    } finally { setBusy(false); }
  };

  const f = (k: string) => (e: any) => setForm(p => ({ ...p, [k]: e.target.value }));
  const buttonText = busy
    ? (mode === "register" ? "Creating account…" : mode === "forgot" ? "Sending OTP…" : mode === "reset" ? "Resetting password…" : "Signing in…")
    : (mode === "register" ? "Create Account" : mode === "forgot" ? "Send 6-digit OTP" : mode === "reset" ? "Reset Password" : "Sign In");
  const disabled = busy || !form.email || (mode === "login" && !form.password) || (mode === "register" && !form.password) || (mode === "reset" && (!form.otp || !form.newPassword));

  const switchMode = (m: typeof mode) => { setErr(""); setInfo(""); setMode(m); };

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "Inter, -apple-system, sans-serif" }}>
      {/* LEFT PANEL */}
      <div style={{
        flex: "0 0 45%", background: "linear-gradient(135deg, #0f172a 0%, #1e1b4b 50%, #0f172a 100%)",
        display: "flex", flexDirection: "column", justifyContent: "center", padding: "60px 64px",
        position: "relative", overflow: "hidden"
      }}>
        {/* Decorative circles */}
        <div style={{ position: "absolute", top: -80, right: -80, width: 300, height: 300, borderRadius: "50%", background: "rgba(99,102,241,0.15)", pointerEvents: "none" }} />
        <div style={{ position: "absolute", bottom: -60, left: -60, width: 240, height: 240, borderRadius: "50%", background: "rgba(139,92,246,0.12)", pointerEvents: "none" }} />
        {/* Logo */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 48 }}>
          <div style={{ width: 40, height: 40, borderRadius: 10, background: "linear-gradient(135deg,#6366f1,#8b5cf6)", display: "grid", placeItems: "center", fontWeight: 900, color: "#fff", fontSize: 18 }}>V</div>
          <span style={{ color: "#e2e8f0", fontWeight: 700, fontSize: 18, letterSpacing: ".02em" }}>VTAB Workspace</span>
        </div>
        <h1 style={{ color: "#f8fafc", fontSize: 36, fontWeight: 800, lineHeight: 1.2, margin: "0 0 16px" }}>Your Analytics<br/>Workspace</h1>
        <p style={{ color: "#94a3b8", fontSize: 16, lineHeight: 1.6, margin: 0 }}>Access, visualize and share powerful reports with your team. All your data, one secure place.</p>
        {/* Feature pills */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 40 }}>
          {["📊 Interactive reports & dashboards", "🔒 Role-based access control", "⏳ Scheduled data refresh", "👥 Team workspaces"].map(f => (
            <div key={f} style={{ display: "flex", alignItems: "center", gap: 10, color: "#cbd5e1", fontSize: 14 }}>{f}</div>
          ))}
        </div>
      </div>

      {/* RIGHT PANEL */}
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", background: "#f8fafc", padding: 40 }}>
        <div style={{ width: "100%", maxWidth: 420 }}>
          {/* Card */}
          <div style={{ background: "#fff", borderRadius: 20, padding: "40px 36px", boxShadow: "0 4px 32px rgba(15,23,42,.08), 0 1px 4px rgba(15,23,42,.04)" }}>
            {/* Logo mark (mobile / right side) */}
            <div style={{ width: 48, height: 48, borderRadius: 12, background: "linear-gradient(135deg,#6366f1,#8b5cf6)", display: "grid", placeItems: "center", fontWeight: 900, color: "#fff", fontSize: 22, marginBottom: 20 }}>V</div>
            
            <h2 style={{ margin: "0 0 4px", fontSize: 24, fontWeight: 800, color: "#0f172a" }}>
              {mode === "login" ? "Welcome back" : mode === "register" ? "Create account" : mode === "forgot" ? "Reset password" : "Enter new password"}
            </h2>
            <p style={{ margin: "0 0 28px", fontSize: 14, color: "#64748b" }}>
              {mode === "login" ? "Sign in to your workspace" :
               mode === "register" ? "Access reports shared with you" :
               mode === "forgot" ? "We'll send a 6-digit code to your email" :
               "Enter the OTP from your email"}
            </p>

            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {mode === "register" && (
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: "#374151", display: "block", marginBottom: 6 }}>Display Name</label>
                  <input autoFocus value={form.name} onChange={f("name")} placeholder="Your name"
                    style={{ width: "100%", border: "1.5px solid #e2e8f0", borderRadius: 10, padding: "11px 14px", fontSize: 14, outline: "none", boxSizing: "border-box", transition: "border .15s" }}
                    onFocus={e => e.target.style.border = "1.5px solid #6366f1"}
                    onBlur={e => e.target.style.border = "1.5px solid #e2e8f0"} />
                </div>
              )}

              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: "#374151", display: "block", marginBottom: 6 }}>Email</label>
                <input autoFocus={mode === "login" || mode === "forgot"} type="email" value={form.email} onChange={f("email")}
                  placeholder="you@example.com" onKeyDown={e => e.key === "Enter" && submit()}
                  style={{ width: "100%", border: "1.5px solid #e2e8f0", borderRadius: 10, padding: "11px 14px", fontSize: 14, outline: "none", boxSizing: "border-box", transition: "border .15s" }}
                  onFocus={e => e.target.style.border = "1.5px solid #6366f1"}
                  onBlur={e => e.target.style.border = "1.5px solid #e2e8f0"} />
              </div>

              {(mode === "login" || mode === "register") && (
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: "#374151", display: "block", marginBottom: 6 }}>Password</label>
                  <div style={{ position: "relative" }}>
                    <input type={showPass ? "text" : "password"} value={form.password} onChange={f("password")}
                      placeholder="••••••••" onKeyDown={e => e.key === "Enter" && submit()}
                      style={{ width: "100%", border: "1.5px solid #e2e8f0", borderRadius: 10, padding: "11px 40px 11px 14px", fontSize: 14, outline: "none", boxSizing: "border-box", transition: "border .15s" }}
                      onFocus={e => e.target.style.border = "1.5px solid #6366f1"}
                      onBlur={e => e.target.style.border = "1.5px solid #e2e8f0"} />
                    <button type="button" onClick={() => setShowPass(p => !p)}
                      style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "#94a3b8", fontSize: 14, padding: 0 }}>
                      {showPass ? "🙈" : "👁️"}
                    </button>
                  </div>
                </div>
              )}

              {mode === "reset" && (
                <>
                  <div>
                    <label style={{ fontSize: 12, fontWeight: 600, color: "#374151", display: "block", marginBottom: 6 }}>6-digit OTP</label>
                    <input inputMode="numeric" maxLength={6} value={form.otp}
                      onChange={e => setForm(p => ({ ...p, otp: e.target.value.replace(/\D/g, '').slice(0, 6) }))}
                      onKeyDown={e => e.key === "Enter" && submit()} placeholder="123456"
                      style={{ width: "100%", border: "1.5px solid #e2e8f0", borderRadius: 10, padding: "11px 14px", fontSize: 20, letterSpacing: "0.3em", outline: "none", boxSizing: "border-box", textAlign: "center" }}
                      onFocus={e => e.target.style.border = "1.5px solid #6366f1"}
                      onBlur={e => e.target.style.border = "1.5px solid #e2e8f0"} />
                  </div>
                  <div>
                    <label style={{ fontSize: 12, fontWeight: 600, color: "#374151", display: "block", marginBottom: 6 }}>New Password</label>
                    <div style={{ position: "relative" }}>
                      <input type={showNewPass ? "text" : "password"} value={form.newPassword} onChange={f("newPassword")}
                        placeholder="••••••••" onKeyDown={e => e.key === "Enter" && submit()}
                        style={{ width: "100%", border: "1.5px solid #e2e8f0", borderRadius: 10, padding: "11px 40px 11px 14px", fontSize: 14, outline: "none", boxSizing: "border-box" }}
                        onFocus={e => e.target.style.border = "1.5px solid #6366f1"}
                        onBlur={e => e.target.style.border = "1.5px solid #e2e8f0"} />
                      <button type="button" onClick={() => setShowNewPass(p => !p)}
                        style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "#94a3b8", fontSize: 14, padding: 0 }}>
                        {showNewPass ? "🙈" : "👁️"}
                      </button>
                    </div>
                  </div>
                </>
              )}

              {err && (
                <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 10, padding: "10px 14px", fontSize: 13, color: "#dc2626", display: "flex", gap: 8, alignItems: "flex-start" }}>
                  <span>⚠️</span><span>{err}</span>
                </div>
              )}
              {info && (
                <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 10, padding: "10px 14px", fontSize: 13, color: "#16a34a", display: "flex", gap: 8, alignItems: "center" }}>
                  <span>✅</span><span>{info}</span>
                </div>
              )}

              <button onClick={submit} disabled={disabled}
                style={{
                  width: "100%", padding: "13px", borderRadius: 10, border: "none", cursor: disabled ? "not-allowed" : "pointer",
                  background: disabled ? "#c7d2fe" : "linear-gradient(135deg, #6366f1, #8b5cf6)",
                  color: "#fff", fontWeight: 700, fontSize: 15, letterSpacing: ".01em",
                  transition: "opacity .15s", opacity: busy ? 0.8 : 1
                }}>
                {busy ? <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><span style={{ width: 14, height: 14, border: "2px solid #fff", borderTopColor: "transparent", borderRadius: "50%", display: "inline-block", animation: "spin 0.7s linear infinite" }} />{buttonText}</span> : buttonText}
              </button>
            </div>

            {/* Footer links */}
            <div style={{ marginTop: 20, textAlign: "center", fontSize: 13, color: "#64748b", display: "flex", flexDirection: "column", gap: 8 }}>
              {mode === "login" && (
                <>
                  <span>Don&apos;t have an account?{" "}
                    <button onClick={() => switchMode("register")} style={{ background: "none", border: "none", color: "#6366f1", cursor: "pointer", fontWeight: 700, fontSize: 13, padding: 0 }}>Register here</button>
                  </span>
                  <button onClick={() => switchMode("forgot")} style={{ background: "none", border: "none", color: "#94a3b8", cursor: "pointer", fontSize: 12, padding: 0 }}>Forgot password?</button>
                </>
              )}
              {mode === "register" && (
                <span>Already have an account?{" "}
                  <button onClick={() => switchMode("login")} style={{ background: "none", border: "none", color: "#6366f1", cursor: "pointer", fontWeight: 700, fontSize: 13, padding: 0 }}>Sign in</button>
                </span>
              )}
              {(mode === "forgot" || mode === "reset") && (
                <>
                  <button onClick={() => switchMode("login")} style={{ background: "none", border: "none", color: "#6366f1", cursor: "pointer", fontWeight: 700, fontSize: 13, padding: 0 }}>← Back to sign in</button>
                  {mode === "reset" && <button onClick={() => switchMode("forgot")} style={{ background: "none", border: "none", color: "#94a3b8", cursor: "pointer", fontSize: 12, padding: 0 }}>Resend OTP</button>}
                </>
              )}
            </div>
          </div>
        </div>
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
