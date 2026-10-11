# System design and tradeoffs

## Components

```
                         Internet / laptop
                                │
                     Traefik Ingress (k3s built-in)
          store.<domain>        │          gateway.<domain>
       ┌────────────────────────┴──────────────────────────────┐
       │                                                        │
 ns: store                                         ns: gateway
 ┌──────────────┐  REST (OAuth1-signed)  ┌──────────────┐     ┌──────────────────────────┐
 │ WordPress +  │◀───────────────────────│ woo-mcp      │◀────│ gateway-backend (x2)     │
 │ WooCommerce  │                        │ (ClusterIP   │ MCP │  /api   dashboard API    │
 │ (web)        │                        │  only)       │     │  /mcp   team MCP server  │
 └──────┬───────┘                        └──────────────┘     │  chat agent (MCP client  │
        │ 3306                                                │   of its own /mcp)       │
 ┌──────▼───────┐                        ns: mcp-servers      │  health loop + upstream  │
 │ MariaDB      │                        ┌──────────────┐ MCP │   MCP clients            │
 │ (PVC)        │                        │ notes        │◀────│                          │
 └──────────────┘                        │ everything   │◀────│                          │
 bootstrap Job (Helm hook)               └──────────────┘     └───────┬──────────┬───────┘
                                                                      │          │ HTTPS
                                                              ┌───────▼──────┐   ▼
                                                              │ Postgres     │  LLM API, external
                                                              │ (PVC)        │  MCP servers
                                                              └──────────────┘
                                                              gateway-dashboard (nginx, SPA)
```

| Component | What it does | Why this shape |
|---|---|---|
| **woo-store** chart | WordPress 7.1 + WooCommerce 11.2 (one image), MariaDB StatefulSet, an idempotent bootstrap Job, the WooCommerce MCP server, NetworkPolicies | One chart = one store with *its own* MCP server. This is the unit the multi-store bonus would stamp out per namespace. |
| **woo-mcp** | MCP server (Streamable HTTP, stateless) with `list_products`, `create_product`, `list_orders`, `get_order`, `update_order_status` | Written from scratch on the official TypeScript SDK. |
| **gateway** chart | Backend (2 replicas), dashboard (nginx), Postgres, Ingress, NetworkPolicies, PDB | The backend is both an MCP *client* (to every upstream) and an MCP *server* (to every member). |
| **mcp-servers** chart | Two extra upstreams: `notes` (my small server, needs a bearer token) and `everything` (the official MCP reference server, unmodified) | Shows a credentialed upstream and a third-party one. Both expose a tool named `echo`, a real name collision. |

## How the WooCommerce MCP server talks to the store

**REST API v3 (`/wp-json/wc/v3`) with a consumer key, signed with OAuth 1.0a (HMAC-SHA256).**

