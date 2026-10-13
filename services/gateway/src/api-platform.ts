// Dashboard API for the platform features: store provisioning and hosted
// (image-based) MCP servers. These handlers only record desired state; the
// provisioner Deployment does the Kubernetes work (see provisioner/main.ts).
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAdmin } from "./auth.js";
import { config } from "./config.js";
import { encrypt } from "./crypto.js";
import { one, q } from "./db.js";

export const platform = Router();
const P = config.provisioning;

const slugSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,20}[a-z0-9]$/, "lowercase letters, digits and dashes, 3-22 chars, starting with a letter")
  .refine((s) => !s.includes("--") && s !== "switchboard", "reserved");

const slugFromName = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^[^a-z]+/, "")
    .slice(0, 22)
    .replace(/-+$/, "");

function body<T extends z.ZodTypeAny>(schema: T, req: Request, res: Response): z.infer<T> | undefined {
  const r = schema.safeParse(req.body ?? {});
  if (!r.success) {
    res.status(400).json({ error: r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") });
    return undefined;
  }
  return r.data;
}

platform.use(["/stores", "/hosted"], (_req, res, next) => {
  if (!P.enabled) {
    res.status(404).json({ error: "provisioning is not enabled on this deployment" });
    return;
  }
  next();
});

async function slugTaken(slug: string): Promise<boolean> {
  return Boolean(
    await one(
      `SELECT 1 FROM servers WHERE slug=$1 UNION ALL SELECT 1 FROM stores WHERE slug=$1 UNION ALL SELECT 1 FROM hosted_servers WHERE slug=$1`,
      [slug],
    ),
  );
}

const canManage = (req: Request, ownerId: string | null) => req.user!.role === "admin" || ownerId === req.user!.id;

// ---------------------------------------------------------------- stores

const storeView = `
  SELECT s.id, s.slug, s.name, s.namespace, s.status, s.step, s.reason, s.url, s.attempts,
         s.created_at, s.ready_at, s.deadline, s.owner_id, u.email AS owner_email,
         sv.status AS server_status, jsonb_array_length(coalesce(sv.tools, '[]')) AS tool_count
    FROM stores s LEFT JOIN users u ON u.id=s.owner_id LEFT JOIN servers sv ON sv.id=s.server_id`;

platform.get("/stores", async (req, res) => {
  const admin = req.user!.role === "admin";
  res.json({
    limits: { perUser: P.maxStoresPerUser, total: P.maxStoresTotal, timeoutMinutes: P.storeTimeoutMs / 60000 },
    stores: await q(`${storeView} WHERE ($1 OR s.owner_id=$2) ORDER BY s.created_at`, [admin, req.user!.id]),
  });
});

platform.post("/stores", async (req, res) => {
  const b = body(z.object({ name: z.string().trim().min(2).max(60), slug: z.string().optional() }), req, res);
  if (!b) return;
  const slug = b.slug || slugFromName(b.name);
  const ok = slugSchema.safeParse(slug);
  if (!ok.success) {
    res.status(400).json({ error: `store id "${slug}": ${ok.error.issues[0].message}` });
    return;
  }
  // Safe to retry: the same user creating the same store gets the existing one back.
  const existing = await one(`${storeView} WHERE s.slug=$1`, [slug]);
  if (existing && existing.owner_id === req.user!.id && existing.status !== "deleting") {
    res.status(200).json(existing);
    return;
  }
  if (existing || (await slugTaken(slug))) {
    res.status(409).json({ error: `"${slug}" is already used by another store or server` });
    return;
  }
  const counts = await one<{ mine: number; total: number }>(
    "SELECT count(*) FILTER (WHERE owner_id=$1)::int AS mine, count(*)::int AS total FROM stores",
    [req.user!.id],
  );
  if (counts!.mine >= P.maxStoresPerUser) {
    res.status(429).json({ error: `you already have ${counts!.mine} stores (limit ${P.maxStoresPerUser} per user)` });
    return;
  }
  if (counts!.total >= P.maxStoresTotal) {
    res.status(429).json({ error: `this platform is at its limit of ${P.maxStoresTotal} stores` });
    return;
  }
  const row = await one(
    `INSERT INTO stores (slug, name, owner_id, namespace, status, step, deadline)
     VALUES ($1, $2, $3, $4, 'provisioning', 'queued', now() + make_interval(secs => $5))
     ON CONFLICT (slug) DO NOTHING RETURNING id`,
    [slug, b.name, req.user!.id, P.storeNamespacePrefix + slug, P.storeTimeoutMs / 1000],
  );
  if (!row) {
    res.status(409).json({ error: `"${slug}" was just taken` });
    return;
  }
  res.status(202).json(await one(`${storeView} WHERE s.id=$1`, [row.id]));
});

platform.post("/stores/:id/retry", async (req, res) => {
  const s = await one("SELECT * FROM stores WHERE id=$1", [req.params.id]);
  if (!s || !canManage(req, s.owner_id)) {
    res.status(404).json({ error: "no such store" });
    return;
  }
  if (s.status !== "failed") {
    res.status(409).json({ error: `store is ${s.status}; only failed stores can be retried` });
    return;
  }
  await q(
    `UPDATE stores SET status='provisioning', step='queued', reason=NULL, attempts=attempts+1,
            deadline=now() + make_interval(secs => $2), updated_at=now() WHERE id=$1`,
    [s.id, P.storeTimeoutMs / 1000],
  );
  res.status(202).json({ ok: true });
});

platform.delete("/stores/:id", async (req, res) => {
  const s = await one("SELECT * FROM stores WHERE id=$1", [req.params.id]);
  if (!s || !canManage(req, s.owner_id)) {
    res.status(404).json({ error: "no such store" });
    return;
  }
  await q("UPDATE stores SET status='deleting', step='queued for deletion', reason=NULL, updated_at=now() WHERE id=$1", [s.id]);
  res.status(202).json({ ok: true });
});

// ---------------------------------------------------------------- hosted MCP servers (admin only)

const RESERVED_ENV = /^(PATH|HOME|HOSTNAME|KUBERNETES_.*|NODE_OPTIONS|LD_.*)$/;
const envMap = z
  .record(z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/, "env names: UPPER_SNAKE_CASE"), z.string().max(4096))
  .refine((m) => Object.keys(m).length <= 30, "at most 30 variables")
  .refine((m) => !Object.keys(m).some((k) => RESERVED_ENV.test(k)), "reserved variable name");

const hostedInput = z.object({
  name: z.string().trim().min(2).max(60),
  slug: slugSchema,
  image: z.string().regex(/^[a-z0-9.\-_/:@]+$/i, "invalid image reference").max(300),
  port: z.number().int().min(1024).max(65535).default(8080),
  path: z.string().regex(/^\/[A-Za-z0-9._~\-/]*$/).max(100).default("/mcp"),
  env: envMap.default({}),
  secretEnv: envMap.default({}),
  allowInternet: z.boolean().default(false),
  size: z.enum(["small", "medium"]).default("small"),
});

const hostedView = `
  SELECT h.id, h.slug, h.name, h.image, h.port, h.path, h.env, h.allow_internet, h.size, h.status, h.step, h.reason,
         h.attempts, h.created_at, h.ready_at, (h.secret_env_enc IS NOT NULL) AS has_secrets,
         sv.status AS server_status, jsonb_array_length(coalesce(sv.tools, '[]')) AS tool_count
    FROM hosted_servers h LEFT JOIN servers sv ON sv.id=h.server_id`;

platform.get("/hosted", requireAdmin, async (_req, res) => {
  res.json({
    imagePrefixes: P.hostedImagePrefixes,
    servers: await q(`${hostedView} ORDER BY h.created_at`),
  });
});

platform.post("/hosted", requireAdmin, async (req, res) => {
  const b = body(hostedInput, req, res);
  if (!b) return;
  if (P.hostedImagePrefixes.length && !P.hostedImagePrefixes.some((p) => b.image.startsWith(p))) {
    res.status(400).json({ error: `image must come from an allowed registry: ${P.hostedImagePrefixes.join(", ")}` });
    return;
  }
  if (await slugTaken(b.slug)) {
    res.status(409).json({ error: `"${b.slug}" is already used` });
    return;
  }
  const n = await one<{ n: number }>("SELECT count(*)::int AS n FROM hosted_servers");
  if (n!.n >= P.maxHosted) {
    res.status(429).json({ error: `limit of ${P.maxHosted} hosted servers reached` });
    return;
  }
  const secrets = Object.keys(b.secretEnv).length ? encrypt(JSON.stringify(b.secretEnv)) : null;
  const row = await one(
    `INSERT INTO hosted_servers (slug, name, image, port, path, env, secret_env_enc, allow_internet, size, owner_id, status, step, deadline)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'provisioning','queued', now() + make_interval(secs => $11))
     ON CONFLICT (slug) DO NOTHING RETURNING id`,
    [b.slug, b.name, b.image, b.port, b.path, JSON.stringify(b.env), secrets, b.allowInternet, b.size, req.user!.id, P.hostedTimeoutMs / 1000],
  );
  if (!row) {
    res.status(409).json({ error: `"${b.slug}" was just taken` });
    return;
  }
  res.status(202).json(await one(`${hostedView} WHERE h.id=$1`, [row.id]));
});

platform.post("/hosted/:id/retry", requireAdmin, async (req, res) => {
  const r = await q(
    `UPDATE hosted_servers SET status='provisioning', step='queued', reason=NULL, attempts=attempts+1,
            deadline=now() + make_interval(secs => $2), updated_at=now() WHERE id=$1 AND status='failed' RETURNING id`,
    [req.params.id, P.hostedTimeoutMs / 1000],
  );
  if (!r.length) {
    res.status(409).json({ error: "only failed hosted servers can be retried" });
    return;
  }
  res.status(202).json({ ok: true });
});

platform.delete("/hosted/:id", requireAdmin, async (req, res) => {
  const r = await q("UPDATE hosted_servers SET status='deleting', step='queued for deletion', reason=NULL, updated_at=now() WHERE id=$1 RETURNING id", [req.params.id]);
  if (!r.length) {
    res.status(404).json({ error: "no such hosted server" });
    return;
  }
  res.status(202).json({ ok: true });
});
