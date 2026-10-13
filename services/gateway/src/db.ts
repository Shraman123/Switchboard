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
  // 2: store provisioning + hosted (image-based) MCP servers. A server row
  // created by the provisioner is "managed": its URL and credential belong to
  // the platform and it is removed together with its store / deployment.
  `
  ALTER TABLE servers ADD COLUMN managed_by text CHECK (managed_by IN ('store', 'hosted'));
  ALTER TABLE servers ADD COLUMN owner_id uuid REFERENCES users(id) ON DELETE SET NULL;

  CREATE TABLE stores (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug text NOT NULL UNIQUE,
    name text NOT NULL,
    owner_id uuid REFERENCES users(id) ON DELETE SET NULL,
    namespace text NOT NULL UNIQUE,
    status text NOT NULL CHECK (status IN ('provisioning', 'ready', 'failed', 'deleting')),
    step text,
    reason text,
    url text,
    server_id uuid REFERENCES servers(id) ON DELETE SET NULL,
    attempts integer NOT NULL DEFAULT 1,
    deadline timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    ready_at timestamptz
  );

  CREATE TABLE hosted_servers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug text NOT NULL UNIQUE,
    name text NOT NULL,
    image text NOT NULL,
    port integer NOT NULL,
    path text NOT NULL,
    env jsonb NOT NULL DEFAULT '{}',
    secret_env_enc text,
    allow_internet boolean NOT NULL DEFAULT false,
    size text NOT NULL DEFAULT 'small' CHECK (size IN ('small', 'medium')),
    owner_id uuid REFERENCES users(id) ON DELETE SET NULL,
    status text NOT NULL CHECK (status IN ('provisioning', 'ready', 'failed', 'deleting')),
    step text,
    reason text,
    server_id uuid REFERENCES servers(id) ON DELETE SET NULL,
    attempts integer NOT NULL DEFAULT 1,
    deadline timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    ready_at timestamptz
  );
  `,
  // 3: OAuth 2.1 authorization server for MCP clients (browser login instead
  // of a pasted API key). Codes and tokens are stored as SHA-256 hashes only.
  `
  CREATE TABLE oauth_clients (
    client_id text PRIMARY KEY,
    client_name text NOT NULL,
    redirect_uris jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE oauth_codes (
    code_hash text PRIMARY KEY,
    client_id text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    redirect_uri text NOT NULL,
    code_challenge text NOT NULL,
    resource text NOT NULL,
    expires_at timestamptz NOT NULL,
    used_at timestamptz
  );

  -- One row per issued token. A refresh token rotates on every use; reuse of
  -- an old one revokes the whole family (stolen-token detection).
  CREATE TABLE oauth_tokens (
    token_hash text PRIMARY KEY,
    kind text NOT NULL CHECK (kind IN ('access', 'refresh')),
    family uuid NOT NULL,
    client_id text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    resource text NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz,
    rotated_at timestamptz,
    revoked_at timestamptz
  );
  CREATE INDEX oauth_tokens_user ON oauth_tokens (user_id, client_id);
  CREATE INDEX oauth_tokens_family ON oauth_tokens (family);

  -- Which credential made a call: the API key's name or the OAuth app's name.
  ALTER TABLE audit_log ADD COLUMN client text;
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
