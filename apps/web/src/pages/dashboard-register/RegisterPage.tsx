import { useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { request, describeError } from "../../api/client.js";
import { useDashboardAuth, writeLastMerchantId } from "../../auth/DashboardAuthContext.js";
import "../../dashboard.css";

export function RegisterPage() {
  const { status, refresh } = useDashboardAuth();
  const navigate = useNavigate();
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [code, setCode] = useState("");
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  if (status === "authenticated") return <Navigate to="/dashboard" replace />;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null); setNotice(null);
    if (!expiresAt && password !== confirmation) { setError("Passwords don't match."); return; }
    setBusy(true);
    try {
      if (!expiresAt) {
        const result = await request<{ otpExpiresAt: string }>("/v1/auth/register", {
          method: "POST", body: JSON.stringify({ displayName, email, password }),
        });
        setExpiresAt(result.otpExpiresAt); setPassword(""); setConfirmation("");
      } else {
        const result = await request<{ merchantId: string }>("/v1/auth/register/verify", {
          method: "POST", body: JSON.stringify({ code }),
        });
        writeLastMerchantId(result.merchantId);
        await refresh();
        navigate("/dashboard", { replace: true });
      }
    } catch (err) { setError(describeError(err)); }
    finally { setBusy(false); }
  }

  async function resend() {
    setBusy(true); setError(null); setNotice(null);
    try {
      await request("/v1/auth/register/resend", { method: "POST" });
      setCode(""); setNotice("A new code has been sent. Check your spam folder too.");
    } catch (err) { setError(describeError(err)); }
    finally { setBusy(false); }
  }

  return <main className="dash-centered"><div className="dash-auth-card">
    <div className="dash-auth-brand"><span className="dash-brand-mark" aria-hidden="true">F</span> FilsPay</div>
    <h1>{expiresAt ? "Verify your email" : "Create your merchant account"}</h1>
    <p className="dash-muted">{expiresAt ? `We sent a six-digit code to ${email.trim()}.` : "Explore your dashboard after email verification. Payment acceptance requires admin approval."}</p>
    {error && <p className="dash-error" role="alert">{error}</p>}
    {notice && <p className="dash-notice" role="status">{notice}</p>}
    <form className="dash-form" onSubmit={(event) => void submit(event)} aria-busy={busy}>
      {expiresAt ? <>
        <p className="dash-muted">Code expires at {new Date(expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.</p>
        <label>Verification code<input autoFocus type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={(event) => setCode(event.target.value)} /></label>
      </> : <>
        <label>Business name<input autoComplete="organization" minLength={2} maxLength={120} required value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
        <label>Email<input type="email" autoComplete="email" maxLength={254} required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
        <label>Password<input type="password" autoComplete="new-password" minLength={12} maxLength={128} aria-describedby="password-help" required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        <p id="password-help" className="dash-muted dash-hint">Use 12–128 characters. You can paste from a password manager.</p>
        <label>Confirm password<input type="password" autoComplete="new-password" minLength={12} maxLength={128} required value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>
      </>}
      <button className="dash-button dash-button-primary" disabled={busy}>{busy ? "Please wait…" : expiresAt ? "Verify email and open dashboard" : "Send verification code"}</button>
      {expiresAt && <>
        <button type="button" className="dash-button" disabled={busy} onClick={() => void resend()}>Resend code</button>
        <button type="button" className="dash-button" disabled={busy} onClick={() => { setExpiresAt(null); setCode(""); setError(null); setNotice(null); }}>Change details</button>
      </>}
    </form>
    <p className="dash-muted">Already have an account? <Link to="/dashboard/login">Sign in</Link></p>
  </div></main>;
}
