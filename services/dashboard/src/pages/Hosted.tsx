import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ago, api } from "../api";

interface Hosted {
  id: string;
  slug: string;
  name: string;
  image: string;
  port: number;
  path: string;
  env: Record<string, string>;
  has_secrets: boolean;
  allow_internet: boolean;
  size: string;
  status: "provisioning" | "ready" | "failed" | "deleting";
  step: string | null;
  reason: string | null;
  attempts: number;
  created_at: string;
  server_status: string | null;
  tool_count: number;
}

const BADGE: Record<Hosted["status"], string> = { provisioning: "warn", ready: "connected", failed: "unreachable", deleting: "warn" };

// "KEY=value" per line -> object
const parseEnv = (text: string) =>
  Object.fromEntries(
    text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1)]),
  );

export function HostedServers() {
  const [data, setData] = useState<{ servers: Hosted[]; imagePrefixes: string[] } | null>(null);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);

  const load = useCallback(() => api("/hosted").then(setData, (e) => setError(e.message)), []);
  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
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

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Hosted MCP servers</h2>
          <p className="muted">
            Add a server by container image instead of URL. The platform runs it in the <code>mcp-hosted</code> namespace as a non-root, read-only pod with fixed
            limits, its own Secret and a NetworkPolicy that admits only the gateway, then registers it. Deleting removes all of it.
          </p>
        </div>
        <button onClick={() => setShowForm(true)}>Deploy from image</button>
      </div>
      {showForm && <HostedForm prefixes={data?.imagePrefixes ?? []} onClose={() => setShowForm(false)} onSaved={load} />}
      {error && <div className="error">{error}</div>}
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Server</th>
              <th>Image</th>
              <th>Status</th>
              <th>Gateway tools</th>
              <th>Created</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data?.servers.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  Nothing deployed yet.
                </td>
              </tr>
            )}
            {data?.servers.map((h) => (
              <tr key={h.id}>
                <td>
                  <b>{h.name}</b>
                  <div className="muted small">
                    {h.size} · port {h.port} · {h.allow_internet ? "internet egress" : "no egress"}
                    {h.has_secrets && " · secrets (encrypted)"}
                  </div>
                </td>
                <td className="mono small">{h.image}</td>
                <td>
                  <span className={`badge ${BADGE[h.status]}`}>{h.status}</span>
                  {h.step && h.status === "provisioning" && <div className="muted small">{h.step}…</div>}
                  {h.reason && <div className={`small ${h.status === "failed" ? "reason" : "muted"}`}>{h.reason}</div>}
                </td>
                <td>
                  {h.status === "ready" ? (
                    <>
                      <code>{h.slug}__*</code>
                      <div className="muted small">
                        {h.tool_count} tools · {h.server_status ?? "checking"}
                      </div>
                    </>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td className="nowrap">{ago(h.created_at)}</td>
                <td>
                  <div className="actions">
                    {h.status === "failed" && (
                      <button className="ghost" onClick={() => act(() => api(`/hosted/${h.id}/retry`, { method: "POST" }))}>
                        Retry
                      </button>
                    )}
                    {h.status !== "deleting" && (
                      <button className="ghost danger" onClick={() => confirm(`Delete ${h.name}?`) && act(() => api(`/hosted/${h.id}`, { method: "DELETE" }))}>
                        Delete
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function HostedForm({ prefixes, onClose, onSaved }: { prefixes: string[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: "", slug: "", image: "", port: 8080, path: "/mcp", env: "", secretEnv: "", allowInternet: false, size: "small" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: k === "port" ? Number(e.target.value) : e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/hosted", {
        method: "POST",
        body: { name: f.name, slug: f.slug, image: f.image, port: f.port, path: f.path, env: parseEnv(f.env), secretEnv: parseEnv(f.secretEnv), allowInternet: f.allowInternet, size: f.size },
      });
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
      <h3>Deploy an MCP server from a container image</h3>
      <div className="grid2">
        <label>
          Name
          <input value={f.name} onChange={set("name")} required placeholder="Reference server" />
        </label>
        <label>
          Slug (tool prefix)
          <input value={f.slug} onChange={set("slug")} required pattern="[a-z][a-z0-9-]{1,20}[a-z0-9]" placeholder="ref" />
        </label>
      </div>
      <label>
        Image
        <input value={f.image} onChange={set("image")} required placeholder={`${prefixes[0] ?? ""}org/server:1.0.0`} />
        {prefixes.length > 0 && <span className="muted small">Allowed registries: {prefixes.join(", ")}</span>}
      </label>
      <div className="grid2">
        <label>
          Container port (Streamable HTTP)
          <input type="number" min={1024} max={65535} value={f.port} onChange={set("port")} />
        </label>
        <label>
          MCP path
          <input value={f.path} onChange={set("path")} />
        </label>
      </div>
      <div className="grid2">
        <label>
          Environment (KEY=value per line)
          <textarea rows={3} value={f.env} onChange={set("env")} placeholder="LOG_LEVEL=info" />
        </label>
        <label>
          Secret environment (stored encrypted, mounted from a Secret)
          <textarea rows={3} value={f.secretEnv} onChange={set("secretEnv")} placeholder="API_TOKEN=..." autoComplete="off" />
        </label>
      </div>
      <div className="row">
        <label className="check">
          <input type="checkbox" checked={f.allowInternet} onChange={(e) => setF({ ...f, allowInternet: e.target.checked })} />
          allow outbound internet (never private ranges)
        </label>
        <label className="check">
          size
          <select value={f.size} onChange={set("size")}>
            <option value="small">small (250m / 256Mi)</option>
            <option value="medium">medium (500m / 512Mi)</option>
          </select>
        </label>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="row">
        <button disabled={busy}>{busy ? "Submitting…" : "Deploy"}</button>
        <button type="button" className="ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}
