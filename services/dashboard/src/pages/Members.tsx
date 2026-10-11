import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, type Me } from "../api";
import { KeyTable, NewKeyBanner, type Key } from "./Keys";

interface Member {
  id: string;
  email: string;
  name: string;
  role: "admin" | "member";
  status: "invited" | "active" | "disabled";
  active_keys: number;
}

export function Members({ me }: { me: Me }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [keys, setKeys] = useState<Key[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [inviteUrl, setInviteUrl] = useState("");
  const [created, setCreated] = useState<{ key: string; mcpUrl: string; name: string } | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api<Member[]>("/users").then(setMembers);
    api<Key[]>("/keys?all=1").then(setKeys);
  }, []);
  useEffect(() => {
    load();
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

  const invite = (e: FormEvent) => {
    e.preventDefault();
    act(async () => {
      const r = await api<{ inviteUrl: string }>("/users/invite", { method: "POST", body: { email, role } });
      setInviteUrl(r.inviteUrl);
      setEmail("");
    });
  };

  const issueKey = (m: Member) =>
    act(async () => {
      const name = prompt(`Key name for ${m.email}`, "issued-by-admin");
      if (name) setCreated(await api("/keys", { method: "POST", body: { name, userId: m.id } }));
    });

  return (
    <section>
      <div className="section-head">
        <div>
          <h2>Team members</h2>
          <p className="muted">Admins manage servers, members and keys. Members use tools (subject to per-tool restrictions).</p>
        </div>
      </div>

      <form className="row card" onSubmit={invite}>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@company.com" required />
        <select value={role} onChange={(e) => setRole(e.target.value as "member" | "admin")}>
          <option value="member">member</option>
          <option value="admin">admin</option>
        </select>
        <button>Invite</button>
      </form>
      {inviteUrl && (
        <div className="card newkey">
          <b>Invite link (valid 7 days). Send it to your teammate:</b>
          <code className="block">{inviteUrl}</code>
          <div className="row">
            <button className="ghost" onClick={() => navigator.clipboard?.writeText(inviteUrl)}>
              Copy link
            </button>
            <button className="ghost" onClick={() => setInviteUrl("")}>
              Done
            </button>
          </div>
        </div>
      )}
      {created && <NewKeyBanner created={created} onClose={() => setCreated(null)} />}
      {error && <div className="error">{error}</div>}

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Member</th>
              <th>Role</th>
              <th>Status</th>
              <th>Active keys</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id} className={m.status !== "active" ? "dim" : ""}>
                <td>
                  {m.name || <span className="muted">(pending)</span>}
                  <div className="muted small">{m.email}</div>
                </td>
                <td>
                  {m.id === me.id || m.status === "invited" ? (
                    <span className={`role ${m.role}`}>{m.role}</span>
                  ) : (
                    <select value={m.role} onChange={(e) => act(() => api(`/users/${m.id}`, { method: "PATCH", body: { role: e.target.value } }))}>
                      <option value="member">member</option>
                      <option value="admin">admin</option>
                    </select>
                  )}
                </td>
                <td>{m.status}</td>
                <td>{m.active_keys}</td>
                <td className="actions">
                  {m.status === "active" && (
                    <button className="ghost" onClick={() => issueKey(m)}>
                      Issue key
                    </button>
                  )}
                  {m.id !== me.id && m.status !== "invited" && (
                    <button className="ghost" onClick={() => act(() => api(`/users/${m.id}`, { method: "PATCH", body: { status: m.status === "active" ? "disabled" : "active" } }))}>
                      {m.status === "active" ? "Disable" : "Enable"}
                    </button>
                  )}
                  {m.id !== me.id && (
                    <button className="ghost danger" onClick={() => confirm(`Remove ${m.email}?`) && act(() => api(`/users/${m.id}`, { method: "DELETE" }))}>
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3>All API keys</h3>
      <div className="card">
        <KeyTable
          keys={keys}
          showOwner
          onRevoke={(k) => confirm(`Revoke ${k.user_email}'s key "${k.name}"?`) && act(() => api(`/keys/${k.id}`, { method: "DELETE" }))}
        />
      </div>
    </section>
  );
}
