import { useEffect, useState } from "react";
import { api, type Me } from "../api";

// OAuth consent: an MCP client sent the user here (via /oauth/authorize) to
// approve access. Approving issues a one-time code back to the app.
export function Consent({ me }: { me: Me }) {
  const request = new URLSearchParams(location.search).get("request") ?? "";
  const [info, setInfo] = useState<{ clientName: string; redirectHost: string; resource: string } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api(`/oauth/request?request=${encodeURIComponent(request)}`).then(setInfo, (e) => setError(e.message));
  }, [request]);

  const decide = async (approve: boolean) => {
    setBusy(true);
    try {
      const { redirectTo } = await api<{ redirectTo: string }>("/oauth/decision", { method: "POST", body: { request, approve } });
      location.href = redirectTo;
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="center">
      <div className="card auth">
        <h2>Connect an app</h2>
        {error && <div className="error">{error}</div>}
        {info && (
          <>
            <p>
              <b>{info.clientName}</b> wants to use the Switchboard gateway as <b>{me.email}</b>.
            </p>
            <ul className="muted small">
              <li>It can list and call the tools you can use ({me.role}), and nothing else.</li>
              <li>Every call is audited under your name.</li>
              <li>It never sees upstream credentials. Disconnect it any time under API keys.</li>
            </ul>
            <p className="muted small">
              You will be sent back to <code>{info.redirectHost}</code>.
            </p>
            <div className="row">
              <button disabled={busy} onClick={() => decide(true)}>
                Allow
              </button>
              <button disabled={busy} className="ghost" onClick={() => decide(false)}>
                Deny
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
