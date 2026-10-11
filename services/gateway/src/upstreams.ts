// The gateway's *client* side: one MCP client per upstream server.
//
// - A background health loop connects to every enabled upstream, lists its
//   tools and caches them in Postgres, so `tools/list` on the gateway never
//   waits on a slow or dead upstream.
// - Tool calls reuse the live client, with a per-server timeout. A broken
//   session is rebuilt once transparently; anything else becomes a clear error.
// - Credentials are decrypted only here, in memory, to build request headers.
import net from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { fetch as undiciFetch } from "undici";
import { config } from "./config.js";
import { decrypt, sha256 } from "./crypto.js";
import { one, q } from "./db.js";
import { hostAllowedInternal, isPrivateAddress, SsrfError, upstreamDispatcher } from "./ssrf.js";
import { metrics } from "./metrics.js";

export interface ToolDef {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface ServerRow {
  id: string;
  slug: string;
  name: string;
  url: string;
  auth_type: "none" | "bearer" | "header";
  auth_header_name: string | null;
  credential_enc: string | null;
  enabled: boolean;
  timeout_ms: number;
  status: string;
  status_reason: string | null;
  last_checked_at: string | null;
  last_ok_at: string | null;
  tools: ToolDef[];
  approved_tools: Record<string, string> | null;
  updated_at: string;
}

export type FailureKind = "timeout" | "unavailable" | "error";
export class UpstreamError extends Error {
  constructor(message: string, readonly kind: FailureKind) {
    super(message);
  }
}

// The fingerprint covers what a model reads (description) and what it sends
// (schema). If an upstream silently changes either, the tool is held back
// until an admin re-approves it (see catalog.ts).
export const toolFingerprint = (t: ToolDef) =>
  sha256(canonicalJson({ d: t.description ?? "", t: t.title ?? "", s: t.inputSchema ?? {}, a: t.annotations ?? {} })).slice(0, 16);

// Key-sorted JSON, so the fingerprint survives a round trip through Postgres
// jsonb (which reorders object keys).
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

const IDENTITY = { name: "switchboard-gateway", version: "0.1.0" };

// Every byte the gateway sends upstream goes through this fetch: connect-time
// SSRF checks (via the dispatcher) and no redirects.
const guardedFetch = (async (input: any, init: any = {}) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && isPrivateAddress(host) && !hostAllowedInternal(host)) {
    throw new SsrfError(`blocked connection to internal address ${host}`);
  }
  return undiciFetch(url, { ...init, dispatcher: upstreamDispatcher, redirect: "error" });
}) as unknown as typeof fetch;

export function credentialHeaders(row: Pick<ServerRow, "auth_type" | "auth_header_name" | "credential_enc">): Record<string, string> {
  if (row.auth_type === "none" || !row.credential_enc) return {};
  const secret = decrypt(row.credential_enc);
  if (row.auth_type === "bearer") return { Authorization: `Bearer ${secret}` };
  return { [row.auth_header_name || "X-API-Key"]: secret };
}

// Turn transport / protocol errors into something an admin can act on.
export function describeError(err: unknown, timeoutMs: number): { kind: FailureKind; reason: string } {
  if (err instanceof UpstreamError) return { kind: err.kind, reason: err.message };
  if (err instanceof McpError && err.code === ErrorCode.RequestTimeout) return { kind: "timeout", reason: `timed out after ${timeoutMs}ms` };
  if (err instanceof SsrfError) return { kind: "unavailable", reason: `blocked by SSRF policy: ${err.message}` };
  if (err instanceof StreamableHTTPError) {
    const hint = err.code === 401 || err.code === 403 ? " (check the server credential)" : err.code === 404 ? " (wrong path or expired session)" : "";
    return { kind: "unavailable", reason: `HTTP ${err.code} from upstream${hint}` };
  }
  const e = err as any;
  const cause = e?.cause;
  if (cause instanceof SsrfError) return { kind: "unavailable", reason: `blocked by SSRF policy: ${cause.message}` };
  const code = cause?.code ?? e?.code;
  const map: Record<string, string> = {
    ECONNREFUSED: "connection refused (nothing listening — pod down?)",
    ENOTFOUND: "DNS lookup failed (unknown host)",
    EAI_AGAIN: "DNS lookup failed (temporary)",
    ECONNRESET: "connection reset by upstream",
    ETIMEDOUT: "connection timed out",
    UND_ERR_CONNECT_TIMEOUT: "connect timed out",
    EHOSTUNREACH: "host unreachable (network policy or routing)",
  };
  if (code && map[code]) return { kind: "unavailable", reason: `${map[code]} [${code}]` };
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return { kind: "timeout", reason: `timed out after ${timeoutMs}ms` };
  return { kind: "error", reason: (e?.message ?? String(err)).slice(0, 300) };
}

interface Live {
  client: Client;
  fingerprint: string;
}

class UpstreamManager {
  private live = new Map<string, Live>();
  private connecting = new Map<string, Promise<Live>>();
  private timer?: NodeJS.Timeout;
  private serversCache?: { at: number; rows: ServerRow[] };

