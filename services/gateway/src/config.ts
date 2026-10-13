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
  // Required by the gateway (checked in server.ts); the provisioner has no use for it.
  sessionSecret: process.env.SESSION_SECRET ?? "",
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
    timeoutMs: Number(opt("LLM_TIMEOUT_MS", "120000")),
    timezone: opt("CHAT_TIMEZONE", "Asia/Kolkata"),
  },

  // Store provisioning + hosted MCP servers (bonus). The gateway API only
  // records desired state; the separate provisioner Deployment acts on it.
  provisioning: {
    enabled: opt("PROVISIONING_ENABLED", "false") === "true",
    storeUrlTemplate: opt("STORE_URL_TEMPLATE", "http://{slug}-store.localtest.me"),
    storeNamespacePrefix: opt("STORE_NAMESPACE_PREFIX", "store-"),
    storeChart: opt("STORE_CHART", "/opt/charts/woo-store"),
    storeValuesFile: opt("STORE_VALUES_FILE", "/config/store-values.yaml"),
    storeTimeoutMs: Number(opt("STORE_TIMEOUT_MS", "900000")),
    maxStoresPerUser: Number(opt("MAX_STORES_PER_USER", "2")),
    maxStoresTotal: Number(opt("MAX_STORES_TOTAL", "4")),
    hostedNamespace: opt("HOSTED_NAMESPACE", "mcp-hosted"),
    hostedImagePrefixes: list("HOSTED_IMAGE_PREFIXES"),
    hostedTimeoutMs: Number(opt("HOSTED_TIMEOUT_MS", "300000")),
    maxHosted: Number(opt("MAX_HOSTED_SERVERS", "5")),
    concurrency: Number(opt("PROVISIONER_CONCURRENCY", "3")),
    // Who the per-store RoleBinding grants access to (the provisioner itself).
    serviceAccount: opt("PROVISIONER_SERVICE_ACCOUNT", "gateway-provisioner"),
    serviceAccountNamespace: opt("PROVISIONER_NAMESPACE", "gateway"),
    tenantClusterRole: opt("TENANT_CLUSTER_ROLE", "switchboard-tenant"),
    // Where the gateway pods run (store/hosted NetworkPolicies admit only them).
    gatewayNamespace: opt("GATEWAY_NAMESPACE", "gateway"),
  },

  // JSON list of upstreams registered on first boot (see seed.ts).
  seedServers: opt("SEED_SERVERS", "[]"),
};
