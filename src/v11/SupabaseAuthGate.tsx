import { useEffect, useState } from "react";
import { api } from "../api";
import { supabase } from "../supabase";

type Props = { onSignedIn: (session: any) => void };

/**
 * Auth modes:
 *  login           → standard email + password sign-in
 *  register        → step 1: enter name + email → sends OTP via backend/Brevo
 *  register-verify → step 2: enter 6-digit OTP sent to email
 *  register-setpass→ step 3: set password → account created → auto sign-in
 *  forgot          → enter email → sends password-reset OTP
 *  reset           → enter OTP + new password
 */
type Mode = "login" | "register" | "register-verify" | "register-setpass" | "forgot" | "reset" | "first-setup";

export default function SupabaseAuthGate({ onSignedIn }: Props) {
  const [mode, setMode] = useState<Mode>("login");
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
      // ── REGISTRATION STEP 1 ── Enter name + email, request OTP via backend
      if (mode === "register") {
        const email = form.email.trim().toLowerCase();
        const name = form.name.trim();
        if (!email) throw new Error("Enter your email address.");
        await api("/auth/register/request", { method: "POST", body: JSON.stringify({ email, name }) });
        setForm(p => ({ ...p, email, name, otp: "" }));
        setInfo("A 6-digit verification code was sent to your email.");
        setMode("register-verify");

      // ── REGISTRATION STEP 2 ── Enter OTP
      } else if (mode === "register-verify") {
        const otp = form.otp.trim();
        if (!otp || otp.length !== 6) throw new Error("Enter the 6-digit code from your email.");
        // Just move to the password step; we verify OTP on the server at confirm time
        setInfo("Code accepted. Now set your password.");
        setMode("register-setpass");

      // ── REGISTRATION STEP 3 ── Set password → create account → sign in
      } else if (mode === "register-setpass") {
        const email = form.email.trim().toLowerCase();
        const otp = form.otp.trim();
        const password = form.newPassword;
        const name = form.name.trim();
        if (!password) throw new Error("Enter a password.");
        if (password.length < 6) throw new Error("Password must be at least 6 characters.");
        // Confirm registration on backend: verify OTP + create Supabase user
        await api("/auth/register/confirm", { method: "POST", body: JSON.stringify({ email, otp, password, name }) });
        // Auto sign-in with the new credentials
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        if (data.session) localStorage.setItem("vtab_supabase_token", data.session.access_token);
        setInfo("Account created! Welcome.");
        onSignedIn(data.session);

      // ── FORGOT PASSWORD ──
      } else if (mode === "forgot") {
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

      // ── PASSWORD RESET CONFIRM ──
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
          if (data.session) localStorage.setItem("vtab_supabase_token", data.session.access_token);
          setInfo("Password reset successfully.");
          onSignedIn(data.session);
        } else {
          const { data, error } = await supabase.auth.verifyOtp({ email, token, type: "recovery" });
          if (error) throw error;
          const { error: updateError } = await supabase.auth.updateUser({ password: form.newPassword });
          if (updateError) throw updateError;
          if (data.session) localStorage.setItem("vtab_supabase_token", data.session.access_token);
          setInfo("Password reset successfully.");
          onSignedIn(data.session);
        }

      // ── LOGIN ──
      } else {
        const { data, error } = await supabase.auth.signInWithPassword({ email: form.email, password: form.password });
        if (error) throw error;
        if (data.session) localStorage.setItem("vtab_supabase_token", data.session.access_token);
        onSignedIn(data.session);
      }
    } catch (e: any) {
      const message = e.message || String(e);
      const recoveryEmailFailed = message.includes("Error sending recovery email") || message.includes("HTTP 500") || message.includes("HTTP 504") || message.includes("unexpected_failure");
      setErr(recoveryEmailFailed
        ? "Could not send the OTP email. Check your Brevo API key (BREVO_API_KEY) and verified sender (VTAB_SMTP_FROM) in the server environment."
        : message);
    } finally { setBusy(false); }
  };

  const f = (k: string) => (e: any) => setForm(p => ({ ...p, [k]: e.target.value }));

  // ── Labels ──
  const title: Record<Mode, string> = {
    login: "Welcome back",
    register: "Create account",
    "register-verify": "Check your email",
    "register-setpass": "Set your password",
    forgot: "Reset password",
    reset: "Set Your Password",
  };
  const subtitle: Record<Mode, string> = {
    login: "Sign in to your workspace",
    register: "Enter your name and email to get started",
    "register-verify": `We sent a 6-digit code to ${form.email}`,
    "register-setpass": "Choose a secure password for your new account",
    forgot: "We'll send a 6-digit code to your email",
    reset: "Enter your email, 6-digit OTP, and new password",
  };
  const buttonLabel: Record<Mode, string> = {
    login: "Sign In",
    register: "Send Verification Code",
    "register-verify": "Verify Code",
    "register-setpass": "Create Account",
    forgot: "Send 6-digit OTP",
    reset: "Reset Password",
  };
  const busyLabel: Record<Mode, string> = {
    login: "Signing in…",
    register: "Sending code…",
    "register-verify": "Verifying…",
    "register-setpass": "Creating account…",
    forgot: "Sending OTP…",
    reset: "Resetting password…",
  };

  const isDisabled =
    busy ||
    !form.email ||
    (mode === "login" && !form.password) ||
    (mode === "register-verify" && !form.otp) ||
    (mode === "register-setpass" && !form.newPassword) ||
    (mode === "reset" && (!form.otp || !form.newPassword));

  const switchMode = (m: Mode) => { setErr(""); setInfo(""); setMode(m); };

  const inputStyle: React.CSSProperties = {
    width: "100%", border: "1.5px solid #e2e8f0", borderRadius: 10,
    padding: "11px 14px", fontSize: 14, outline: "none", boxSizing: "border-box", transition: "border .15s",
  };

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "Inter, -apple-system, sans-serif" }}>
      {/* LEFT PANEL */}
      <div style={{
        flex: "0 0 45%", background: "linear-gradient(135deg, #0f172a 0%, #1e1b4b 50%, #0f172a 100%)",
        display: "flex", flexDirection: "column", justifyContent: "center", padding: "60px 64px",
        position: "relative", overflow: "hidden",
      }}>
        <div style={{ position: "absolute", top: -80, right: -80, width: 300, height: 300, borderRadius: "50%", background: "rgba(99,102,241,0.15)", pointerEvents: "none" }} />
        <div style={{ position: "absolute", bottom: -60, left: -60, width: 240, height: 240, borderRadius: "50%", background: "rgba(139,92,246,0.12)", pointerEvents: "none" }} />
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 48 }}>
          <div style={{ width: 40, height: 40, borderRadius: 10, background: "linear-gradient(135deg,#6366f1,#8b5cf6)", display: "grid", placeItems: "center", fontWeight: 900, color: "#fff", fontSize: 18 }}>V</div>
          <span style={{ color: "#e2e8f0", fontWeight: 700, fontSize: 18, letterSpacing: ".02em" }}>VTAB Workspace</span>
        </div>
        <h1 style={{ color: "#f8fafc", fontSize: 36, fontWeight: 800, lineHeight: 1.2, margin: "0 0 16px" }}>Your Analytics<br/>Workspace</h1>
        <p style={{ color: "#94a3b8", fontSize: 16, lineHeight: 1.6, margin: 0 }}>Access, visualize and share powerful reports with your team. All your data, one secure place.</p>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 40 }}>
          {["📊 Interactive reports & dashboards", "🔒 Role-based access control", "⏳ Scheduled data refresh", "👥 Team workspaces"].map(feat => (
            <div key={feat} style={{ display: "flex", alignItems: "center", gap: 10, color: "#cbd5e1", fontSize: 14 }}>{feat}</div>
          ))}
        </div>
      </div>

      {/* RIGHT PANEL */}
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", background: "#f8fafc", padding: 40 }}>
        <div style={{ width: "100%", maxWidth: 420 }}>
          <div style={{ background: "#fff", borderRadius: 20, padding: "40px 36px", boxShadow: "0 4px 32px rgba(15,23,42,.08), 0 1px 4px rgba(15,23,42,.04)" }}>
            <div style={{ width: 48, height: 48, borderRadius: 12, background: "linear-gradient(135deg,#6366f1,#8b5cf6)", display: "grid", placeItems: "center", fontWeight: 900, color: "#fff", fontSize: 22, marginBottom: 20 }}>V</div>

            <h2 style={{ margin: "0 0 4px", fontSize: 24, fontWeight: 800, color: "#0f172a" }}>{title[mode]}</h2>
            <p style={{ margin: "0 0 28px", fontSize: 14, color: "#64748b" }}>{subtitle[mode]}</p>

            {/* Registration step indicator */}
            {(mode === "register" || mode === "register-verify" || mode === "register-setpass") && (
              <div style={{ display: "flex", gap: 6, marginBottom: 24 }}>
                {(["register", "register-verify", "register-setpass"] as Mode[]).map((step, i) => (
                  <div key={step} style={{
                    flex: 1, height: 4, borderRadius: 2,
                    background: mode === step ? "#6366f1" :
                      (["register", "register-verify", "register-setpass"].indexOf(mode) > i ? "#a5b4fc" : "#e2e8f0"),
                  }} />
                ))}
              </div>
            )}

            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>

              {/* Step 1 Register: Name + Email */}
              {mode === "register" && (
                <>
                  <div>
                    <label style={{ fontSize: 12, fontWeight: 600, color: "#374151", display: "block", marginBottom: 6 }}>Full Name</label>
                    <input autoFocus value={form.name} onChange={f("name")} placeholder="Your name"
                      style={inputStyle}
                      onFocus={e => e.target.style.border = "1.5px solid #6366f1"}
                      onBlur={e => e.target.style.border = "1.5px solid #e2e8f0"} />
                  </div>
                  <div>
                    <label style={{ fontSize: 12, fontWeight: 600, color: "#374151", display: "block", marginBottom: 6 }}>Email</label>
                    <input type="email" value={form.email} onChange={f("email")}
                      placeholder="you@example.com" onKeyDown={e => e.key === "Enter" && submit()}
                      style={inputStyle}
                      onFocus={e => e.target.style.border = "1.5px solid #6366f1"}
                      onBlur={e => e.target.style.border = "1.5px solid #e2e8f0"} />
                  </div>
                </>
              )}

              {/* Step 2 Register: OTP */}
              {mode === "register-verify" && (
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: "#374151", display: "block", marginBottom: 6 }}>6-digit verification code</label>
                  <input autoFocus inputMode="numeric" maxLength={6} value={form.otp}
                    onChange={e => setForm(p => ({ ...p, otp: e.target.value.replace(/\D/g, "").slice(0, 6) }))}
                    onKeyDown={e => e.key === "Enter" && submit()} placeholder="123456"
                    style={{ ...inputStyle, fontSize: 26, letterSpacing: "0.35em", textAlign: "center", padding: "11px 14px" }}
                    onFocus={e => e.target.style.border = "1.5px solid #6366f1"}
                    onBlur={e => e.target.style.border = "1.5px solid #e2e8f0"} />
                  <p style={{ fontSize: 12, color: "#94a3b8", marginTop: 8 }}>Didn't get it? Check spam, or <button onClick={() => switchMode("register")} style={{ background: "none", border: "none", color: "#6366f1", cursor: "pointer", fontSize: 12, padding: 0 }}>go back</button> to resend.</p>
                </div>
              )}

              {/* Step 3 Register: Set password */}
              {mode === "register-setpass" && (
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: "#374151", display: "block", marginBottom: 6 }}>Password</label>
                  <div style={{ position: "relative" }}>
                    <input autoFocus type={showNewPass ? "text" : "password"} value={form.newPassword} onChange={f("newPassword")}
                      placeholder="At least 6 characters" onKeyDown={e => e.key === "Enter" && submit()}
                      style={{ ...inputStyle, paddingRight: 40 }}
                      onFocus={e => e.target.style.border = "1.5px solid #6366f1"}
                      onBlur={e => e.target.style.border = "1.5px solid #e2e8f0"} />
                    <button type="button" onClick={() => setShowNewPass(p => !p)}
                      style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "#94a3b8", fontSize: 14, padding: 0 }}>
                      {showNewPass ? "🙈" : "👁️"}
                    </button>
                  </div>
                </div>
              )}

              {/* Login: Email */}
        
      {mode === "first-setup" && (
        <form onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          if (form.newPassword.length < 8) return setError("Password must be at least 8 characters.");
          setBusy(true); setError("");
          try {
            await api("/admin-app/auth/first-login-setup", {
              method: "POST",
              body: JSON.stringify({ email: form.email, otp: form.otp, password: form.newPassword })
            });
            // Auto login after setup
            const { error: sbErr } = await supabase.auth.signInWithPassword({ email: form.email, password: form.newPassword });
            if (sbErr) throw new Error(sbErr.message);
            onSignedIn();
          } catch (err: any) {
            setError(err.message || "Invalid OTP or failed to set password.");
          } finally {
            setBusy(false);
          }
        }} className="flex flex-col gap-4">
          <h2 className="text-xl font-bold text-gray-900 dark:text-white">First-Time Setup</h2>
          <p className="text-sm text-gray-600 dark:text-gray-400">Enter the OTP sent to your email by your administrator.</p>
          
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Email Address</label>
            <input required type="email" value={form.email} onChange={(e) => update({ email: e.target.value })} className="w-full px-3 py-2 border rounded-md" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">OTP</label>
            <input required type="text" placeholder="123456" value={form.otp} onChange={(e) => update({ otp: e.target.value })} className="w-full px-3 py-2 border rounded-md" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">New Password</label>
            <input required type="password" value={form.newPassword} onChange={(e) => update({ newPassword: e.target.value })} className="w-full px-3 py-2 border rounded-md" />
          </div>
          {error && <div className="text-red-600 text-sm">{error}</div>}
          <button disabled={busy} type="submit" className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-2 rounded-md transition-colors disabled:opacity-50">
            {busy ? "Processing..." : "Set Password & Login"}
          </button>
          
          <div className="text-center mt-2">
            <a href="#" className="text-sm font-medium hover:underline text-indigo-600" onClick={(e) => { e.preventDefault(); setMode("login"); }}>
              Back to Login
            </a>
          </div>
        </form>
      )}

      {mode === "login" && (
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: "#374151", display: "block", marginBottom: 6 }}>Email</label>
                  <input autoFocus type="email" value={form.email} onChange={f("email")}
                    placeholder="you@example.com" onKeyDown={e => e.key === "Enter" && submit()}
                    style={inputStyle}
                    onFocus={e => e.target.style.border = "1.5px solid #6366f1"}
                    onBlur={e => e.target.style.border = "1.5px solid #e2e8f0"} />
                </div>
              )}

              {/* Login: Password */}
              {mode === "login" && (
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: "#374151", display: "block", marginBottom: 6 }}>Password</label>
                  <div style={{ position: "relative" }}>
                    <input type={showPass ? "text" : "password"} value={form.password} onChange={f("password")}
                      placeholder="••••••••" onKeyDown={e => e.key === "Enter" && submit()}
                      style={{ ...inputStyle, paddingRight: 40 }}
                      onFocus={e => e.target.style.border = "1.5px solid #6366f1"}
                      onBlur={e => e.target.style.border = "1.5px solid #e2e8f0"} />
                    <button type="button" onClick={() => setShowPass(p => !p)}
                      style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "#94a3b8", fontSize: 14, padding: 0 }}>
                      {showPass ? "🙈" : "👁️"}
                    </button>
                  </div>
                </div>
              )}

              {/* Forgot: Email */}
              {mode === "forgot" && (
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: "#374151", display: "block", marginBottom: 6 }}>Email</label>
                  <input autoFocus type="email" value={form.email} onChange={f("email")}
                    placeholder="you@example.com" onKeyDown={e => e.key === "Enter" && submit()}
                    style={inputStyle}
                    onFocus={e => e.target.style.border = "1.5px solid #6366f1"}
                    onBlur={e => e.target.style.border = "1.5px solid #e2e8f0"} />
                </div>
              )}

              {/* Reset: OTP + New password */}
              {mode === "reset" && (
                <>
                  <div>
                    <label style={{ fontSize: 12, fontWeight: 600, color: "#374151", display: "block", marginBottom: 6 }}>Email</label>
                    <input type="email" value={form.email} onChange={f("email")}
                      placeholder="name@company.com"
                      style={inputStyle}
                      onFocus={e => e.target.style.border = "1.5px solid #6366f1"}
                      onBlur={e => e.target.style.border = "1.5px solid #e2e8f0"} />
                  </div>
                  <div>
                    <label style={{ fontSize: 12, fontWeight: 600, color: "#374151", display: "block", marginBottom: 6 }}>6-digit OTP</label>
                    <input inputMode="numeric" maxLength={6} value={form.otp}
                      onChange={e => setForm(p => ({ ...p, otp: e.target.value.replace(/\D/g, "").slice(0, 6) }))}
                      onKeyDown={e => e.key === "Enter" && submit()} placeholder="123456"
                      style={{ ...inputStyle, fontSize: 20, letterSpacing: "0.3em", textAlign: "center" }}
                      onFocus={e => e.target.style.border = "1.5px solid #6366f1"}
                      onBlur={e => e.target.style.border = "1.5px solid #e2e8f0"} />
                  </div>
                  <div>
                    <label style={{ fontSize: 12, fontWeight: 600, color: "#374151", display: "block", marginBottom: 6 }}>New Password</label>
                    <div style={{ position: "relative" }}>
                      <input type={showNewPass ? "text" : "password"} value={form.newPassword} onChange={f("newPassword")}
                        placeholder="••••••••" onKeyDown={e => e.key === "Enter" && submit()}
                        style={{ ...inputStyle, paddingRight: 40 }}
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

              {/* Error / Info banners */}
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

              {/* Submit button */}
              <button onClick={submit} disabled={isDisabled}
                style={{
                  width: "100%", padding: "13px", borderRadius: 10, border: "none", cursor: isDisabled ? "not-allowed" : "pointer",
                  background: isDisabled ? "#c7d2fe" : "linear-gradient(135deg, #6366f1, #8b5cf6)",
                  color: "#fff", fontWeight: 700, fontSize: 15, letterSpacing: ".01em",
                  transition: "opacity .15s", opacity: busy ? 0.8 : 1,
                }}>
                {busy
                  ? <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                      <span style={{ width: 14, height: 14, border: "2px solid #fff", borderTopColor: "transparent", borderRadius: "50%", display: "inline-block", animation: "spin 0.7s linear infinite" }} />
                      {busyLabel[mode]}
                    </span>
                  : buttonLabel[mode]}
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
                  <button onClick={() => { setResetProvider("backend"); setMode("reset"); setErr(""); setInfo(""); }} style={{ background: "none", border: "none", color: "#6366f1", cursor: "pointer", fontWeight: 600, fontSize: 12, padding: 0 }}>First time login? Set your password with OTP</button>
                </>
              )}
              {(mode === "register" || mode === "register-verify" || mode === "register-setpass") && (
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
