import express from "express";
import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { WooClient } from "./woo.js";
import { registerTools } from "./tools.js";

const env = (name: string, fallback?: string) => {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`missing env ${name}`);
  return v;
};

const PORT = Number(env("PORT", "8080"));
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN ?? "";
const woo = new WooClient({
  baseUrl: env("WC_BASE_URL"),
  consumerKey: env("WC_CONSUMER_KEY"),
  consumerSecret: env("WC_CONSUMER_SECRET"),
  timeoutMs: Number(env("WC_TIMEOUT_MS", "10000")),
});

const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

// Defense in depth: the NetworkPolicy already limits who can reach this pod;
// the bearer token means a reachable pod still is not an open door.
app.use("/mcp", (req, res, next) => {
  if (!AUTH_TOKEN) return next();
  const header = req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!sameSecret(token, AUTH_TOKEN)) {
    res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "unauthorized" }, id: null });
    return;
  }
  next();
});

// Stateless Streamable HTTP: a fresh server + transport per request. There is
// no session state to lose, so the pod can be restarted or scaled freely.
app.post("/mcp", async (req, res) => {
  const server = new McpServer({ name: "woocommerce", version: "0.1.0" });
  registerTools(server, woo);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("mcp request failed", err);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "internal error" }, id: null });
  }
});

const methodNotAllowed = (_req: express.Request, res: express.Response) => {
  res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "method not allowed" }, id: null });
};
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

app.listen(PORT, () => console.log(`woo-mcp listening on :${PORT}`));
