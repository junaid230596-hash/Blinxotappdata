import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { ApiError, post } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useSeo } from "../lib/seo";
import { Button, Card, Logo, TextField } from "../components/ui";

function AuthLayout({ title, children }: { title: string; children: ReactNode }) {
  useSeo({ title, noindex: true });
  return (
    <div className="auth">
      <div className="auth-card">
        <Link to="/" className="brand"><Logo size={36} /><span>Blinxot</span></Link>
        <Card><h1>{title}</h1>{children}</Card>
      </div>
    </div>
  );
}
const fieldErrors = (e: unknown): Record<string, string> => (e instanceof ApiError && e.details && typeof e.details === "object" ? e.details : {});
const msg = (e: unknown) => (e instanceof ApiError ? e.message : "Something went wrong. Please try again.");

// Signed-in visitors skip the guest pages. When they just logged in, honour the page they originally asked for
// (otherwise this guard wins the race against the login form's own redirect and always lands on the dashboard).
export function GuestOnly({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth(); const loc = useLocation();
  if (loading) return null;
  return user ? <Navigate to={(loc.state as { from?: string } | null)?.from ?? "/app"} replace /> : <>{children}</>;
}

export function Login() {
  const { login } = useAuth(); const nav = useNavigate(); const loc = useLocation();
  const [email, setEmail] = useState(""); const [password, setPassword] = useState("");
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError("");
    try { await login(email.trim(), password); nav((loc.state as any)?.from ?? "/app", { replace: true }); }
    catch (err) { setError(msg(err)); } finally { setBusy(false); }
  };
  return (
    <AuthLayout title="Log in">
      <form className="stack" onSubmit={submit} noValidate>
        {error && <div className="banner error" role="alert">{error}</div>}
        <TextField label="Email" type="email" autoComplete="email" inputMode="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <TextField label="Password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        <Button type="submit" variant="primary" loading={busy}>Log in</Button>
        <p className="small"><Link to="/forgot-password">Forgot your password?</Link></p>
        <p className="small muted">New to Blinxot? <Link to="/register">Create an account</Link></p>
      </form>
    </AuthLayout>
  );
}

const TYPES = [
  ["individual", "Individual", "Build a work profile, find jobs and track applications."],
  ["business_owner", "Business owner", "Run inventory, orders, people and customers in one place."],
  ["supplier", "Supplier", "List products and receive orders from other businesses."],
] as const;

export function Register() {
  const { register } = useAuth();
  const [f, setF] = useState({ fullName: "", email: "", password: "", accountType: "individual" });
  const [errors, setErrors] = useState<Record<string, string>>({}); const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const [done, setDone] = useState(false);
  const set = (k: string) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(""); setErrors({});
    try { await register({ ...f, email: f.email.trim() }); setDone(true); }
    catch (err) { setErrors(fieldErrors(err)); setError(msg(err)); } finally { setBusy(false); }
  };
  if (done) return (
    <AuthLayout title="Check your email">
      <p>We sent a verification link to <strong>{f.email}</strong>. Open it to confirm your address, then log in.</p>
      <Link className="btn btn-primary" to="/login">Go to log in</Link>
    </AuthLayout>
  );
  return (
    <AuthLayout title="Create your account">
      <form className="stack" onSubmit={submit} noValidate>
        {error && <div className="banner error" role="alert">{error}</div>}
        <fieldset className="choice" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="small" style={{ fontWeight: 600, marginBottom: 6 }}>I am a…</legend>
          {TYPES.map(([v, l, d]) => (
            <label key={v}><input type="radio" name="accountType" value={v} checked={f.accountType === v} onChange={set("accountType")} /><span><strong>{l}</strong><br /><span className="small muted">{d}</span></span></label>
          ))}
        </fieldset>
        <TextField label="Full name" autoComplete="name" required value={f.fullName} onChange={set("fullName")} error={errors.fullName} />
        <TextField label="Email" type="email" autoComplete="email" inputMode="email" required value={f.email} onChange={set("email")} error={errors.email} />
        <TextField label="Password" type="password" autoComplete="new-password" required value={f.password} onChange={set("password")} error={errors.password} hint="At least 10 characters, with letters and numbers." />
        <Button type="submit" variant="primary" loading={busy}>Create account</Button>
        <p className="small muted">Already registered? <Link to="/login">Log in</Link></p>
      </form>
    </AuthLayout>
  );
}

export function Forgot() {
  const [email, setEmail] = useState(""); const [sent, setSent] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError("");
    try { await post("/api/auth/forgot-password", { email: email.trim() }); setSent(true); } catch (err) { setError(msg(err)); } finally { setBusy(false); }
  };
  return (
    <AuthLayout title="Reset your password">
      {sent ? <><p>If that email is registered, a reset link is on its way. It expires in one hour.</p><Link to="/login">Back to log in</Link></> : (
        <form className="stack" onSubmit={submit} noValidate>
          {error && <div className="banner error" role="alert">{error}</div>}
          <TextField label="Email" type="email" autoComplete="email" inputMode="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          <Button type="submit" variant="primary" loading={busy}>Send reset link</Button>
          <Link to="/login" className="small">Back to log in</Link>
        </form>
      )}
    </AuthLayout>
  );
}

export function Reset() {
  const [params] = useSearchParams(); const token = params.get("token") ?? ""; const invited = params.get("invite") === "1";
  const [password, setPassword] = useState(""); const [done, setDone] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [errors, setErrors] = useState<Record<string, string>>({});
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(""); setErrors({});
    try { await post("/api/auth/reset-password", { token, password }); setDone(true); } catch (err) { setErrors(fieldErrors(err)); setError(msg(err)); } finally { setBusy(false); }
  };
  const title = invited ? "Set your password" : "Choose a new password";
  if (!token) return <AuthLayout title="Link not valid"><p>This link is missing its token. Request a new one.</p><Link to="/forgot-password">Reset password</Link></AuthLayout>;
  return (
    <AuthLayout title={title}>
      {done ? <><p>Your password is saved. You can now log in.</p><Link className="btn btn-primary" to="/login">Log in</Link></> : (
        <form className="stack" onSubmit={submit} noValidate>
          {error && <div className="banner error" role="alert">{error}</div>}
          <TextField label="New password" type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} error={errors.password} hint="At least 10 characters, with letters and numbers." />
          <Button type="submit" variant="primary" loading={busy}>Save password</Button>
        </form>
      )}
    </AuthLayout>
  );
}

export function VerifyEmail() {
  const [params] = useSearchParams(); const token = params.get("token");
  const [state, setState] = useState<"working" | "ok" | "bad">(token ? "working" : "bad"); const { refreshUser, user } = useAuth(); const ran = useRef(false);
  useEffect(() => {
    if (!token || ran.current) return; ran.current = true;           // tokens are single-use: never submit twice (React strict mode)
    post("/api/auth/verify-email", { token }).then(() => { setState("ok"); return user ? refreshUser() : undefined; }).catch(() => setState("bad"));
  }, [token, refreshUser, user]);
  return (
    <AuthLayout title={state === "ok" ? "Email verified" : state === "bad" ? "Link not valid" : "Verifying…"}>
      {state === "working" && <p role="status">Checking your link…</p>}
      {state === "ok" && <><p>Thanks, your email address is confirmed.</p><Link className="btn btn-primary" to={user ? "/app" : "/login"}>Continue</Link></>}
      {state === "bad" && <><p>This verification link is invalid or has expired. Log in and choose “Resend email”.</p><Link to="/login">Go to log in</Link></>}
    </AuthLayout>
  );
}
