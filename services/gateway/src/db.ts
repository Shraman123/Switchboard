import pg from "pg";
import { config } from "./config.js";

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

export const q = async <T = any>(text: string, params: unknown[] = []): Promise<T[]> => (await pool.query(text, params)).rows as T[];
export const one = async <T = any>(text: string, params: unknown[] = []): Promise<T | undefined> => (await q<T>(text, params))[0];

const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text NOT NULL UNIQUE,
    name text NOT NULL DEFAULT '',
    role text NOT NULL CHECK (role IN ('admin', 'member')),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('invited', 'active', 'disabled')),
    password_hash text,
    invite_token_hash text UNIQUE,
    invite_expires_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE api_keys (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name text NOT NULL,
    prefix text NOT NULL,
    key_hash text NOT NULL UNIQUE,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz,
    revoked_at timestamptz
  );

  CREATE TABLE servers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug text NOT NULL UNIQUE,
    name text NOT NULL,
    url text NOT NULL,
    auth_type text NOT NULL DEFAULT 'none' CHECK (auth_type IN ('none', 'bearer', 'header')),
    auth_header_name text,
    credential_enc text,
    enabled boolean NOT NULL DEFAULT true,
    timeout_ms integer NOT NULL DEFAULT 15000,
    status text NOT NULL DEFAULT 'unknown',
    status_reason text,
    last_checked_at timestamptz,
    last_ok_at timestamptz,
    tools jsonb NOT NULL DEFAULT '[]',
    approved_tools jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE tool_policies (
    server_id uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    tool_name text NOT NULL,
    admin_only boolean NOT NULL DEFAULT false,
    hidden boolean NOT NULL DEFAULT false,
    PRIMARY KEY (server_id, tool_name)
  );

  CREATE TABLE audit_log (
    id bigserial PRIMARY KEY,
    at timestamptz NOT NULL DEFAULT now(),
    user_id uuid,
    user_email text,
    via text NOT NULL,
    api_key_id uuid,
    server_id uuid,
    server_slug text,
    tool_name text,
    exposed_name text NOT NULL,
    duration_ms integer NOT NULL,
    outcome text NOT NULL,
    error text
  );
  CREATE INDEX audit_log_at ON audit_log (at DESC);
  CREATE INDEX audit_log_user ON audit_log (user_id, at DESC);

  CREATE TABLE seeds (key text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());

  CREATE TABLE rate_limits (
    bucket text NOT NULL,
    window_start timestamptz NOT NULL,
    count integer NOT NULL,
    PRIMARY KEY (bucket, window_start)
  );
  `,
];

// Runs pending migrations under an advisory lock so several replicas can
// start at the same time without racing.
export async function migrate() {
  const c = await pool.connect();
  try {
    await c.query("SELECT pg_advisory_lock(727001)");
    await c.query("CREATE TABLE IF NOT EXISTS schema_migrations (version int PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const done = new Set((await c.query("SELECT version FROM schema_migrations")).rows.map((r) => r.version));
    for (let i = 0; i < MIGRATIONS.length; i++) {
      if (done.has(i + 1)) continue;
      await c.query("BEGIN");
      await c.query(MIGRATIONS[i]);
      await c.query("INSERT INTO schema_migrations (version) VALUES ($1)", [i + 1]);
      await c.query("COMMIT");
      console.log(`migration ${i + 1} applied`);
    }
  } catch (err) {
    await c.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await c.query("SELECT pg_advisory_unlock(727001)").catch(() => {});
    c.release();
  }
}
