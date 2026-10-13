// REST API for the React dashboard. Mounted at /api.
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAdmin, requireUser, SESSION_COOKIE, startSession, type User } from "./auth.js";
import { denialFor, fullCatalog } from "./catalog.js";
import { chatConfigured, runChat } from "./chat.js";
import { config } from "./config.js";
import { encrypt, hashPassword, newApiKey, randomToken, sha256, verifyPassword } from "./crypto.js";
import { one, q } from "./db.js";
import { platform } from "./api-platform.js";
import { SsrfError, validateUpstreamUrl } from "./ssrf.js";
import { toolFingerprint, upstreams, type ServerRow } from "./upstreams.js";

export const api = Router();

const parse = <T extends z.ZodTypeAny>(schema: T, req: Request, res: Response): z.infer<T> | undefined => {
  const r = schema.safeParse(req.body ?? {});
  if (!r.success) {
    res.status(400).json({ error: r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") });
    return undefined;
  }
  return r.data;
};

// ---------------------------------------------------------------- auth

api.post("/auth/login", async (req, res) => {
  const body = parse(z.object({ email: z.string().email(), password: z.string().min(1) }), req, res);
  if (!body) return;
  const u = await one<User & { password_hash: string }>("SELECT * FROM users WHERE lower(email)=lower($1) AND status='active'", [body.email]);
  if (!u || !verifyPassword(body.password, u.password_hash)) {
    res.status(401).json({ error: "wrong email or password" });
    return;
  }
  startSession(res, u.id);
  res.json({ id: u.id, email: u.email, name: u.name, role: u.role });
});

api.post("/auth/logout", (_req, res) => {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.json({ ok: true });
});

api.get("/auth/invite/:token", async (req, res) => {
  const u = await one("SELECT email, role FROM users WHERE invite_token_hash=$1 AND status='invited' AND invite_expires_at > now()", [sha256(req.params.token)]);
  if (!u) {
    res.status(404).json({ error: "invite link is invalid or expired" });
    return;
  }
  res.json(u);
});

api.post("/auth/accept-invite", async (req, res) => {
  const body = parse(z.object({ token: z.string().min(10), name: z.string().min(1).max(100), password: z.string().min(10).max(200) }), req, res);
  if (!body) return;
  const u = await one<User>(
    `UPDATE users SET status='active', name=$2, password_hash=$3, invite_token_hash=NULL, invite_expires_at=NULL
      WHERE invite_token_hash=$1 AND status='invited' AND invite_expires_at > now()
      RETURNING id, email, name, role, status`,
    [sha256(body.token), body.name, hashPassword(body.password)],
  );
  if (!u) {
    res.status(404).json({ error: "invite link is invalid or expired" });
    return;
  }
  startSession(res, u.id);
  res.json(u);
});

api.use(requireUser);

api.get("/me", (req, res) => {
  res.json({ ...req.user, chatEnabled: chatConfigured(), provisioningEnabled: config.provisioning.enabled, mcpUrl: `${config.publicUrl}/mcp` });
});

api.use(platform);

// ---------------------------------------------------------------- servers

const publicServer = (s: ServerRow, catalog: Awaited<ReturnType<typeof fullCatalog>>, user: User) => ({
  id: s.id,
  slug: s.slug,
  name: s.name,
  url: user.role === "admin" ? s.url : undefined,
  authType: s.auth_type,
  authHeaderName: s.auth_header_name,
  hasCredential: Boolean(s.credential_enc), // the value itself never leaves the server
  enabled: s.enabled,
  managedBy: s.managed_by, // 'store' / 'hosted': lifecycle owned by the platform
  timeoutMs: s.timeout_ms,
  status: s.enabled ? s.status : "disabled",
  statusReason: s.status_reason,
  lastCheckedAt: s.last_checked_at,
  lastOkAt: s.last_ok_at,
  tools: catalog
    .filter((e) => e.server.id === s.id)
    .map((e) => ({
      name: e.tool.name,
      exposedName: e.exposedName,
      description: e.tool.description ?? "",
      inputSchema: e.tool.inputSchema,
      adminOnly: e.policy.admin_only,
      hidden: e.policy.hidden,
      pendingReview: e.pendingReview,
      availableToMe: denialFor({ ...e, server: { ...e.server, status: "connected", enabled: true } }, { userId: user.id, email: user.email, role: user.role, via: "chat" }) === null,
    })),
});

api.get("/servers", async (req, res) => {
  const [servers, catalog] = await Promise.all([upstreams.servers(0), fullCatalog()]);
  res.json(servers.map((s) => publicServer(s, catalog, req.user!)));
});

const serverInput = z.object({
  name: z.string().min(1).max(80),
  slug: z
    .string()
    .regex(/^[a-z][a-z0-9-]{1,23}$/, "lowercase letters, digits and dashes, 2-24 chars, starting with a letter")
    .refine((s) => !s.includes("__") && s !== "switchboard", "reserved"),
  url: z.string().url(),
  authType: z.enum(["none", "bearer", "header"]).default("none"),
  authHeaderName: z.string().regex(/^[A-Za-z0-9-]{1,64}$/).optional().nullable(),
  credential: z.string().max(4096).optional(),
  timeoutMs: z.number().int().min(1000).max(120000).default(15000),
  enabled: z.boolean().default(true),
});

async function checkUrl(url: string, res: Response): Promise<boolean> {
  try {
    await validateUpstreamUrl(url);
    return true;
  } catch (err) {
    res.status(400).json({ error: err instanceof SsrfError ? `URL rejected: ${err.message}` : (err as Error).message });
    return false;
  }
}

api.post("/servers", requireAdmin, async (req, res) => {
  const b = parse(serverInput, req, res);
  if (!b || !(await checkUrl(b.url, res))) return;
  if (b.authType !== "none" && !b.credential) {
    res.status(400).json({ error: "credential is required for this auth type" });
    return;
  }
  if (await one("SELECT 1 FROM servers WHERE slug=$1", [b.slug])) {
    res.status(409).json({ error: `slug "${b.slug}" is already used` });
    return;
  }
  const row = await one<ServerRow>(
    `INSERT INTO servers (slug, name, url, auth_type, auth_header_name, credential_enc, timeout_ms, enabled, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [b.slug, b.name, b.url, b.authType, b.authType === "header" ? b.authHeaderName || "X-API-Key" : null, b.credential && b.authType !== "none" ? encrypt(b.credential) : null, b.timeoutMs, b.enabled, b.enabled ? "unknown" : "disabled"],
  );
  upstreams.invalidate();
  await upstreams.refresh(row!);
  const [servers, catalog] = await Promise.all([upstreams.servers(0), fullCatalog()]);
  res.status(201).json(publicServer(servers.find((s) => s.id === row!.id)!, catalog, req.user!));
});

api.patch("/servers/:id", requireAdmin, async (req, res) => {
  const b = parse(serverInput.partial().extend({ clearCredential: z.boolean().optional() }), req, res);
  if (!b) return;
  const cur = await upstreams.byId(String(req.params.id));
  if (!cur) {
    res.status(404).json({ error: "no such server" });
    return;
  }
  if (cur.managed_by) {
    // Platform-managed: only enable/disable, rename and timeout are editable.
    const extra = Object.keys(b).filter((k) => !["enabled", "name", "timeoutMs"].includes(k));
    if (extra.length) {
      res.status(409).json({ error: `this server is managed by its ${cur.managed_by}; ${extra.join(", ")} cannot be changed here` });
      return;
    }
  }
  if (b.url && b.url !== cur.url && !(await checkUrl(b.url, res))) return;
  const authType = b.authType ?? cur.auth_type;
  let credential = cur.credential_enc;
  if (b.clearCredential || authType === "none") credential = null;
  if (b.credential) credential = encrypt(b.credential);
  if (authType !== "none" && !credential) {
    res.status(400).json({ error: "credential is required for this auth type" });
    return;
  }
  // A URL change means a potentially different server: re-baseline its tools.
  const resetApproval = b.url !== undefined && b.url !== cur.url;
  const row = await one<ServerRow>(
    `UPDATE servers SET name=$2, slug=$3, url=$4, auth_type=$5, auth_header_name=$6, credential_enc=$7, timeout_ms=$8, enabled=$9,
            approved_tools = CASE WHEN $10 THEN NULL ELSE approved_tools END,
            tools = CASE WHEN $10 THEN '[]'::jsonb ELSE tools END,
            updated_at=now()
      WHERE id=$1 RETURNING *`,
    [cur.id, b.name ?? cur.name, b.slug ?? cur.slug, b.url ?? cur.url, authType, authType === "header" ? b.authHeaderName ?? cur.auth_header_name ?? "X-API-Key" : null, credential, b.timeoutMs ?? cur.timeout_ms, b.enabled ?? cur.enabled, resetApproval],
  );
  upstreams.invalidate();
  upstreams.drop(cur.id);
  await upstreams.refresh(row!);
  const [servers, catalog] = await Promise.all([upstreams.servers(0), fullCatalog()]);
  res.json(publicServer(servers.find((s) => s.id === row!.id)!, catalog, req.user!));
});

api.delete("/servers/:id", requireAdmin, async (req, res) => {
  const cur = await upstreams.byId(String(req.params.id));
  if (cur?.managed_by) {
    res.status(409).json({ error: `this server belongs to a ${cur.managed_by === "store" ? "provisioned store" : "hosted deployment"}; delete that instead` });
    return;
  }
  await q("DELETE FROM servers WHERE id=$1", [req.params.id]);
  upstreams.drop(String(req.params.id));
  upstreams.invalidate();
  res.json({ ok: true });
});

api.post("/servers/:id/refresh", requireAdmin, async (req, res) => {
  const row = await upstreams.byId(String(req.params.id));
  if (!row) {
    res.status(404).json({ error: "no such server" });
    return;
  }
  await upstreams.refresh(row);
  res.json({ ok: true });
});

// Accept the upstream's current tool definitions as the new baseline.
api.post("/servers/:id/approve-tools", requireAdmin, async (req, res) => {
  const row = await upstreams.byId(String(req.params.id));
  if (!row) {
    res.status(404).json({ error: "no such server" });
    return;
  }
  const approved = Object.fromEntries((row.tools ?? []).map((t) => [t.name, toolFingerprint(t)]));
  await q("UPDATE servers SET approved_tools=$2 WHERE id=$1", [row.id, JSON.stringify(approved)]);
  upstreams.invalidate();
  res.json({ ok: true });
});

api.put("/servers/:id/tools/:tool/policy", requireAdmin, async (req, res) => {
  const b = parse(z.object({ adminOnly: z.boolean(), hidden: z.boolean() }), req, res);
  if (!b) return;
  await q(
    `INSERT INTO tool_policies (server_id, tool_name, admin_only, hidden) VALUES ($1,$2,$3,$4)
     ON CONFLICT (server_id, tool_name) DO UPDATE SET admin_only=$3, hidden=$4`,
    [req.params.id, req.params.tool, b.adminOnly, b.hidden],
  );
  res.json({ ok: true });
});

// ---------------------------------------------------------------- members

api.get("/users", requireAdmin, async (_req, res) => {
  res.json(
    await q(`SELECT u.id, u.email, u.name, u.role, u.status, u.created_at,
                    (SELECT count(*)::int FROM api_keys k WHERE k.user_id=u.id AND k.revoked_at IS NULL) AS active_keys
               FROM users u ORDER BY u.created_at`),
  );
});

api.post("/users/invite", requireAdmin, async (req, res) => {
  const b = parse(z.object({ email: z.string().email(), role: z.enum(["admin", "member"]).default("member") }), req, res);
  if (!b) return;
  const token = randomToken(24);
  const existing = await one<User>("SELECT * FROM users WHERE lower(email)=lower($1)", [b.email]);
  if (existing && existing.status !== "invited") {
    res.status(409).json({ error: "a user with this email already exists" });
    return;
  }
  await q(
    `INSERT INTO users (email, role, status, invite_token_hash, invite_expires_at) VALUES ($1,$2,'invited',$3, now() + interval '7 days')
     ON CONFLICT (email) DO UPDATE SET role=$2, invite_token_hash=$3, invite_expires_at=now() + interval '7 days'`,
    [b.email.toLowerCase(), b.role, sha256(token)],
  );
  // No email service in this deployment: the admin shares the link.
  res.status(201).json({ inviteUrl: `${config.publicUrl}/invite/${token}`, expiresInDays: 7 });
});

api.patch("/users/:id", requireAdmin, async (req, res) => {
  const b = parse(z.object({ role: z.enum(["admin", "member"]).optional(), status: z.enum(["active", "disabled"]).optional() }), req, res);
  if (!b) return;
  if (req.params.id === req.user!.id) {
    res.status(400).json({ error: "you cannot change your own role or status" });
    return;
  }
  await q("UPDATE users SET role=COALESCE($2, role), status=COALESCE($3, status) WHERE id=$1 AND status <> 'invited'", [req.params.id, b.role ?? null, b.status ?? null]);
  res.json({ ok: true });
});

api.delete("/users/:id", requireAdmin, async (req, res) => {
  if (req.params.id === req.user!.id) {
    res.status(400).json({ error: "you cannot remove yourself" });
    return;
  }
  await q("DELETE FROM users WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- API keys

api.get("/keys", async (req, res) => {
  const all = req.user!.role === "admin" && req.query.all === "1";
  res.json(
    await q(
      `SELECT k.id, k.name, k.prefix, k.created_at, k.last_used_at, k.revoked_at, u.email AS user_email, k.user_id
         FROM api_keys k JOIN users u ON u.id=k.user_id
        WHERE ($1 OR k.user_id=$2) ORDER BY k.revoked_at NULLS FIRST, k.created_at DESC`,
      [all, req.user!.id],
    ),
  );
});

api.post("/keys", async (req, res) => {
  const b = parse(z.object({ name: z.string().min(1).max(80), userId: z.string().uuid().optional() }), req, res);
  if (!b) return;
  const owner = b.userId ?? req.user!.id;
  if (owner !== req.user!.id && req.user!.role !== "admin") {
    res.status(403).json({ error: "only admins can issue keys for other users" });
    return;
  }
  if (!(await one("SELECT 1 FROM users WHERE id=$1 AND status='active'", [owner]))) {
    res.status(400).json({ error: "that user is not active" });
    return;
  }
  const k = newApiKey();
  const row = await one("INSERT INTO api_keys (user_id, name, prefix, key_hash, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, prefix, created_at", [owner, b.name, k.prefix, k.hash, req.user!.id]);
  // The only time the plaintext key exists outside the client: we keep the hash.
  res.status(201).json({ ...row, key: k.key, mcpUrl: `${config.publicUrl}/mcp` });
});

api.delete("/keys/:id", async (req, res) => {
  const r = await q(
    "UPDATE api_keys SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL AND (user_id=$2 OR $3) RETURNING id",
    [req.params.id, req.user!.id, req.user!.role === "admin"],
  );
  if (!r.length) {
    res.status(404).json({ error: "no such active key" });
    return;
  }
  res.json({ ok: true });
});

// ---------------------------------------------------------------- audit + stats

api.get("/audit", async (req, res) => {
  const admin = req.user!.role === "admin";
  const limit = Math.min(Number(req.query.limit ?? 200), 1000);
  res.json(
    await q(
      `SELECT id, at, user_email, via, client, server_slug, tool_name, exposed_name, duration_ms, outcome, error
         FROM audit_log
        WHERE ($1 OR user_id=$2)
          AND ($3::text IS NULL OR user_email=$3)
          AND ($4::text IS NULL OR server_slug=$4)
          AND ($5::text IS NULL OR outcome=$5)
        ORDER BY at DESC LIMIT $6`,
      [admin, req.user!.id, (req.query.user as string) || null, (req.query.server as string) || null, (req.query.outcome as string) || null, limit],
    ),
  );
});

api.get("/stats", requireAdmin, async (_req, res) => {
  res.json(
    await q(`SELECT coalesce(server_slug, '-') AS server,
                    count(*)::int AS calls,
                    count(*) FILTER (WHERE outcome <> 'ok')::int AS failures,
                    round(percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms))::int AS p50_ms,
                    round(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms))::int AS p95_ms
               FROM audit_log WHERE at > now() - interval '24 hours'
              GROUP BY 1 ORDER BY 2 DESC`),
  );
});

// ---------------------------------------------------------------- chat

api.post("/chat", async (req, res) => {
  const b = parse(z.object({ messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(8000) })).min(1).max(40) }), req, res);
  if (!b) return;
  if (!chatConfigured()) {
    res.status(503).json({ error: "The chat agent has no LLM API key configured (llm-api-key in the gateway-secrets Secret)." });
    return;
  }
  try {
    res.json(await runChat(req.user!, b.messages));
  } catch (err: any) {
    console.error("chat failed", err);
    res.status(err.status === 429 ? 429 : 502).json({ error: err.message ?? "chat failed" });
  }
});