- **Why REST and not WP-CLI or SQL:** REST is WooCommerce's supported contract. It runs WooCommerce's validation, hooks, stock handling and order-status transitions (emails, notes), and it survives WooCommerce upgrades. WP-CLI would need a shell in the WordPress pod (exec rights or a sidecar with the PVC mounted). Direct SQL bypasses all business logic and breaks with HPOS order tables.
- **Why OAuth1:** inside the cluster the hop is plain HTTP to a ClusterIP Service. WooCommerce only accepts consumer keys over HTTP when the request is OAuth1-signed. That is a good property: the consumer **secret never crosses the network**, only an HMAC signature with a nonce and timestamp, and WooCommerce rejects replays. (One detail I had to match exactly: WooCommerce builds the signature base string from the site's *home URL*, not the host we connect to, so the client reads the home URL from `/wp-json/` first. See `services/woo-mcp/src/woo.ts`.)
- **Key provisioning:** `scripts/create-secrets.sh` generates `ck_…`/`cs_…` into a Kubernetes Secret. The bootstrap Job registers that pair in WooCommerce's `woocommerce_api_keys` table (hashed, as WooCommerce stores it). The MCP pod reads the same Secret. Nobody copies a key out of wp-admin.

## Tool aggregation and routing

1. **Health loop** (every 10 s, per replica). For each enabled server: connect (or reuse) an MCP client with the server's decrypted credential header, `tools/list` with a 4 s timeout, and write status + tools to Postgres. A failure marks the server `unreachable` with a human-readable reason (`connection refused (nothing listening — pod down?) [ECONNREFUSED]`, `HTTP 401 from upstream (check the server credential)`, `timed out after 4000ms`, …).
2. **`tools/list` on the gateway** never contacts an upstream. It reads the cached catalog from Postgres and returns tools that are: from an enabled + connected server, not hidden, not pending review, and allowed for the caller's role. So a slow or dead upstream cannot slow down or break listing.
3. **Naming:** every tool is exposed as **`<server-slug>__<tool>`**, e.g. `woo__list_orders`, `notes__echo`, `everything__echo`. It is *always* prefixed, not only on collision. Names are then stable: adding a server can never rename a tool a client already uses, and the model can see which system a tool belongs to (the description is also prefixed with `[Server name]`). Slugs are validated (`^[a-z][a-z0-9-]{1,23}$`, no `__`). Tool names with characters outside `[A-Za-z0-9_-]`, or results over 64 chars, are sanitised and suffixed with a short hash so they stay unique.
4. **`tools/call`** looks the exposed name up in the catalog, which gives the server row and the original tool name. It checks policy, applies the rate limit, calls the upstream with the server's timeout (default 15 s, configurable per server), writes the audit row and returns the result (capped at 256 KB).
5. **Failure handling.** If the upstream restarted and forgot our session (HTTP 404), the client is rebuilt and the call retried **once**. Otherwise the error becomes a normal MCP tool result with `isError: true` and a clear message (`Upstream call failed (unavailable): Team Notes: connection refused …`). An `unavailable` failure also marks the server unreachable immediately, so its tools leave the list without waiting for the next health tick. Other servers are unaffected: every upstream has its own client and its own timeout.

The gateway's own MCP endpoint is **stateless** Streamable HTTP. Each request builds a throwaway MCP `Server` bound to the caller's identity, and there is no session state. That is what makes 2+ replicas and rolling updates trivial (no sticky sessions, no session store). The tradeoff: the gateway can't push `notifications/tools/list_changed`, so clients see a disabled server's tools disappear on their next `tools/list`. Most clients re-list on reconnect; in Claude Code, `/mcp` → reconnect.

**Many tools.** `/mcp?tools=search` exposes two meta-tools instead: `switchboard__search_tools` (keyword-ranked over names and descriptions, returns full schemas) and `switchboard__call_tool`. The chat agent switches to this mode automatically above 40 tools. Permission checks and audit are identical because `call_tool` goes through the same router.

## Identity, roles, keys

- Roles: `admin` (manage servers, members, keys, tool policies; see all audit) and `member` (use tools; generate/revoke own keys; see own audit).
- **Per-tool policy:** an admin can mark any tool `admins only` (hidden from members' `tools/list` *and* rejected if called by name) or `hidden` (for everyone). Seeded defaults: `woo__create_product` and `woo__update_order_status` are admin-only, and the reference server's `get-env` and trigger/toggle tools are hidden.
- API keys: `sbk_` + 256 random bits, shown once, stored as SHA-256. A fast hash is right here: slow hashes protect low-entropy passwords against guessing, and these can't be guessed. Revocation sets `revoked_at`. Every request re-checks the key *and* that the user is still active, so revoking a key or disabling a user is immediate on all replicas.
- Dashboard sessions: HMAC-signed httpOnly cookie (SameSite=Lax, `Secure` in prod). CSRF: every state-changing request must carry `X-Switchboard: 1`, which a cross-site page can't send without a CORS preflight the API never answers.
- Passwords: scrypt with per-user salt. Invites are single-use tokens (hashed in DB, 7-day expiry). There's no email service, so the admin shares the link.

## Chat agent

`services/gateway/src/chat.ts`, a plain loop:

1. Mint a 5-minute **chat token** for the signed-in user (HMAC, purpose-bound, so it can't be used as a session cookie or vice versa).
2. Connect to the gateway's *own* `/mcp` over HTTP as that user. The agent therefore goes through exactly the same auth → policy → rate limit → audit path as Claude Code would. It can't see admin-only tools if the user is a member, and its calls appear in the audit log as `via: chat agent` under the user.
3. Send the tools (OpenAI function-calling format) + history to the LLM. The provider is any OpenAI-compatible endpoint (default Groq free tier; Ollama or OpenAI work by changing two values).
4. Execute each requested tool call through MCP, append results, repeat until the model answers in text or 8 steps pass. The UI shows each step's tool, arguments, result and latency.

The system prompt carries the current date/time in the store timezone ("today" questions) and a standing rule that tool descriptions and results are untrusted data, not instructions.

`test/fake-llm` is a scripted OpenAI-compatible endpoint used to test the loop deterministically without an API key.

## Kubernetes

| Namespace | Workloads | Volumes | Exposure |
|---|---|---|---|
| `store` | `woo-store-web` (Deployment, Recreate), `woo-store-db` (StatefulSet), `woo-store-mcp` (Deployment), `woo-store-bootstrap` (Job, Helm hook) | `woo-store-wp-content` PVC (`helm.sh/resource-policy: keep`), `data-woo-store-db-0` PVC | Storefront via Ingress; MCP **ClusterIP only** |
| `gateway` | `gateway-backend` (Deployment ×2 + PDB), `gateway-dashboard` (Deployment), `gateway-postgres` (StatefulSet) | `data-gateway-postgres-0` PVC | `/`, `/api`, `/mcp` via Ingress; `/metrics` internal |
| `mcp-servers` | `notes`, `everything` | none | ClusterIP only |

- **Every workload** has readiness + liveness probes (and startup probes where boot is slow) and CPU/memory requests and limits. WordPress readiness hits `/wp-login.php`, which runs PHP and opens a DB connection, so a DB outage takes it out of rotation. Liveness hits a static file, so a DB outage does not cause restart loops.
- **Non-root everywhere.** Apache is moved to port 8080 so WordPress runs as uid 33 with no capabilities. Node services run as uid 1000 with a read-only root filesystem, `seccompProfile: RuntimeDefault`, `allowPrivilegeEscalation: false`, all capabilities dropped. No pod mounts a ServiceAccount token (nothing talks to the Kubernetes API).
- **WordPress layout:** core files are baked into the image (immutable, versioned by tag). Only `wp-content` (plugins, uploads) is persistent. `wp-config.php` is the env-driven docker variant, so DB credentials and salts come from the Secret.
- **NetworkPolicies, default deny** in all three namespaces, then explicit allows:
  - MariaDB ← only this store's WordPress + bootstrap Job.
  - WordPress ← Traefik and this store's MCP server; → only its DB (no internet; `WP_HTTP_BLOCK_EXTERNAL` too).
  - woo-mcp ← only pods labelled `app.kubernetes.io/component=gateway` in the `gateway` namespace; → only its WordPress.
  - notes/everything ← only the gateway; → DNS only.
  - gateway-backend → its Postgres, ports 8080 in `store` + `mcp-servers`, and the internet on 80/443 **excluding** 10/8, 172.16/12, 192.168/16, 100.64/10, 169.254/16, 127/8.
- **Secrets:** generated at deploy time by `scripts/create-secrets.sh` (idempotent, never overwrites) into `store-credentials`, `notes-credentials`, `gateway-secrets`, `gateway-upstream-seed`. Charts only reference Secret names. Nothing secret is in git or in values files.

## What changes for production

Only values files change (`values-local.yaml` → `values-prod.yaml`); the templates are identical.

| Concern | Local (k3d) | VPS (k3s) |
|---|---|---|
| DNS | `*.localtest.me` (public DNS → 127.0.0.1, no hosts file) | Real A records → VPS IP: `siteUrl`, `publicUrl` |
| Ingress | k3s Traefik, host port 80 mapped by k3d | Same Traefik on the VPS's 80/443 |
| TLS | off | `ingress.tls.enabled: true` + `cert-manager.io/cluster-issuer` annotation; `backend.cookieSecure: true` |
| Storage | `local-path` | `local-path` (single node) or a cloud CSI class via `storageClass`; bigger sizes |
| Images | `registry.localhost:5111/...:dev`, `pullPolicy: Always` | `ghcr.io/<you>/switchboard/...:<semver>`, `IfNotPresent` |
| Secrets | `create-secrets.sh` | the same script, or Sealed Secrets / External Secrets producing the same Secret names |
| SSRF | `allowHttp: true` | `allowHttp: false` (external upstreams must be HTTPS) |

See `docs/OPERATIONS.md` for the VPS walkthrough, upgrades and rollback.

## Tradeoffs I chose deliberately

- **Polling health checks over push.** Simple and robust: a dead upstream is noticed within one interval, or immediately on a failed call. It costs one `tools/list` per server per 10 s per replica.
- **Postgres as the shared brain.** Config, tool cache, audit, rate-limit counters and policies all live there, so replicas need no coordination channel. One query per MCP request is cheap at team scale.
- **Prefix-always naming** over "prefix only on collision": slightly longer names, but no surprise renames.
- **The chat agent goes through HTTP to its own endpoint** instead of calling the router in-process: one extra local hop, in exchange for a single enforcement path for everything.
- **In-memory notes server.** It's an example upstream; restarting it resets notes. That is fine for demonstrating failure handling.
