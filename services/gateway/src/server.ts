import cookieParser from "cookie-parser";
import express from "express";
import { api } from "./api.js";
import { requireMcpPrincipal } from "./auth.js";
import { config } from "./config.js";
import { migrate, pool } from "./db.js";
import { handleMcp } from "./mcp-endpoint.js";
import { registry } from "./metrics.js";
import { seed } from "./seed.js";
import { upstreams } from "./upstreams.js";

// Wait for Postgres instead of crash-looping while it starts.
for (let i = 1; ; i++) {
  try {
    await pool.query("SELECT 1");
    break;
  } catch (err) {
    if (i >= 60) throw err;
    console.log(`waiting for database (${(err as Error).message})`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}
await migrate();
await seed();

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});
app.get("/readyz", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false, reason: "database unreachable" });
  }
});

// Prometheus scrape endpoint. Not routed by the Ingress (cluster-internal only).
app.get("/metrics", async (_req, res) => {
  res.set("content-type", registry.contentType).send(await registry.metrics());
});

// --- the team MCP endpoint (API key or chat token required)
app.post("/mcp", requireMcpPrincipal, handleMcp);
const notAllowed = (_req: express.Request, res: express.Response) => {
  // Stateless server: no standalone SSE stream and no sessions to delete.
  res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
};
app.get("/mcp", notAllowed);
app.delete("/mcp", notAllowed);

// --- dashboard API. CSRF: the session cookie is SameSite=Lax, and every
// state change must carry a custom header. Browsers only let another site send
// a custom header after a CORS preflight, and this API answers no CORS.
app.use("/api", (req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD" && req.header("x-switchboard") !== "1") {
    res.status(403).json({ error: "missing X-Switchboard header" });
    return;
  }
  next();
});
app.use("/api", api);

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "internal error" });
});

const server = app.listen(config.port, () => console.log(`gateway listening on :${config.port}`));
upstreams.start();

const shutdown = () => {
  console.log("shutting down");
  upstreams.stop();
  server.close(() => pool.end().then(() => process.exit(0)));
  setTimeout(() => process.exit(0), 8000).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
