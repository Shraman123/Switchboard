import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

const encKey = createHash("sha256").update("switchboard-credentials:" + config.encryptionKey).digest();

// Upstream credentials are encrypted at rest with AES-256-GCM. The key comes
// from a Kubernetes Secret, so a database dump alone does not reveal them.
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", encKey, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
}

export function decrypt(blob: string): string {
  const [v, iv, tag, ct] = blob.split(":");
  if (v !== "v1") throw new Error("unknown credential format");
  const d = createDecipheriv("aes-256-gcm", encKey, Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8");
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

// API keys are 256-bit random values, so a fast hash (SHA-256) is enough:
// slow hashes defend low-entropy passwords against guessing; these can't be guessed.
export const API_KEY_PREFIX = "sbk_";
export function newApiKey() {
  const key = API_KEY_PREFIX + randomToken(32);
  return { key, hash: sha256(key), prefix: key.slice(0, 12) };
}

// Passwords are low entropy: scrypt with a per-user salt.
export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const h = scryptSync(pw, salt, 32);
  return `scrypt:${salt.toString("base64")}:${h.toString("base64")}`;
}

export function verifyPassword(pw: string, stored: string | null): boolean {
  if (!stored) return false;
  const [alg, salt, hash] = stored.split(":");
  if (alg !== "scrypt") return false;
  const h = scryptSync(pw, Buffer.from(salt, "base64"), 32);
  return timingSafeEqual(h, Buffer.from(hash, "base64"));
}

// Small signed tokens (HMAC-SHA256) for dashboard sessions and for the chat
// agent's short-lived "act as this user" credential.
export function signToken(payload: Record<string, unknown>, ttlSeconds: number, purpose: string): string {
  const body = Buffer.from(JSON.stringify({ ...payload, p: purpose, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString("base64url");
  const sig = createHmac("sha256", config.sessionSecret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyToken<T>(token: string, purpose: string): T | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const want = createHmac("sha256", config.sessionSecret).update(body).digest();
  const got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  const data = JSON.parse(Buffer.from(body, "base64url").toString());
  if (data.p !== purpose || typeof data.exp !== "number" || data.exp < Date.now() / 1000) return null;
  return data as T;
}