  // Every replica reads server config from Postgres on each request (one
  // small query), so an admin disabling a server on one replica takes effect
  // on all of them immediately. Callers may opt into a short cache.
  async servers(maxAgeMs = 0): Promise<ServerRow[]> {
    if (this.serversCache && Date.now() - this.serversCache.at < maxAgeMs) return this.serversCache.rows;
    const rows = await q<ServerRow>("SELECT * FROM servers ORDER BY created_at");
    this.serversCache = { at: Date.now(), rows };
    return rows;
  }

  invalidate() {
    this.serversCache = undefined;
  }

  private connFingerprint = (r: ServerRow) => sha256([r.url, r.auth_type, r.auth_header_name, r.credential_enc].join("|"));

  private async connect(row: ServerRow): Promise<Live> {
    const transport = new StreamableHTTPClientTransport(new URL(row.url), {
      requestInit: { headers: credentialHeaders(row) },
      fetch: guardedFetch,
    });
    const client = new Client(IDENTITY, { capabilities: {} });
    try {
      await client.connect(transport, { timeout: config.upstream.healthTimeoutMs });
    } catch (err) {
      await client.close().catch(() => {});
      throw err;
    }
    return { client, fingerprint: this.connFingerprint(row) };
  }

  private async clientFor(row: ServerRow): Promise<Client> {
    const fp = this.connFingerprint(row);
    const cur = this.live.get(row.id);
    if (cur && cur.fingerprint === fp) return cur.client;
    if (cur) this.drop(row.id);
    let pending = this.connecting.get(row.id);
    if (!pending) {
      pending = this.connect(row).finally(() => this.connecting.delete(row.id));
      this.connecting.set(row.id, pending);
    }
    const live = await pending;
    this.live.set(row.id, live);
    return live.client;
  }

  drop(id: string) {
    const cur = this.live.get(id);
    this.live.delete(id);
    cur?.client.close().catch(() => {});
  }

  private async setStatus(row: ServerRow, status: string, reason: string | null, tools?: ToolDef[]) {
    metrics.upstreamUp.set({ server: row.slug }, status === "connected" ? 1 : 0);
    if (tools) {
      // First successful contact: the tool set the admin just registered is
      // the approved baseline.
      const approved = row.approved_tools ?? Object.fromEntries(tools.map((t) => [t.name, toolFingerprint(t)]));
      await q(
        `UPDATE servers SET status=$2, status_reason=$3, tools=$4, approved_tools=$5, last_checked_at=now(), last_ok_at=now() WHERE id=$1`,
        [row.id, status, reason, JSON.stringify(tools), JSON.stringify(approved)],
      );
    } else {
      await q(`UPDATE servers SET status=$2, status_reason=$3, last_checked_at=now() WHERE id=$1`, [row.id, status, reason]);
    }
    this.invalidate();
  }

  async refresh(row: ServerRow): Promise<void> {
    if (!row.enabled) {
      this.drop(row.id);
      if (row.status !== "disabled") await this.setStatus(row, "disabled", null);
      return;
    }
    try {
      const client = await this.clientFor(row);
      const tools: ToolDef[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: config.upstream.healthTimeoutMs });
        tools.push(...(page.tools as ToolDef[]));
        cursor = page.nextCursor;
      } while (cursor && tools.length < 1000);
      await this.setStatus(row, "connected", null, tools);
    } catch (err) {
      this.drop(row.id);
      const { reason } = describeError(err, config.upstream.healthTimeoutMs);
      await this.setStatus(row, "unreachable", reason);
    }
  }

  async refreshAll() {
    const rows = await this.servers(0);
    await Promise.allSettled(rows.map((r) => this.refresh(r)));
    for (const id of this.live.keys()) if (!rows.some((r) => r.id === id)) this.drop(id);
  }

  start() {
    const tick = async () => {
      try {
        await this.refreshAll();
      } catch (err) {
        console.error("health loop failed", err);
      }
      this.timer = setTimeout(tick, config.upstream.healthIntervalMs);
    };
    tick();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    for (const id of [...this.live.keys()]) this.drop(id);
  }

  async callTool(row: ServerRow, tool: string, args: Record<string, unknown>) {
    const timeout = row.timeout_ms || config.upstream.defaultCallTimeoutMs;
    const attempt = async () => {
      const client = await this.clientFor(row);
      return client.callTool({ name: tool, arguments: args }, undefined, { timeout });
    };
    try {
      try {
        return await attempt();
      } catch (err) {
        // A restarted upstream forgets our session (HTTP 404) or the socket
        // was dropped: rebuild the client once, then give up.
        const retriable = (err instanceof StreamableHTTPError && err.code === 404) || /session/i.test((err as Error)?.message ?? "");
        if (!retriable) throw err;
        this.drop(row.id);
        return await attempt();
      }
    } catch (err) {
      const d = describeError(err, timeout);
      this.drop(row.id);
      if (d.kind === "unavailable") {
        // Don't wait for the next health tick to stop advertising its tools.
        await this.setStatus(row, "unreachable", d.reason).catch(() => {});
      }
      throw new UpstreamError(`${row.name}: ${d.reason}`, d.kind);
    }
  }

  async byId(id: string) {
    return one<ServerRow>("SELECT * FROM servers WHERE id=$1", [id]);
  }
}

export const upstreams = new UpstreamManager();
