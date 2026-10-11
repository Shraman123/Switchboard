import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api";

export function Login({ onLogin }: { onLogin: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/auth/login", { method: "POST", body: { email, password } });
      onLogin();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center">
      <form className="card auth" onSubmit={submit}>
        <h1>Switchboard</h1>
        <p className="muted">One MCP endpoint for every tool your team uses.</p>
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && <div className="error">{error}</div>}
        <button disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
      </form>
    </div>
  );
}

export function AcceptInvite({ token, onDone }: { token: string; onDone: () => void }) {
  const [invite, setInvite] = useState<{ email: string; role: string } | null>(null);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");

  useEffect(() => {
    api(`/auth/invite/${token}`).then(setInvite, (e) => setError(e.message));
  }, [token]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api("/auth/accept-invite", { method: "POST", body: { token, name, password } });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="center">
      <form className="card auth" onSubmit={submit}>
        <h1>Join your team</h1>
        {invite ? (
          <p className="muted">
            You were invited as <b>{invite.email}</b> ({invite.role}).
          </p>
        ) : (
          !error && <p className="muted">Checking invite…</p>
        )}
        {invite && (
          <>
            <label>
              Your name
              <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
            </label>
            <label>
              Choose a password (10+ characters)
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={10} required />
            </label>
            <button>Create account</button>
          </>
        )}
        {error && <div className="error">{error}</div>}
      </form>
    </div>
  );
}
