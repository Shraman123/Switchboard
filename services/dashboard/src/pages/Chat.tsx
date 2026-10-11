import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, type Me } from "../api";

interface Step {
  tool: string;
  arguments: unknown;
  result: string;
  isError: boolean;
  ms: number;
}
interface Turn {
  role: "user" | "assistant";
  content: string;
  steps?: Step[];
  error?: boolean;
}

const EXAMPLES = [
  "Create a product called Nolen Gur Sandesh priced at 350",
  "What orders came in today?",
  "Summarise today's orders and save the summary as a team note tagged daily-report",
];

const STORAGE_KEY = "switchboard.chat";

export function Chat({ me }: { me: Me }) {
  const [turns, setTurns] = useState<Turn[]>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(`${STORAGE_KEY}.${me.id}`) ?? "[]");
    } catch {
      return [];
    }
  });
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      sessionStorage.setItem(`${STORAGE_KEY}.${me.id}`, JSON.stringify(turns.slice(-30)));
    } catch {
      /* storage unavailable: chat still works */
    }
    end.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns, me.id]);

  const send = async (text: string) => {
    if (!text.trim() || busy) return;
    const next: Turn[] = [...turns, { role: "user", content: text }];
    setTurns(next);
    setInput("");
    setBusy(true);
    try {
      const history = next.filter((t) => !t.error).map(({ role, content }) => ({ role, content }));
      const r = await api<{ reply: string; steps: Step[] }>("/chat", { method: "POST", body: { messages: history } });
      setTurns([...next, { role: "assistant", content: r.reply, steps: r.steps }]);
    } catch (err) {
      setTurns([...next, { role: "assistant", content: (err as Error).message, error: true }]);
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    send(input);
  };

  return (
    <section className="chat">
      <div className="section-head">
        <div>
          <h2>Chat agent</h2>
          <p className="muted">
            Answers with the gateway's tools, acting as <b>{me.email}</b>. Every tool call is in the audit log under your name and limited by your role.
          </p>
        </div>
        {turns.length > 0 && (
          <button className="ghost" onClick={() => setTurns([])}>
            New chat
          </button>
        )}
      </div>
      {!me.chatEnabled && <div className="error">No LLM API key is configured for the chat agent (gateway-secrets → llm-api-key).</div>}

      <div className="messages card">
        {turns.length === 0 && (
          <div className="examples">
            <p className="muted">Try:</p>
            {EXAMPLES.map((e) => (
              <button key={e} className="ghost example" onClick={() => send(e)}>
                {e}
              </button>
            ))}
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className={`msg ${t.role} ${t.error ? "err" : ""}`}>
            {t.steps && t.steps.length > 0 && (
              <div className="steps">
                {t.steps.map((s, j) => (
                  <details key={j} className={`step ${s.isError ? "failed" : ""}`}>
                    <summary>
                      <span className="mono">{s.tool}</span>
                      <span className="muted">
                        {s.isError ? "failed" : "ok"} · {s.ms} ms
                      </span>
                    </summary>
                    <div className="label">arguments</div>
                    <pre>{JSON.stringify(s.arguments, null, 2)}</pre>
                    <div className="label">result</div>
                    <pre>{s.result}</pre>
                  </details>
                ))}
              </div>
            )}
            <div className="bubble">{t.content}</div>
          </div>
        ))}
        {busy && <div className="msg assistant"><div className="bubble muted">Thinking and calling tools…</div></div>}
        <div ref={end} />
      </div>

      <form className="composer" onSubmit={submit}>
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask about products, orders, notes…" disabled={busy} />
        <button disabled={busy || !input.trim()}>Send</button>
      </form>
    </section>
  );
}
