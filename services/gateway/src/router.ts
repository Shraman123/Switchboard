// One function every tool call goes through, whether it came from an external
// MCP client or from the dashboard's chat agent: resolve, authorize, rate
// limit, route, time out, audit.
import { denialFor, denialMessage, fullCatalog, type Principal } from "./catalog.js";
import { config } from "./config.js";
import { q } from "./db.js";
import { metrics } from "./metrics.js";
import { UpstreamError, upstreams } from "./upstreams.js";

type Outcome = "ok" | "error" | "denied" | "timeout" | "unavailable" | "rate_limited";

export interface ToolResult {
  content: any[];
  structuredContent?: unknown;
  isError?: boolean;
}

const errorResult = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

async function audit(p: Principal, entry: { serverId?: string; slug?: string; tool?: string; exposed: string; ms: number; outcome: Outcome; error?: string }) {
  metrics.toolCalls.inc({ server: entry.slug ?? "-", tool: entry.tool ?? entry.exposed, outcome: entry.outcome, via: p.via });
  metrics.toolLatency.observe({ server: entry.slug ?? "-", outcome: entry.outcome }, entry.ms / 1000);
  await q(
    `INSERT INTO audit_log (user_id, user_email, via, api_key_id, server_id, server_slug, tool_name, exposed_name, duration_ms, outcome, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [p.userId, p.email, p.via, p.apiKeyId ?? null, entry.serverId ?? null, entry.slug ?? null, entry.tool ?? null, entry.exposed, entry.ms, entry.outcome, entry.error?.slice(0, 500) ?? null],
  ).catch((err) => console.error("audit write failed", err));
}

// Fixed one-minute window shared by all replicas (counter lives in Postgres).
async function overRateLimit(p: Principal): Promise<boolean> {
  if (config.rateLimitPerMinute <= 0) return false;
  const bucket = `user:${p.userId}`;
  const [row] = await q<{ count: number }>(
    `INSERT INTO rate_limits (bucket, window_start, count) VALUES ($1, date_trunc('minute', now()), 1)
     ON CONFLICT (bucket, window_start) DO UPDATE SET count = rate_limits.count + 1 RETURNING count`,
    [bucket],
  );
  if (Math.random() < 0.01) q(`DELETE FROM rate_limits WHERE window_start < now() - interval '10 minutes'`).catch(() => {});
  return row.count > config.rateLimitPerMinute;
}

function capSize(result: ToolResult): ToolResult {
  const size = JSON.stringify(result).length;
  if (size <= config.upstream.maxResultBytes) return result;
  const text = result.content
    .map((c) => (c.type === "text" ? c.text : `[${c.type} content omitted]`))
    .join("\n")
    .slice(0, config.upstream.maxResultBytes - 200);
  return { content: [{ type: "text", text: `${text}\n…[truncated by gateway: result was ${size} bytes]` }], isError: result.isError };
}

export async function routeToolCall(p: Principal, exposed: string, args: Record<string, unknown>): Promise<ToolResult> {
  const started = Date.now();
  const entry = (await fullCatalog()).find((e) => e.exposedName === exposed);
  const base = { serverId: entry?.server.id, slug: entry?.server.slug, tool: entry?.tool.name, exposed };

  if (!entry) {
    await audit(p, { ...base, ms: Date.now() - started, outcome: "denied", error: "unknown tool" });
    return errorResult(`Unknown tool "${exposed}". List tools again: the server may have been removed.`);
  }
  const denial = denialFor(entry, p);
  if (denial) {
    const outcome: Outcome = denial === "server_unreachable" ? "unavailable" : "denied";
    await audit(p, { ...base, ms: Date.now() - started, outcome, error: denial });
    return errorResult(`Tool "${exposed}" is not available: ${denialMessage[denial]}.`);
  }
  if (await overRateLimit(p)) {
    await audit(p, { ...base, ms: Date.now() - started, outcome: "rate_limited" });
    return errorResult(`Rate limit exceeded (${config.rateLimitPerMinute} tool calls per minute). Try again shortly.`);
  }

  try {
    const res = (await upstreams.callTool(entry.server, entry.tool.name, args)) as ToolResult;
    await audit(p, { ...base, ms: Date.now() - started, outcome: res.isError ? "error" : "ok", error: res.isError ? firstText(res) : undefined });
    return capSize(res);
  } catch (err) {
    const kind = err instanceof UpstreamError ? err.kind : "error";
    const outcome: Outcome = kind === "timeout" ? "timeout" : kind === "unavailable" ? "unavailable" : "error";
    const msg = (err as Error).message;
    await audit(p, { ...base, ms: Date.now() - started, outcome, error: msg });
    return errorResult(`Upstream call failed (${outcome}): ${msg}`);
  }
}

const firstText = (r: ToolResult) => r.content?.find((c) => c.type === "text")?.text?.slice(0, 300);
