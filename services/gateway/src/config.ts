const req = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env ${name}`);
  return v;
};
const opt = (name: string, fallback: string) => process.env[name] || fallback;
const list = (name: string) =>
  (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export const config = {
  port: Number(opt("PORT", "8080")),
  databaseUrl: req("DATABASE_URL"),
  sessionSecret: req("SESSION_SECRET"),
  encryptionKey: req("ENCRYPTION_KEY"),
  // Public URL of the dashboard / gateway, shown to users for MCP client setup.
  publicUrl: opt("PUBLIC_URL", "http://gateway.localtest.me").replace(/\/$/, ""),
  cookieSecure: opt("COOKIE_SECURE", "false") === "true",

  admin: { email: process.env.ADMIN_EMAIL ?? "", password: process.env.ADMIN_PASSWORD ?? "" },

  upstream: {
    healthIntervalMs: Number(opt("HEALTH_INTERVAL_MS", "10000")),
    healthTimeoutMs: Number(opt("HEALTH_TIMEOUT_MS", "4000")),
    defaultCallTimeoutMs: Number(opt("DEFAULT_CALL_TIMEOUT_MS", "15000")),
    maxResultBytes: Number(opt("MAX_RESULT_BYTES", "262144")),
  },

  ssrf: {
    // Hosts that may resolve to private addresses, e.g. ".store.svc.cluster.local".
    allowedInternalSuffixes: list("SSRF_ALLOWED_INTERNAL_SUFFIXES"),
    allowHttp: opt("SSRF_ALLOW_HTTP", "true") === "true",
  },

  rateLimitPerMinute: Number(opt("RATE_LIMIT_PER_MINUTE", "120")),

  llm: {
    baseUrl: opt("LLM_BASE_URL", "https://api.groq.com/openai/v1").replace(/\/$/, ""),
    apiKey: process.env.LLM_API_KEY ?? "",
    model: opt("LLM_MODEL", "llama-3.3-70b-versatile"),
    maxSteps: Number(opt("CHAT_MAX_STEPS", "8")),
    timezone: opt("CHAT_TIMEZONE", "Asia/Kolkata"),
  },

  // JSON list of upstreams registered on first boot (see seed.ts).
  seedServers: opt("SEED_SERVERS", "[]"),
};
