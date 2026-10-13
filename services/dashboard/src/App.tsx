import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type Me } from "./api";
import { Login, AcceptInvite } from "./pages/Auth";
import { Servers } from "./pages/Servers";
import { Chat } from "./pages/Chat";
import { Keys } from "./pages/Keys";
import { Members } from "./pages/Members";
import { Audit } from "./pages/Audit";
import { Stores } from "./pages/Stores";
import { HostedServers } from "./pages/Hosted";
import { Consent } from "./pages/Consent";

type Tab = "servers" | "stores" | "hosted" | "chat" | "keys" | "members" | "audit";

const TABS: { id: Tab; label: string; admin?: boolean; provisioning?: boolean }[] = [
  { id: "servers", label: "Servers" },
  { id: "stores", label: "Stores", provisioning: true },
  { id: "hosted", label: "Hosted", admin: true, provisioning: true },
  { id: "chat", label: "Chat" },
  { id: "keys", label: "API keys" },
  { id: "members", label: "Members", admin: true },
  { id: "audit", label: "Audit log" },
];

const tabFromHash = (): Tab => {
  const h = location.hash.slice(1) as Tab;
  return TABS.some((t) => t.id === h) ? h : "servers";
};

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [tab, setTab] = useState<Tab>(tabFromHash);

  const load = useCallback(async () => {
    try {
      setMe(await api<Me>("/me"));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setMe(null);
      else throw err;
    }
  }, []);

  useEffect(() => {
    load();
    const onHash = () => setTab(tabFromHash());
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, [load]);

  const invite = location.pathname.match(/^\/invite\/([\w-]+)/)?.[1];
  if (invite)
    return (
      <AcceptInvite
        token={invite}
        onDone={() => {
          history.replaceState(null, "", "/");
          load();
        }}
      />
    );
  if (me === undefined) return <div className="center muted">Loading…</div>;
  if (me === null) return <Login onLogin={load} />;
  if (location.pathname === "/consent") return <Consent me={me} />;

  const logout = async () => {
    await api("/auth/logout", { method: "POST" });
    setMe(null);
  };

  return (
    <div className="shell">
      <header className="top">
        <div className="brand">
          <span className="logo" aria-hidden>
            ≡
          </span>
          Switchboard
          <span className="tag">team MCP gateway</span>
        </div>
        <nav>
          {TABS.filter((t) => (!t.admin || me.role === "admin") && (!t.provisioning || me.provisioningEnabled)).map((t) => (
            <a key={t.id} href={`#${t.id}`} className={tab === t.id ? "active" : ""}>
              {t.label}
            </a>
          ))}
        </nav>
        <div className="who">
          <span>
            {me.name || me.email} <span className={`role ${me.role}`}>{me.role}</span>
          </span>
          <button className="ghost" onClick={logout}>
            Sign out
          </button>
        </div>
      </header>
      <main>
        {tab === "servers" && <Servers me={me} />}
        {tab === "stores" && me.provisioningEnabled && <Stores me={me} />}
        {tab === "hosted" && me.provisioningEnabled && me.role === "admin" && <HostedServers />}
        {tab === "chat" && <Chat me={me} />}
        {tab === "keys" && <Keys me={me} />}
        {tab === "members" && me.role === "admin" && <Members me={me} />}
        {tab === "audit" && <Audit me={me} />}
      </main>
    </div>
  );
}
