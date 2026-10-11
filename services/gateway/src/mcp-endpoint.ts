// The single MCP endpoint team members connect to: POST /mcp
//
// Stateless Streamable HTTP: each request builds a throwaway Server bound to
// the caller's principal. Nothing is kept between requests, so any replica can
// answer any request and a rolling restart drops no sessions.
//
// Two modes:
//   /mcp               every tool the caller may use, as <server>__<tool>
//   /mcp?tools=search  two meta-tools (search_tools, call_tool) for clients
//                      or models that can't take hundreds of tool schemas.
import type { Request, Response } from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { describeForClient, visibleTools, type Principal } from "./catalog.js";
import { routeToolCall } from "./router.js";

const SEARCH = "switchboard__search_tools";
const CALL = "switchboard__call_tool";

const metaTools = [
  {
    name: SEARCH,
    description:
      "Search the tools available through this gateway (across every connected server). Returns matching tool names, descriptions and input schemas. Use it before switchboard__call_tool.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What you want to do, e.g. 'list orders' or 'create note'" },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
      required: ["query"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: CALL,
    description: "Call a tool found with switchboard__search_tools, by its exact name.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        arguments: { type: "object", additionalProperties: true },
      },
      required: ["name"],
    },
  },
];

export function scoreTool(query: string, name: string, description: string): number {
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);
  const hay = `${name.replace(/_/g, " ")} ${description}`.toLowerCase();
  let score = 0;
  for (const w of words) {
    if (name.toLowerCase().includes(w)) score += 3;
    else if (hay.includes(w)) score += 1;
    else if (w.endsWith("s") && hay.includes(w.slice(0, -1))) score += 1;
  }
  return score;
}

function buildServer(p: Principal, mode: "direct" | "search") {
  const server = new Server({ name: "switchboard", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (mode === "search") return { tools: metaTools };
    return { tools: (await visibleTools(p)).map(describeForClient) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    if (name === SEARCH) {
      const query = String((args as any).query ?? "");
      const limit = Math.min(Number((args as any).limit ?? 8), 20);
      const hits = (await visibleTools(p))
        .map((e) => ({ e, s: scoreTool(query, e.exposedName, e.tool.description ?? "") }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, limit)
        .map(({ e }) => describeForClient(e));
      return { content: [{ type: "text", text: JSON.stringify(hits, null, 2) }] };
    }
    if (name === CALL) {
      const target = String((args as any).name ?? "");
      return (await routeToolCall(p, target, ((args as any).arguments ?? {}) as Record<string, unknown>)) as any;
    }
    return (await routeToolCall(p, name, args as Record<string, unknown>)) as any;
  });

  return server;
}

export async function handleMcp(req: Request, res: Response) {
  const mode = req.query.tools === "search" ? "search" : "direct";
  const server = buildServer(req.principal!, mode);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("gateway mcp request failed", err);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "internal error" }, id: null });
  }
}
