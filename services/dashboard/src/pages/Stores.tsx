import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ago, api, type Me } from "../api";

interface Store {
  id: string;
  slug: string;
  name: string;
  namespace: string;
  status: "provisioning" | "ready" | "failed" | "deleting";
  step: string | null;
  reason: string | null;
  url: string | null;
  attempts: number;
  created_at: string;
  ready_at: string | null;
  owner_email: string | null;
  server_status: string | null;
  tool_count: number;
}

const LABEL: Record<Store["status"], string> = { provisioning: "Provisioning", ready: "Ready", failed: "Failed", deleting: "Deleting" };
const BADGE: Record<Store["status"], string> = { provisioning: "warn", ready: "connected", failed: "unreachable", deleting: "warn" };

export function Stores({ me }: { me: Me }) {
  const [data, setData] = useState<{ stores: Store[]; limits: { perUser: number; total: number; timeoutMinutes: number } } | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api("/stores").then(setData, (e) => setError(e.message)), []);
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

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    await act(() => api("/stores", { method: "POST", body: { name } }));
    setName("");
    setBusy(false);
  };

  const mine = data?.stores.filter((s) => s.owner_email === me.email).length ?? 0;

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Stores</h2>
          <p className="muted">
            Each store runs in its own namespace with its own database, volumes, Secrets and Ingress, and its own WooCommerce MCP server registered in the gateway automatically.
            {data && ` Limit ${data.limits.perUser} per user (you have ${mine}); provisioning times out after ${data.limits.timeoutMinutes} min.`}
          </p>
        </div>
      </div>

      <form className="card row" onSubmit={create}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New store name, e.g. Howrah Bakery" minLength={2} maxLength={60} required />
        <button disabled={busy}>{busy ? "Creating…" : "Create store"}</button>
      </form>

      {error && <div className="error">{error}</div>}

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Store</th>
              <th>Status</th>
              <th>URL</th>
              <th>Gateway tools</th>
              <th>Created</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data?.stores.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  No provisioned stores yet. The main demo store is always on the Servers page as <code>woo__*</code>.
                </td>
              </tr>
            )}
            {data?.stores.map((s) => (
              <tr key={s.id}>
                <td>
                  <b>{s.name}</b>
                  <div className="muted small mono">
                    {s.namespace}
                    {me.role === "admin" && s.owner_email && ` · ${s.owner_email}`}
                  </div>
                </td>
                <td>
                  <span className={`badge ${BADGE[s.status]}`}>{LABEL[s.status]}</span>
                  {s.step && s.status !== "ready" && s.status !== "failed" && <div className="muted small">{s.step}…</div>}
                  {s.reason && <div className={`small ${s.status === "failed" ? "reason" : "muted"}`}>{s.reason}</div>}
                  {s.attempts > 1 && <div className="muted small">attempt {s.attempts}</div>}
                </td>
                <td>{s.url && s.status === "ready" ? <a href={s.url} target="_blank" rel="noreferrer">{s.url.replace(/^https?:\/\//, "")}</a> : <span className="muted">—</span>}</td>
                <td>
                  {s.status === "ready" ? (
                    <>
                      <code>{s.slug}__*</code>
                      <div className="muted small">
                        {s.tool_count} tools · {s.server_status ?? "checking"}
                      </div>
                    </>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td className="nowrap">{ago(s.created_at)}</td>
                <td>
                  <div className="actions">
                    {s.status === "failed" && (
                      <button className="ghost" onClick={() => act(() => api(`/stores/${s.id}/retry`, { method: "POST" }))}>
                        Retry
                      </button>
                    )}
                    {s.status !== "deleting" && (
                      <button
                        className="ghost danger"
                        onClick={() =>
                          confirm(`Delete ${s.name}? Its namespace, database, volumes, Secrets and gateway tools are removed permanently.`) &&
                          act(() => api(`/stores/${s.id}`, { method: "DELETE" }))
                        }
                      >
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
