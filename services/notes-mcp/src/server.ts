// "Team notes": a deliberately small second upstream. It exists to show the
// gateway working with an independent server that needs its own credential
// (a static bearer token the gateway holds and members never see).
import express from "express";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const PORT = Number(process.env.PORT ?? 8080);
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN ?? "";
if (!AUTH_TOKEN) throw new Error("MCP_AUTH_TOKEN is required");

interface Note {
  id: string;
  title: string;
  body: string;
  tags: string[];
  author: string;
  created_at: string;
}

// In-memory on purpose: notes reset when the pod restarts, which keeps this
// example stateless to operate. A real server would use a database.
const notes: Note[] = [
  {
    id: randomUUID(),
    title: "Order handling policy",
    body: "COD orders over 2000 INR need a phone confirmation before they are marked processing. Orders are shipped within 2 working days.",
    tags: ["policy", "orders"],
    author: "ops",
    created_at: new Date().toISOString(),
  },
];

const text = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

function buildServer() {
  const server = new McpServer({ name: "team-notes", version: "0.1.0" });

  server.registerTool(
    "create_note",
    {
      title: "Create note",
      description: "Save a note to the shared team notebook.",
      inputSchema: {
        title: z.string().min(1).max(200),
        body: z.string().min(1).max(10000),
        tags: z.array(z.string().max(40)).max(10).optional(),
      },
    },
    async (a) => {
      const note: Note = { id: randomUUID(), title: a.title, body: a.body, tags: a.tags ?? [], author: "gateway", created_at: new Date().toISOString() };
      notes.unshift(note);
      return text(note);
    },
  );

  server.registerTool(
    "list_notes",
    {
      title: "List notes",
      description: "List notes in the team notebook, newest first, optionally only those with a tag.",
      inputSchema: { tag: z.string().optional(), limit: z.number().int().min(1).max(100).optional() },
      annotations: { readOnlyHint: true },
    },
    async (a) => text(notes.filter((n) => !a.tag || n.tags.includes(a.tag)).slice(0, a.limit ?? 20)),
  );

  server.registerTool(
    "search_notes",
    {
      title: "Search notes",
      description: "Full-text search over note titles and bodies.",
      inputSchema: { query: z.string().min(1) },
      annotations: { readOnlyHint: true },
    },
    async (a) => {
      const q = a.query.toLowerCase();
      return text(notes.filter((n) => n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q)));
    },
  );

  // Same name as a tool on the "everything" reference server: a real
  // collision the gateway has to disambiguate.
  server.registerTool(
    "echo",
    {
      title: "Echo",
      description: "Connectivity check: returns the message unchanged.",
      inputSchema: { message: z.string() },
      annotations: { readOnlyHint: true },
    },
    async (a) => ({ content: [{ type: "text" as const, text: `notes echo: ${a.message}` }] }),
  );

  return server;
}

const app = express();
app.use(express.json({ limit: "1mb" }));
app.get("/healthz", (_req, res) => {
  res.json({ ok: true, notes: notes.length });
});

app.use("/mcp", (req, res, next) => {
  const token = (req.header("authorization") ?? "").replace(/^Bearer /, "");
  const a = Buffer.from(token);
  const b = Buffer.from(AUTH_TOKEN);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "unauthorized" }, id: null });
    return;
  }
  next();
});

app.post("/mcp", async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(PORT, () => console.log(`notes-mcp listening on :${PORT}`));
