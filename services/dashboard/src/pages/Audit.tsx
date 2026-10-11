import { useCallback, useEffect, useState } from "react";
import { api, type Me } from "../api";

interface Entry {
  id: number;
  at: string;
  user_email: string;
  via: "mcp" | "chat";
  server_slug: string | null;
  tool_name: string | null;
  exposed_name: string;
  duration_ms: number;
  outcome: string;
  error: string | null;
}

interface Stat {
  server: string;
  calls: number;
  failures: number;
  p50_ms: number;
  p95_ms: number;
}

export function Audit({ me }: { me: Me }) {
  const [rows, setRows] = useState<Entry[]>([]);
  const [stats, setStats] = useState<Stat[]>([]);
  const [filter, setFilter] = useState({ user: "", server: "", outcome: "" });
  const admin = me.role === "admin";

  const load = useCallback(() => {
    const qs = new URLSearchParams(Object.entries(filter).filter(([, v]) => v)).toString();
    api<Entry[]>(`/audit?${qs}`).then(setRows);
    if (admin) api<Stat[]>("/stats").then(setStats);
  }, [filter, admin]);

  useEffect(() => {
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [load]);

  const users = [...new Set(rows.map((r) => r.user_email))];
  const servers = [...new Set(rows.map((r) => r.server_slug).filter(Boolean))] as string[];

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Audit log</h2>
          <p className="muted">{admin ? "Every tool call through the gateway, by anyone." : "Your tool calls through the gateway."} Updates live.</p>
        </div>
      </div>

      {admin && stats.length > 0 && (
        <div className="stats">
          {stats.map((s) => (
            <div key={s.server} className="card stat">
              <div className="label">{s.server}</div>
              <div className="big">{s.calls}</div>
              <div className="muted small">
                calls · {s.calls ? Math.round((100 * s.failures) / s.calls) : 0}% failed · p50 {s.p50_ms} ms · p95 {s.p95_ms} ms
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="row filters">
        {admin && (
          <select value={filter.user} onChange={(e) => setFilter({ ...filter, user: e.target.value })}>
            <option value="">all users</option>
            {users.map((u) => (
              <option key={u}>{u}</option>
            ))}
          </select>
        )}
        <select value={filter.server} onChange={(e) => setFilter({ ...filter, server: e.target.value })}>
          <option value="">all servers</option>
          {servers.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <select value={filter.outcome} onChange={(e) => setFilter({ ...filter, outcome: e.target.value })}>
          <option value="">all outcomes</option>
          {["ok", "error", "denied", "timeout", "unavailable", "rate_limited"].map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      </div>

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>User</th>
              <th>Via</th>
              <th>Server</th>
              <th>Tool</th>
              <th>Duration</th>
              <th>Outcome</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="nowrap">{new Date(r.at).toLocaleTimeString()}</td>
                <td>{r.user_email}</td>
                <td>
                  <span className={`badge via-${r.via}`}>{r.via === "chat" ? "chat agent" : "MCP client"}</span>
                </td>
                <td>{r.server_slug ?? "—"}</td>
                <td className="mono">{r.tool_name ?? r.exposed_name}</td>
                <td>{r.duration_ms} ms</td>
                <td>
                  <span className={`badge outcome-${r.outcome}`}>{r.outcome}</span>
                  {r.error && <div className="muted small err-text">{r.error}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <p className="muted">No tool calls yet.</p>}
      </div>
    </section>
  );
}
