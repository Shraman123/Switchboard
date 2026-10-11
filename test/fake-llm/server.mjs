// A scripted, OpenAI-compatible /chat/completions endpoint for testing the
// chat agent's tool loop without a real model (no key, no quota, deterministic).
// It picks tools by keyword from the offered tool list, then summarises.
import http from "node:http";

const PORT = Number(process.env.PORT ?? 8080);

const today = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10); // IST

function plan(text) {
  const t = text.toLowerCase();
  const m = text.match(/called (.+?) priced at (\d+(?:\.\d+)?)/i);
  if (m) return [["woo__create_product", { name: m[1], regular_price: Number(m[2]) }]];
  if (t.includes("note")) return [["woo__list_orders", { after: `${today()}T00:00:00` }], ["notes__create_note", null]];
  if (t.includes("order")) return [["woo__list_orders", { after: `${today()}T00:00:00` }]];
  if (t.includes("product")) return [["woo__list_products", {}]];
  return [];
}

function reply(body) {
  const msgs = body.messages;
  const offered = new Set((body.tools ?? []).map((x) => x.function.name));
  const lastUser = [...msgs].reverse().find((m) => m.role === "user")?.content ?? "";
  const steps = plan(lastUser).filter(([name]) => offered.has(name));
  const sinceUser = msgs.slice(msgs.findLastIndex((m) => m.role === "user") + 1);
  const toolResults = sinceUser.filter((m) => m.role === "tool");
  const next = steps[toolResults.length];
  if (next) {
    let [name, args] = next;
    if (!args) args = { title: `Daily report ${today()}`, body: `Orders today:\n${toolResults.map((r) => r.content).join("\n").slice(0, 1500)}`, tags: ["daily-report"] };
    return { role: "assistant", content: null, tool_calls: [{ id: `call_${toolResults.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] };
  }
  if (!toolResults.length) return { role: "assistant", content: `(fake model) I have ${offered.size} tools available but no scripted plan for that request.` };
  return { role: "assistant", content: `(fake model) Done. Tool results:\n${toolResults.map((r) => r.content.slice(0, 600)).join("\n---\n")}` };
}

http
  .createServer((req, res) => {
    if (req.url === "/healthz") return res.end("ok");
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        const message = reply(JSON.parse(raw));
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ id: "fake", object: "chat.completion", choices: [{ index: 0, message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }] }));
      } catch (err) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: { message: String(err) } }));
      }
    });
  })
  .listen(PORT, () => console.log(`fake llm on :${PORT}`));
