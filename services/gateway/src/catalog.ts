// The gateway's *server* side view: which tools a given user sees, under
// which names, and how a called name maps back to (server, original tool).
//
// Naming scheme: every tool is exposed as `<server-slug>__<tool-name>`.
// Always prefixing (not only on collision) keeps names stable: adding a new
// server can never rename a tool a client already uses.
import { createHash } from "node:crypto";
import { q } from "./db.js";
import { toolFingerprint, upstreams, type ServerRow, type ToolDef } from "./upstreams.js";

export const SEP = "__";
const MAX_NAME = 64; // common client limit (and the spec's recommended maximum)

export interface Principal {
  userId: string;
  email: string;
  role: "admin" | "member";
  via: "mcp" | "chat" | "oauth";
  apiKeyId?: string;
  client?: string; // API key name or OAuth app name, for the audit log
}

export interface Policy {
  admin_only: boolean;
  hidden: boolean;
}

export interface CatalogEntry {
  exposedName: string;
  server: ServerRow;
  tool: ToolDef;
  policy: Policy;
  pendingReview: boolean;
}

export function exposedName(slug: string, tool: string): string {
  const clean = tool.replace(/[^A-Za-z0-9_-]/g, "_");
  const name = `${slug}${SEP}${clean}`;
  if (name.length <= MAX_NAME && clean === tool) return name;
  // Sanitised or too long: keep it readable but make it unique.
  const h = createHash("sha256").update(tool).digest("hex").slice(0, 6);
  return `${name.slice(0, MAX_NAME - 7)}_${h}`;
}

async function policies(): Promise<Map<string, Policy>> {
  const rows = await q<{ server_id: string; tool_name: string; admin_only: boolean; hidden: boolean }>("SELECT * FROM tool_policies");
  return new Map(rows.map((r) => [`${r.server_id}/${r.tool_name}`, { admin_only: r.admin_only, hidden: r.hidden }]));
}

// Everything known, including what this principal can't use (for the dashboard and for precise errors).
export async function fullCatalog(): Promise<CatalogEntry[]> {
  const [servers, pol] = await Promise.all([upstreams.servers(), policies()]);
  const out: CatalogEntry[] = [];
  for (const s of servers) {
    for (const t of s.tools ?? []) {
      const approved = s.approved_tools?.[t.name];
      out.push({
        exposedName: exposedName(s.slug, t.name),
        server: s,
        tool: t,
        policy: pol.get(`${s.id}/${t.name}`) ?? { admin_only: false, hidden: false },
        pendingReview: approved !== toolFingerprint(t),
      });
    }
  }
  return out;
}

export type Denial = "server_disabled" | "server_unreachable" | "hidden" | "admin_only" | "pending_review";

export function denialFor(e: CatalogEntry, p: Principal): Denial | null {
  if (!e.server.enabled) return "server_disabled";
  if (e.server.status !== "connected") return "server_unreachable";
  if (e.policy.hidden) return "hidden";
  if (e.pendingReview) return "pending_review";
  // A store's owner manages their own store's tools (e.g. create_product).
  if (e.policy.admin_only && p.role !== "admin" && e.server.owner_id !== p.userId) return "admin_only";
  return null;
}

export const denialMessage: Record<Denial, string> = {
  server_disabled: "this tool's server is disabled by an admin",
  server_unreachable: "this tool's server is currently unreachable",
  hidden: "this tool is hidden by an admin",
  admin_only: "this tool is restricted to admins (and the store's owner)",
  pending_review: "this tool's definition changed upstream and is waiting for admin review",
};

export async function visibleTools(p: Principal): Promise<CatalogEntry[]> {
  return (await fullCatalog()).filter((e) => denialFor(e, p) === null);
}

export const describeForClient = (e: CatalogEntry): ToolDef => ({
  ...e.tool,
  name: e.exposedName,
  // Tell the model (and the human) which upstream a tool belongs to.
  description: `[${e.server.name}] ${e.tool.description ?? ""}`.trim(),
});
