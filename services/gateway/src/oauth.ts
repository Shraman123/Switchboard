// OAuth 2.1 for MCP clients, per the MCP authorization spec: the gateway is
// both the protected resource (/mcp) and its authorization server, so a
// client like Claude Code connects with just the URL and a browser login.
//
//   client --401 + resource_metadata--> discovers /.well-known/oauth-protected-resource
//          --> /.well-known/oauth-authorization-server
//          --> POST /oauth/register            (dynamic client registration, RFC 7591)
//          --> browser: /oauth/authorize -> dashboard /consent (sign in, approve)
//          --> POST /oauth/token               (code + PKCE S256 verifier)
//          --> /mcp with Authorization: Bearer sbo_...
//
// Access tokens are short-lived (1 h), audience-bound to <publicUrl>/mcp
// (RFC 8707), and act as the approving user through the same policy and
// audit path as API keys. Refresh tokens rotate; replaying a used one revokes
// the whole grant. Only hashes of codes and tokens are stored.
import { randomUUID } from "node:crypto";
import express, { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireUser } from "./auth.js";
import { config } from "./config.js";
import { randomToken, sha256, signToken, verifyToken } from "./crypto.js";
import { one, pool, q } from "./db.js";

export const OAUTH_TOKEN_PREFIX = "sbo_";
const ACCESS_TTL_S = 3600;
const REFRESH_TTL_S = 30 * 86400;
const CODE_TTL_S = 60;
const REQUEST_TTL_S = 600;
const MAX_CLIENTS = 500;

export const issuer = () => config.publicUrl;
export const resourceUrl = () => `${config.publicUrl}/mcp`;
export const resourceMetadataUrl = () => `${config.publicUrl}/.well-known/oauth-protected-resource`;

const b64urlSha256 = (s: string) => Buffer.from(sha256(s), "hex").toString("base64url");
const sameResource = (r: string | undefined) => !r || r.replace(/\/$/, "") === resourceUrl();

// Loopback redirect URIs may use any port (RFC 8252 7.3); others match exactly.
function redirectAllowed(registered: string[], uri: string): boolean {
  if (registered.includes(uri)) return true;
  try {
    const u = new URL(uri);
    if (u.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) return false;
    return registered.some((r) => {
      const v = new URL(r);
      return v.protocol === u.protocol && v.hostname === u.hostname && v.pathname === u.pathname;
    });
  } catch {
    return false;
  }
}

function validRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    if (u.protocol === "https:") return true;
    if (u.protocol === "http:") return ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
    // Private-use schemes for native apps (e.g. cursor://...), never script-ish ones.
    return !["javascript:", "data:", "file:", "vbscript:", "blob:"].includes(u.protocol);
  } catch {
    return false;
  }
}

