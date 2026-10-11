// First-boot seeding: the first admin account and the upstream servers listed
// in SEED_SERVERS (Helm values). Each seed is applied once and recorded, so an
// admin who later deletes a seeded server doesn't see it come back on restart.
import { config } from "./config.js";
import { encrypt, hashPassword } from "./crypto.js";
import { one, pool, q } from "./db.js";

interface SeedServer {
  slug: string;
  name: string;
  url: string;
  authType?: "none" | "bearer" | "header";
  authHeaderName?: string;
  credentialEnv?: string; // name of an env var (populated from a Secret)
  timeoutMs?: number;
  // Default tool policies, e.g. { "create_product": { "adminOnly": true } }
  policies?: Record<string, { adminOnly?: boolean; hidden?: boolean }>;
}

export async function seed() {
  const users = await one<{ n: number }>("SELECT count(*)::int AS n FROM users");
  if (users!.n === 0) {
    if (!config.admin.email || !config.admin.password) {
      console.warn("no users and no ADMIN_EMAIL/ADMIN_PASSWORD: nobody can sign in");
    } else {
      await q("INSERT INTO users (email, name, role, status, password_hash) VALUES ($1, 'Admin', 'admin', 'active', $2) ON CONFLICT DO NOTHING", [
        config.admin.email.toLowerCase(),
        hashPassword(config.admin.password),
      ]);
      console.log(`seeded admin ${config.admin.email}`);
    }
  }

  const servers = JSON.parse(config.seedServers) as SeedServer[];
  for (const s of servers) {
    const key = `server:${s.slug}`;
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const done = await c.query("INSERT INTO seeds (key) VALUES ($1) ON CONFLICT DO NOTHING RETURNING key", [key]);
      if (done.rowCount) {
        const secret = s.credentialEnv ? process.env[s.credentialEnv] : undefined;
        const authType = s.authType ?? "none";
        if (authType !== "none" && !secret) throw new Error(`seed ${s.slug}: env ${s.credentialEnv} is empty`);
        const row = await c.query(
          `INSERT INTO servers (slug, name, url, auth_type, auth_header_name, credential_enc, timeout_ms)
           VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (slug) DO NOTHING RETURNING id`,
          [s.slug, s.name, s.url, authType, s.authHeaderName ?? null, secret ? encrypt(secret) : null, s.timeoutMs ?? config.upstream.defaultCallTimeoutMs],
        );
        for (const [tool, p] of Object.entries(s.policies ?? {})) {
          if (!row.rowCount) break;
          await c.query("INSERT INTO tool_policies (server_id, tool_name, admin_only, hidden) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [
            row.rows[0].id,
            tool,
            Boolean(p.adminOnly),
            Boolean(p.hidden),
          ]);
        }
        console.log(`seeded server ${s.slug} -> ${s.url}`);
      }
      await c.query("COMMIT");
    } catch (err) {
      await c.query("ROLLBACK");
      throw err;
    } finally {
      c.release();
    }
  }
}
