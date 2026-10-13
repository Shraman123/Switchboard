import type { NextFunction, Request, Response } from "express";
import type { Principal } from "./catalog.js";
import { config } from "./config.js";
import { API_KEY_PREFIX, sha256, signToken, verifyToken } from "./crypto.js";
import { one, q } from "./db.js";
import { metrics } from "./metrics.js";
import { OAUTH_TOKEN_PREFIX, oauthUser, resourceMetadataUrl } from "./oauth.js";

export interface User {
  id: string;
  email: string;
  name: string;
  role: "admin" | "member";
  status: "invited" | "active" | "disabled";
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
      principal?: Principal;
    }
  }
}

export const SESSION_COOKIE = "sb_session";
const SESSION_TTL = 12 * 3600;

export function startSession(res: Response, userId: string) {
  res.cookie(SESSION_COOKIE, signToken({ sub: userId }, SESSION_TTL, "session"), {
    httpOnly: true,
    sameSite: "lax",
    secure: config.cookieSecure,
    maxAge: SESSION_TTL * 1000,
    path: "/",
  });
}

const activeUser = (id: string) => one<User>("SELECT id, email, name, role, status FROM users WHERE id=$1 AND status='active'", [id]);

// Dashboard API: httpOnly session cookie. The user row is re-read on every
// request, so disabling a user or changing a role takes effect immediately.
export async function requireUser(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.[SESSION_COOKIE];
  const data = token ? verifyToken<{ sub: string }>(token, "session") : null;
  const user = data ? await activeUser(data.sub) : undefined;
  if (!user) {
    res.status(401).json({ error: "not signed in" });
    return;
  }
  req.user = user;
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.user?.role !== "admin") {
    res.status(403).json({ error: "admins only" });
    return;
  }
  next();
}

// The chat agent connects to the gateway's own MCP endpoint with this
// short-lived token, so its calls go through exactly the same auth, policy
// and audit path as an external client, attributed to the signed-in user.
const CHAT_PREFIX = "sbc_";
export const chatToken = (userId: string) => CHAT_PREFIX + signToken({ sub: userId }, 300, "chat");

const lastUsedWrites = new Map<string, number>();

// Resolve an MCP request's bearer token to a principal, or null.
export async function principalFromBearer(header: string | undefined): Promise<Principal | null> {
  const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (token.startsWith(API_KEY_PREFIX)) {
    const row = await one<User & { key_id: string; key_name: string }>(
      `SELECT u.id, u.email, u.name, u.role, u.status, k.id AS key_id, k.name AS key_name
         FROM api_keys k JOIN users u ON u.id = k.user_id
        WHERE k.key_hash = $1 AND k.revoked_at IS NULL AND u.status = 'active'`,
      [sha256(token)],
    );
    if (!row) return null;
    const last = lastUsedWrites.get(row.key_id) ?? 0;
    if (Date.now() - last > 60_000) {
      lastUsedWrites.set(row.key_id, Date.now());
      q("UPDATE api_keys SET last_used_at=now() WHERE id=$1", [row.key_id]).catch(() => {});
    }
    return { userId: row.id, email: row.email, role: row.role, via: "mcp", apiKeyId: row.key_id, client: `key: ${row.key_name}` };
  }
  if (token.startsWith(OAUTH_TOKEN_PREFIX)) {
    const row = await oauthUser(token);
    if (!row) return null;
    const last = lastUsedWrites.get(row.token_hash) ?? 0;
    if (Date.now() - last > 60_000) {
      lastUsedWrites.set(row.token_hash, Date.now());
      q("UPDATE oauth_tokens SET last_used_at=now() WHERE token_hash=$1", [row.token_hash]).catch(() => {});
    }
    return { userId: row.id, email: row.email, role: row.role, via: "oauth", client: `app: ${row.client_name}` };
  }
  if (token.startsWith(CHAT_PREFIX)) {
    const data = verifyToken<{ sub: string }>(token.slice(CHAT_PREFIX.length), "chat");
    const user = data ? await activeUser(data.sub) : undefined;
    if (!user) return null;
    return { userId: user.id, email: user.email, role: user.role, via: "chat" };
  }
  return null;
}

export async function requireMcpPrincipal(req: Request, res: Response, next: NextFunction) {
  const p = await principalFromBearer(req.header("authorization"));
  if (!p) {
    const presented = Boolean(req.header("authorization"));
    metrics.authFailures.inc({ reason: presented ? "invalid_or_revoked" : "missing" });
    // resource_metadata tells an OAuth-capable MCP client where to log in
    // (RFC 9728); API-key clients just see a 401.
    res
      .status(401)
      .set("WWW-Authenticate", `Bearer realm="switchboard", resource_metadata="${resourceMetadataUrl()}"${presented ? ', error="invalid_token"' : ""}`)
      .json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized: missing, invalid, expired or revoked API key / access token" }, id: null });
    return;
  }
  req.principal = p;
  next();
}
