import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ago, api, type Me, type Server } from "../api";

const STATUS_LABEL: Record<string, string> = {
  connected: "Connected",
  unreachable: "Unreachable",
  disabled: "Disabled",
  unknown: "Checking…",
};

export function Servers({ me }: { me: Me }) {
  const [servers, setServers] = useState<Server[]>([]);
  const [editing, setEditing] = useState<Server | "new" | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [error, setError] = useState("");
  const admin = me.role === "admin";

  const load = useCallback(() => api<Server[]>("/servers").then(setServers, (e) => setError(e.message)), []);
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    }
    load();
  };

  const visible = servers.reduce((n, s) => n + (s.status === "connected" ? s.tools.filter((t) => t.availableToMe && !t.hidden && !t.pendingReview).length : 0), 0);

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>MCP servers</h2>
          <p className="muted">
            {servers.length} registered · {visible} tools available to you through one endpoint
          </p>
        </div>
        {admin && <button onClick={() => setEditing("new")}>Add server</button>}
      </div>

      <div className="card endpoint">
        <div>
          <div className="label">Gateway endpoint</div>
          <code>{me.mcpUrl}</code>
        </div>
        <div className="muted small">
          Add this URL with your API key (header <code>Authorization: Bearer sbk_…</code>) to Claude Code, Cursor or MCP Inspector. You never need the upstream servers' credentials.
        </div>
      </div>

      {error && <div className="error">{error}</div>}
      {editing && <ServerForm server={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={load} />}

      <div className="servers">
        {servers.map((s) => (
          <div key={s.id} className={`card server ${s.status}`}>
            <div className="server-head">
              <div>
                <div className="server-title">
                  <span className={`dot ${s.status}`} />
                  <b>{s.name}</b>
                  <code className="slug">{s.slug}__*</code>
                  <span className={`badge ${s.status}`}>{STATUS_LABEL[s.status] ?? s.status}</span>
                  {s.managedBy && <span className="badge">{s.managedBy === "store" ? "provisioned store" : "hosted"}</span>}
                </div>
                <div className="muted small">
                  {admin && s.url && <span className="mono">{s.url}</span>}
                  {admin && " · "}
                  auth: {s.authType === "none" ? "none" : `${s.authType}${s.authHeaderName ? ` (${s.authHeaderName})` : ""} · credential ${s.hasCredential ? "stored (encrypted)" : "missing"}`}
                  {" · "}timeout {s.timeoutMs / 1000}s · checked {ago(s.lastCheckedAt)}
                </div>
                {s.status === "unreachable" && s.statusReason && (
                  <div className="reason">
                    ⚠ {s.statusReason} {s.lastOkAt && <span className="muted">(last OK {ago(s.lastOkAt)})</span>}
                  </div>
                )}
              </div>
              {admin && (
                <div className="actions">
                  <button className="ghost" onClick={() => act(() => api(`/servers/${s.id}/refresh`, { method: "POST" }))}>
                    Check now
                  </button>
                  {!s.managedBy && (
                    <button className="ghost" onClick={() => setEditing(s)}>
                      Edit
                    </button>
                  )}
                  <button className="ghost" onClick={() => act(() => api(`/servers/${s.id}`, { method: "PATCH", body: { enabled: !s.enabled } }))}>
                    {s.enabled ? "Disable" : "Enable"}
                  </button>
                  {!s.managedBy && (
                    <button
                      className="ghost danger"
                      onClick={() => confirm(`Remove ${s.name}? Its tools disappear for everyone.`) && act(() => api(`/servers/${s.id}`, { method: "DELETE" }))}
                    >
                      Remove
                    </button>
                  )}
                </div>
              )}
            </div>

            {s.tools.some((t) => t.pendingReview) && (
              <div className="review">
                <b>Tool definitions changed upstream.</b> {s.tools.filter((t) => t.pendingReview).length} tool(s) are held back until an admin reviews them
                (protects against a server silently rewriting descriptions to steer the model).
                {admin && (
                  <button className="small-btn" onClick={() => act(() => api(`/servers/${s.id}/approve-tools`, { method: "POST" }))}>
                    Approve current definitions
                  </button>
                )}
              </div>
            )}

            <button className="link" onClick={() => setOpen({ ...open, [s.id]: !open[s.id] })}>
              {open[s.id] ? "▾" : "▸"} {s.tools.length} tools
            </button>
            {open[s.id] && (
              <table className="tools">
                <thead>
                  <tr>
                    <th>Exposed as</th>
                    <th>Description</th>
                    <th>Access</th>
                  </tr>
                </thead>
                <tbody>
                  {s.tools.map((t) => (
                    <tr key={t.name} className={t.hidden || !t.availableToMe ? "dim" : ""}>
                      <td className="mono">
                        {t.exposedName}
                        {t.pendingReview && <span className="badge warn">changed</span>}
                      </td>
                      <td className="desc">{t.description}</td>
                      <td className="access">
                        {admin ? (
                          <>
                            <label className="check">
                              <input
                                type="checkbox"
                                checked={t.adminOnly}
                                onChange={(e) => act(() => api(`/servers/${s.id}/tools/${encodeURIComponent(t.name)}/policy`, { method: "PUT", body: { adminOnly: e.target.checked, hidden: t.hidden } }))}
                              />
                              admins only
                            </label>
                            <label className="check">
                              <input
                                type="checkbox"
                                checked={t.hidden}
                                onChange={(e) => act(() => api(`/servers/${s.id}/tools/${encodeURIComponent(t.name)}/policy`, { method: "PUT", body: { adminOnly: t.adminOnly, hidden: e.target.checked } }))}
                              />
                              hidden
                            </label>
                          </>
                        ) : t.availableToMe ? (
                          "you"
                        ) : (
                          "admins only"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function ServerForm({ server, onClose, onSaved }: { server: Server | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    name: server?.name ?? "",
    slug: server?.slug ?? "",
    url: server?.url ?? "",
    authType: server?.authType ?? "none",
    authHeaderName: server?.authHeaderName ?? "X-API-Key",
    credential: "",
    timeoutMs: server?.timeoutMs ?? 15000,
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: k === "timeoutMs" ? Number(e.target.value) : e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    const body: Record<string, unknown> = { name: f.name, slug: f.slug, url: f.url, authType: f.authType, timeoutMs: f.timeoutMs };
    if (f.authType === "header") body.authHeaderName = f.authHeaderName;
    if (f.credential) body.credential = f.credential;
    try {
      if (server) await api(`/servers/${server.id}`, { method: "PATCH", body });
      else await api("/servers", { method: "POST", body });
      onSaved();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card form" onSubmit={submit}>
      <h3>{server ? `Edit ${server.name}` : "Add an MCP server"}</h3>
      <div className="grid2">
        <label>
          Name
          <input value={f.name} onChange={set("name")} required placeholder="Shipping tracker" />
        </label>
        <label>
          Slug (tool prefix)
          <input value={f.slug} onChange={set("slug")} required pattern="[a-z][a-z0-9-]{1,23}" placeholder="shipping" />
        </label>
      </div>
      <label>
        Streamable HTTP URL
        <input value={f.url} onChange={set("url")} required placeholder="https://mcp.example.com/mcp" />
      </label>
      <div className="grid2">
        <label>
          Authentication
          <select value={f.authType} onChange={set("authType")}>
            <option value="none">None</option>
            <option value="bearer">Bearer token</option>
            <option value="header">Custom header</option>
          </select>
        </label>
        <label>
          Timeout (ms)
          <input type="number" min={1000} max={120000} value={f.timeoutMs} onChange={set("timeoutMs")} />
        </label>
      </div>
      {f.authType === "header" && (
        <label>
          Header name
          <input value={f.authHeaderName} onChange={set("authHeaderName")} />
        </label>
      )}
      {f.authType !== "none" && (
        <label>
          Credential {server?.hasCredential && <span className="muted">(stored; leave empty to keep it)</span>}
          <input type="password" value={f.credential} onChange={set("credential")} autoComplete="off" required={!server?.hasCredential} />
          <span className="muted small">Encrypted at rest. It is only ever sent to this server, never shown again or passed to members.</span>
        </label>
      )}
      {error && <div className="error">{error}</div>}
      <div className="row">
        <button disabled={busy}>{busy ? "Connecting…" : server ? "Save" : "Add and connect"}</button>
        <button type="button" className="ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}