// Endpoints MCP clients call directly (no cookies involved): open CORS, so
// browser-based clients such as MCP Inspector can use them.
const cors = (_req: Request, res: Response, next: () => void) => {
  res.set({ "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, mcp-protocol-version", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" });
  if (_req.method === "OPTIONS") res.status(204).end();
  else next();
};

export const oauthPublic = Router();
oauthPublic.use(["/.well-known", "/oauth/register", "/oauth/token", "/oauth/revoke"], cors);

// ---------------------------------------------------------------- discovery

const protectedResource = (_req: Request, res: Response) => {
  res.json({
    resource: resourceUrl(),
    authorization_servers: [issuer()],
    scopes_supported: ["mcp"],
    bearer_methods_supported: ["header"],
    resource_name: "Switchboard team MCP gateway",
  });
};
oauthPublic.get("/.well-known/oauth-protected-resource", protectedResource);
oauthPublic.get("/.well-known/oauth-protected-resource/mcp", protectedResource);

oauthPublic.get("/.well-known/oauth-authorization-server", (_req, res) => {
  res.json({
    issuer: issuer(),
    authorization_endpoint: `${issuer()}/oauth/authorize`,
    token_endpoint: `${issuer()}/oauth/token`,
    registration_endpoint: `${issuer()}/oauth/register`,
    revocation_endpoint: `${issuer()}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["mcp"],
  });
});

// ---------------------------------------------------------------- registration (RFC 7591)

const oauthError = (res: Response, status: number, error: string, description: string) => res.status(status).json({ error, error_description: description });

oauthPublic.post("/oauth/register", express.json({ limit: "16kb" }), async (req, res) => {
  const r = z
    .object({ redirect_uris: z.array(z.string().max(2000)).min(1).max(10), client_name: z.string().max(100).optional() })
    .passthrough()
    .safeParse(req.body ?? {});
  if (!r.success) return oauthError(res, 400, "invalid_client_metadata", r.error.issues[0].message);
  const bad = r.data.redirect_uris.find((u) => !validRedirect(u));
  if (bad) return oauthError(res, 400, "invalid_redirect_uri", `redirect URI not allowed: ${bad} (use https, a loopback http URL, or an app scheme)`);
  const n = await one<{ n: number }>("SELECT count(*)::int AS n FROM oauth_clients");
  if (n!.n >= MAX_CLIENTS) {
    // Open registration is an abuse vector: cap it and drop never-used clients.
    await q(`DELETE FROM oauth_clients c WHERE created_at < now() - interval '1 day'
              AND NOT EXISTS (SELECT 1 FROM oauth_tokens t WHERE t.client_id=c.client_id)`);
    const again = await one<{ n: number }>("SELECT count(*)::int AS n FROM oauth_clients");
    if (again!.n >= MAX_CLIENTS) return oauthError(res, 429, "temporarily_unavailable", "too many registered clients");
  }
  const clientId = `sbcl_${randomToken(16)}`;
  const name = (r.data.client_name || "MCP client").replace(/[\u0000-\u001f]/g, "");
  await q("INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES ($1,$2,$3)", [clientId, name, JSON.stringify(r.data.redirect_uris)]);
  res.status(201).json({
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: name,
    redirect_uris: r.data.redirect_uris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
});

// ---------------------------------------------------------------- authorization

interface AuthRequest {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  state?: string;
  resource: string;
}

function errorPage(res: Response, message: string) {
  res
    .status(400)
    .type("html")
    .send(`<!doctype html><meta charset="utf-8"><title>Authorization error</title><body style="font:15px system-ui;max-width:560px;margin:15vh auto;padding:0 16px"><h2>Cannot authorize this app</h2><p>${message.replace(/[<>&"]/g, "")}</p></body>`);
}

const withParams = (uri: string, params: Record<string, string | undefined>) => {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
};

oauthPublic.get("/oauth/authorize", async (req, res) => {
  const p = req.query as Record<string, string | undefined>;
  const client = p.client_id ? await one("SELECT * FROM oauth_clients WHERE client_id=$1", [p.client_id]) : undefined;
  // Without a valid client + redirect URI we must not redirect anywhere.
  if (!client) return errorPage(res, "Unknown client. The app must register first (dynamic client registration).");
  if (!p.redirect_uri || !redirectAllowed(client.redirect_uris, p.redirect_uri)) return errorPage(res, "The redirect URI does not match the one this app registered.");
  const fail = (error: string, description: string) => res.redirect(withParams(p.redirect_uri!, { error, error_description: description, state: p.state, iss: issuer() }));
  if (p.response_type !== "code") return fail("unsupported_response_type", "only response_type=code is supported");
  if (!p.code_challenge || p.code_challenge_method !== "S256") return fail("invalid_request", "PKCE with S256 is required");
  if (!sameResource(p.resource)) return fail("invalid_target", `this server only issues tokens for ${resourceUrl()}`);
  const request: AuthRequest = { client_id: client.client_id, redirect_uri: p.redirect_uri, code_challenge: p.code_challenge, state: p.state, resource: resourceUrl() };
  // The consent screen is part of the dashboard (it needs the sign-in session).
  res.redirect(`/consent?request=${encodeURIComponent(signToken({ r: request }, REQUEST_TTL_S, "oauth-request"))}`);
});

// Dashboard side of consent (session cookie + CSRF header, under /api).
export const oauthApi = Router();
oauthApi.use("/oauth", requireUser);

const readRequest = (token: unknown) => (typeof token === "string" ? verifyToken<{ r: AuthRequest }>(token, "oauth-request")?.r : undefined);

oauthApi.get("/oauth/request", async (req, res) => {
  const r = readRequest(req.query.request);
  if (!r) return void res.status(400).json({ error: "this authorization request is invalid or expired; start again from the app" });
  const client = await one("SELECT client_name FROM oauth_clients WHERE client_id=$1", [r.client_id]);
  if (!client) return void res.status(400).json({ error: "unknown client" });
  res.json({ clientName: client.client_name, redirectHost: new URL(r.redirect_uri).host || r.redirect_uri, resource: r.resource });
});

oauthApi.post("/oauth/decision", async (req, res) => {
  const r = readRequest(req.body?.request);
  if (!r) return void res.status(400).json({ error: "this authorization request is invalid or expired; start again from the app" });
  if (req.body?.approve !== true) {
    return void res.json({ redirectTo: withParams(r.redirect_uri, { error: "access_denied", error_description: "the user denied access", state: r.state, iss: issuer() }) });
  }
  const code = randomToken(32);
  await q(
    `INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, resource, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(secs => $7))`,
    [sha256(code), r.client_id, req.user!.id, r.redirect_uri, r.code_challenge, r.resource, CODE_TTL_S],
  );
  res.json({ redirectTo: withParams(r.redirect_uri, { code, state: r.state, iss: issuer() }) });
});

// Apps the signed-in user has authorized, and revoking them.
oauthApi.get("/oauth/grants", async (req, res) => {
  res.json(
    await q(
      `SELECT c.client_id, c.client_name, min(t.created_at) AS first_authorized, max(coalesce(t.last_used_at, t.created_at)) AS last_used
         FROM oauth_tokens t JOIN oauth_clients c ON c.client_id=t.client_id
        WHERE t.user_id=$1 AND t.revoked_at IS NULL AND t.expires_at > now() AND t.kind='refresh' AND t.rotated_at IS NULL
        GROUP BY c.client_id, c.client_name ORDER BY 4 DESC`,
      [req.user!.id],
    ),
  );
});

oauthApi.delete("/oauth/grants/:clientId", async (req, res) => {
  await q("UPDATE oauth_tokens SET revoked_at=now() WHERE user_id=$1 AND client_id=$2 AND revoked_at IS NULL", [req.user!.id, req.params.clientId]);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- token endpoint

async function issue(clientId: string, userId: string, resource: string, family: string = randomUUID()) {
  const access = OAUTH_TOKEN_PREFIX + randomToken(32);
  const refresh = `sbr_${randomToken(32)}`;
  await q(
    `INSERT INTO oauth_tokens (token_hash, kind, family, client_id, user_id, resource, expires_at) VALUES
       ($1, 'access', $3, $4, $5, $6, now() + make_interval(secs => $7)),
       ($2, 'refresh', $3, $4, $5, $6, now() + make_interval(secs => $8))`,
    [sha256(access), sha256(refresh), family, clientId, userId, resource, ACCESS_TTL_S, REFRESH_TTL_S],
  );
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: "mcp" };
}

oauthPublic.post("/oauth/token", express.urlencoded({ extended: false, limit: "16kb" }), express.json({ limit: "16kb" }), async (req, res) => {
  res.set("Cache-Control", "no-store");
  const b = (req.body ?? {}) as Record<string, string | undefined>;
  if (b.grant_type === "authorization_code") {
    if (!b.code || !b.code_verifier || !b.client_id) return oauthError(res, 400, "invalid_request", "code, code_verifier and client_id are required");
    // Single use: the UPDATE claims the code atomically.
    const row = await one(
      `UPDATE oauth_codes SET used_at=now() WHERE code_hash=$1 AND used_at IS NULL AND expires_at > now() RETURNING *`,
      [sha256(b.code)],
    );
    if (!row || row.client_id !== b.client_id || row.redirect_uri !== b.redirect_uri) return oauthError(res, 400, "invalid_grant", "invalid, expired or already used code");
    if (b64urlSha256(b.code_verifier) !== row.code_challenge) return oauthError(res, 400, "invalid_grant", "PKCE verification failed");
    if (!sameResource(b.resource)) return oauthError(res, 400, "invalid_target", `tokens are only issued for ${resourceUrl()}`);
    const user = await one("SELECT 1 FROM users WHERE id=$1 AND status='active'", [row.user_id]);
    if (!user) return oauthError(res, 400, "invalid_grant", "user is not active");
    return void res.json(await issue(row.client_id, row.user_id, row.resource));
  }
  if (b.grant_type === "refresh_token") {
    if (!b.refresh_token) return oauthError(res, 400, "invalid_request", "refresh_token is required");
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const t = (await c.query("SELECT * FROM oauth_tokens WHERE token_hash=$1 AND kind='refresh' FOR UPDATE", [sha256(b.refresh_token)])).rows[0];
      if (!t || (b.client_id && b.client_id !== t.client_id)) {
        await c.query("ROLLBACK");
        return oauthError(res, 400, "invalid_grant", "unknown refresh token");
      }
      if (t.rotated_at || t.revoked_at) {
        // Replay of a rotated token: someone else has a copy. Kill the grant.
        await c.query("UPDATE oauth_tokens SET revoked_at=now() WHERE family=$1 AND revoked_at IS NULL", [t.family]);
        await c.query("COMMIT");
        return oauthError(res, 400, "invalid_grant", "refresh token was already used; the grant has been revoked");
      }
      if (new Date(t.expires_at) < new Date()) {
        await c.query("ROLLBACK");
        return oauthError(res, 400, "invalid_grant", "refresh token expired");
      }
      const user = (await c.query("SELECT 1 FROM users WHERE id=$1 AND status='active'", [t.user_id])).rows[0];
      if (!user) {
        await c.query("ROLLBACK");
        return oauthError(res, 400, "invalid_grant", "user is not active");
      }
      await c.query("UPDATE oauth_tokens SET rotated_at=now() WHERE token_hash=$1", [t.token_hash]);
      await c.query("COMMIT");
      return void res.json(await issue(t.client_id, t.user_id, t.resource, t.family));
    } catch (err) {
      await c.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      c.release();
    }
  }
  oauthError(res, 400, "unsupported_grant_type", "use authorization_code or refresh_token");
});

// RFC 7009: revoking either token of a grant revokes the whole grant.
oauthPublic.post("/oauth/revoke", express.urlencoded({ extended: false, limit: "16kb" }), express.json({ limit: "16kb" }), async (req, res) => {
  const token = (req.body?.token as string | undefined) ?? "";
  const t = token ? await one("SELECT family FROM oauth_tokens WHERE token_hash=$1", [sha256(token)]) : undefined;
  if (t) await q("UPDATE oauth_tokens SET revoked_at=now() WHERE family=$1 AND revoked_at IS NULL", [t.family]);
  res.status(200).json({});
});

// Resolve an OAuth access token to its user, for the /mcp endpoint.
export async function oauthUser(token: string) {
  return one<{ id: string; email: string; role: "admin" | "member"; client_id: string; client_name: string; token_hash: string }>(
    `SELECT u.id, u.email, u.role, t.client_id, c.client_name, t.token_hash
       FROM oauth_tokens t JOIN users u ON u.id=t.user_id JOIN oauth_clients c ON c.client_id=t.client_id
      WHERE t.token_hash=$1 AND t.kind='access' AND t.revoked_at IS NULL AND t.expires_at > now()
        AND t.resource=$2 AND u.status='active'`,
    [sha256(token), resourceUrl()],
  );
}
