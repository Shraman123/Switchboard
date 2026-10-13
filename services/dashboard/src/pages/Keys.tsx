import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ago, api, type Me } from "../api";

export interface Key {
  id: string;
  name: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  user_email: string;
  user_id: string;
}

export function NewKeyBanner({ created, onClose }: { created: { key: string; mcpUrl: string; name: string }; onClose: () => void }) {
  const claude = `claude mcp add --transport http switchboard ${created.mcpUrl} --header "Authorization: Bearer ${created.key}"`;
  return (
    <div className="card newkey">
      <b>New key "{created.name}". Copy it now: it is stored only as a hash and can't be shown again.</b>
      <code className="secret">{created.key}</code>
      <div className="label">Claude Code</div>
      <code className="block">{claude}</code>
      <div className="label">Cursor / any client (mcp.json)</div>
      <code className="block">
        {JSON.stringify({ mcpServers: { switchboard: { url: created.mcpUrl, headers: { Authorization: `Bearer ${created.key}` } } } }, null, 2)}
      </code>
      <div className="row">
        <button className="ghost" onClick={() => navigator.clipboard?.writeText(created.key)}>
          Copy key
        </button>
        <button className="ghost" onClick={() => navigator.clipboard?.writeText(claude)}>
          Copy Claude Code command
        </button>
        <button className="ghost" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}

export function KeyTable({ keys, onRevoke, showOwner }: { keys: Key[]; onRevoke: (k: Key) => void; showOwner?: boolean }) {
  if (!keys.length) return <p className="muted">No keys yet.</p>;
  return (
    <table>
      <thead>
        <tr>
          <th>Name</th>
          {showOwner && <th>Owner</th>}
          <th>Key</th>
          <th>Created</th>
          <th>Last used</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {keys.map((k) => (
          <tr key={k.id} className={k.revoked_at ? "dim" : ""}>
            <td>{k.name}</td>
            {showOwner && <td>{k.user_email}</td>}
            <td className="mono">{k.prefix}…</td>
            <td>{ago(k.created_at)}</td>
            <td>{ago(k.last_used_at)}</td>
            <td>{k.revoked_at ? <span className="badge disabled">revoked {ago(k.revoked_at)}</span> : <button className="ghost danger" onClick={() => onRevoke(k)}>Revoke</button>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Keys({ me }: { me: Me }) {
  const [keys, setKeys] = useState<Key[]>([]);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<{ key: string; mcpUrl: string; name: string } | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => api<Key[]>("/keys").then(setKeys), []);
  useEffect(() => {
    load();
  }, [load]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      setCreated(await api("/keys", { method: "POST", body: { name } }));
      setName("");
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const revoke = async (k: Key) => {
    if (!confirm(`Revoke "${k.name}"? Clients using it stop working immediately.`)) return;
    await api(`/keys/${k.id}`, { method: "DELETE" });
    load();
  };

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Your API keys</h2>
          <p className="muted">
            A key lets an MCP client act as <b>{me.email}</b> on the gateway at <code>{me.mcpUrl}</code>.
          </p>
        </div>
      </div>
      {created && <NewKeyBanner created={created} onClose={() => setCreated(null)} />}
      <form className="row card" onSubmit={create}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Key name, e.g. laptop-claude-code" required />
        <button>Generate key</button>
      </form>
      {error && <div className="error">{error}</div>}
      <div className="card">
        <KeyTable keys={keys} onRevoke={revoke} />
      </div>
      <ConnectedApps mcpUrl={me.mcpUrl} />
    </section>
  );
}

interface Grant {
  client_id: string;
  client_name: string;
  first_authorized: string;
  last_used: string;
}

// Apps connected with OAuth (browser login) instead of a pasted key.
function ConnectedApps({ mcpUrl }: { mcpUrl: string }) {
  const [grants, setGrants] = useState<Grant[]>([]);
  const load = useCallback(() => api<Grant[]>("/oauth/grants").then(setGrants), []);
  useEffect(() => {
    load();
  }, [load]);
  const revoke = async (g: Grant) => {
    if (!confirm(`Disconnect ${g.client_name}? Its tokens stop working immediately.`)) return;
    await api(`/oauth/grants/${encodeURIComponent(g.client_id)}`, { method: "DELETE" });
    load();
  };
  return (
    <>
      <h3>Connected apps (OAuth)</h3>
      <p className="muted">
        MCP clients that support OAuth need no key: add <code>{mcpUrl}</code> (e.g. <code>claude mcp add --transport http switchboard {mcpUrl}</code>), sign in when the browser
        opens and approve. Access tokens last an hour and refresh on their own.
      </p>
      <div className="card">
        {grants.length === 0 ? (
          <p className="muted">No apps connected.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>App</th>
                <th>Authorized</th>
                <th>Last used</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {grants.map((g) => (
                <tr key={g.client_id}>
                  <td>{g.client_name}</td>
                  <td>{ago(g.first_authorized)}</td>
                  <td>{ago(g.last_used)}</td>
                  <td>
                    <button className="ghost danger" onClick={() => revoke(g)}>
                      Disconnect
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
