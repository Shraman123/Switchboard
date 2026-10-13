// Shared pieces of the store and hosted-server reconcilers.
import { config } from "../config.js";
import { q } from "../db.js";

export type Status = "provisioning" | "ready" | "failed" | "deleting";
export type Table = "stores" | "hosted_servers";

export interface ResourceRow {
  id: string;
  slug: string;
  name: string;
  owner_id: string | null;
  status: Status;
  step: string | null;
  reason: string | null;
  server_id: string | null;
  attempts: number;
  deadline: string | null;
  created_at: string;
}

export const LABELS = {
  managed: "switchboard.dev/managed",
  kind: "switchboard.dev/kind",
  upstream: "switchboard.dev/upstream",
  resourceId: "switchboard.dev/id",
};

// Progress note shown in the dashboard while provisioning ("installing chart").
export async function setStep(table: Table, id: string, step: string) {
  await q(`UPDATE ${table} SET step=$2, updated_at=now() WHERE id=$1`, [id, step]);
}

export async function markReady(table: Table, id: string, serverId: string, extra: Record<string, unknown> = {}) {
  const cols = Object.keys(extra);
  await q(
    `UPDATE ${table} SET status='ready', step=NULL, reason=NULL, server_id=$2, ready_at=now(), updated_at=now()
       ${cols.map((c, i) => `, ${c}=$${i + 3}`).join("")}
     WHERE id=$1 AND status='provisioning'`,
    [id, serverId, ...cols.map((c) => extra[c])],
  );
}

export async function markFailed(table: Table, id: string, reason: string) {
  await q(`UPDATE ${table} SET status='failed', reason=$2, updated_at=now() WHERE id=$1 AND status='provisioning'`, [id, reason.slice(0, 1000)]);
}

// Provisioning actions go into the same audit log as tool calls.
export async function audit(ownerId: string | null, action: string, slug: string, outcome: "ok" | "error", ms: number, error?: string) {
  await q(
    `INSERT INTO audit_log (user_id, user_email, via, server_slug, tool_name, exposed_name, duration_ms, outcome, error)
     SELECT $1, (SELECT email FROM users WHERE id=$1), 'provisioner', $2, $3, $3, $4, $5, $6`,
    [ownerId, slug, action, ms, outcome, error ?? null],
  ).catch((err) => console.error("audit insert failed", err));
}

export const remainingMs = (row: ResourceRow) => (row.deadline ? new Date(row.deadline).getTime() - Date.now() : config.provisioning.storeTimeoutMs);

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Timeout extends Error {}
