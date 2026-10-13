# Switchboard: a team MCP gateway on Kubernetes

A WooCommerce store, an MCP server for it (written from scratch), and a team **MCP gateway** with a React dashboard and a chat agent, all running on Kubernetes and deployed with Helm.

An admin registers MCP servers once. Every team member then gets **every enabled server's tools through one URL and their own API key**, in Claude Code, Cursor, MCP Inspector or the dashboard's chat. Members never see upstream credentials, and every tool call lands in an audit log under the person who made it.

```
Claude Code / Cursor / Inspector ──┐                       ┌─▶ woo-mcp ──OAuth1 REST──▶ WooCommerce ─▶ MariaDB
   (gateway URL + sbk_ API key)    ├─▶  gateway  /mcp  ────┼─▶ notes   (bearer token held by gateway)
Dashboard chat agent ──────────────┘   (auth · policy ·    └─▶ everything (official MCP reference server)
   (acts as the signed-in user)         audit · timeouts)
```

- **Design and tradeoffs:** [docs/DESIGN.md](docs/DESIGN.md)
- **Threat model:** [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md)
- **VPS, upgrades, rollback:** [docs/OPERATIONS.md](docs/OPERATIONS.md)

## Repository layout

| Path | What |
|---|---|
| `services/woo-mcp` | WooCommerce MCP server (TypeScript, MCP SDK, Streamable HTTP): `list_products`, `create_product`, `list_orders`, `get_order`, `update_order_status` |
| `services/gateway` | Gateway backend: MCP client to upstreams, MCP server at `/mcp`, dashboard API at `/api`, chat agent, audit, metrics |
| `services/dashboard` | React dashboard (Vite, served by unprivileged nginx) |
| `services/notes-mcp` | Second upstream: small team-notes MCP server that requires a bearer token |
| `images/woo-store` | WordPress 7.1.3 + WooCommerce 11.2.1 image and the idempotent store bootstrap |
| `images/everything-mcp` | Third upstream: the official MCP reference server, unmodified |
| `charts/{woo-store,gateway,mcp-servers}` | Helm charts, each with `values.yaml`, `values-local.yaml`, `values-prod.yaml` |
| `scripts/` | `up-local.sh`, `deploy.sh`, `create-secrets.sh`, `build-images.sh`, `credentials.sh`, `smoke-test.sh` |
| `test/fake-llm` | Scripted OpenAI-compatible endpoint for testing the chat tool loop without an API key |

## Local setup (k3d)

**Prerequisites:** Docker, [k3d](https://k3d.io) ≥ 5.8, kubectl, Helm 3, bash (Git Bash on Windows), Python 3 (used by the scripts for JSON), about 4 GB of RAM free for Docker, and [Ollama](https://ollama.com) for the chat agent's local model.

**Chat model.** `values-local.yaml` points the chat agent at Ollama on the host (`192.168.65.254:11434`, Docker Desktop's host address; on Linux use the docker bridge gateway IP) with `qwen2.5:3b`, and adds one narrow NetworkPolicy egress rule for exactly that IP and port. To use a hosted model instead (e.g. Groq's free tier), remove the `llm:` and `networkPolicy:` blocks from `values-local.yaml` and run `LLM_API_KEY=gsk_... scripts/create-secrets.sh` before deploying. Any OpenAI-compatible endpoint works.

```bash
# Chat agent model: by default a local model through Ollama on the host (no key, no quota).
ollama pull qwen2.5:3b

scripts/up-local.sh
```

That script:
1. creates a single-node k3s cluster with a local registry (`deploy/k3d-config.yaml`; host ports 80/443 → Traefik, API on `127.0.0.1:6445`);
2. builds the six images and pushes them to the registry;
3. generates every Secret with random values (`scripts/create-secrets.sh`, idempotent);
4. installs the three charts with `values-local.yaml`;
5. prints the URLs and the generated admin passwords.

**Local domains.** `*.localtest.me` is public DNS that resolves to `127.0.0.1`, and k3d maps host port 80 to the cluster's Traefik, so there's nothing to add to `/etc/hosts`:

| URL | What |
|---|---|
| http://store.localtest.me | Storefront (wp-admin at `/wp-admin`, user `storeadmin`) |
| http://gateway.localtest.me | Dashboard |
| http://gateway.localtest.me/mcp | The team MCP endpoint |

If your network blocks DNS answers that resolve to 127.0.0.1, add `127.0.0.1 store.localtest.me gateway.localtest.me` to your hosts file.

Re-print the credentials at any time with `scripts/credentials.sh`. Run the end-to-end checks with `scripts/smoke-test.sh` (30 checks: two users, permissions, revoke, disable, dead upstream, SSRF, NetworkPolicy isolation, audit). Run the gateway unit tests with `cd services/gateway && npm test`.

**Deterministic chat tests.** To exercise the chat tool loop without any model, use the scripted fake model:

```bash
docker build -t localhost:5111/switchboard/fake-llm:dev test/fake-llm && docker push localhost:5111/switchboard/fake-llm:dev
kubectl -n mcp-servers create deployment fake-llm --image=registry.localhost:5111/switchboard/fake-llm:dev --port=8080
kubectl -n mcp-servers patch deploy fake-llm --type json -p '[{"op":"add","path":"/spec/template/metadata/labels/app.kubernetes.io~1component","value":"upstream-mcp"}]'
kubectl -n mcp-servers expose deploy fake-llm --port 8080
kubectl -n gateway patch secret gateway-secrets --type merge -p '{"stringData":{"llm-api-key":"fake"}}'
helm upgrade gateway charts/gateway -n gateway -f charts/gateway/values-local.yaml \
  --set llm.baseUrl=http://fake-llm.mcp-servers.svc.cluster.local:8080 --set llm.model=fake
```

To switch to a real model later: `kubectl -n gateway patch secret gateway-secrets --type merge -p '{"stringData":{"llm-api-key":"gsk_..."}}'`, then `helm upgrade gateway charts/gateway -n gateway -f charts/gateway/values-local.yaml`.

## VPS / production-like setup

Same charts, `values-prod.yaml` instead of `values-local.yaml`: real domains, TLS through cert-manager, a registry image tag, secure cookies, HTTPS-only external upstreams. Full steps are in [docs/OPERATIONS.md](docs/OPERATIONS.md):

```bash
curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="--secrets-encryption" sh -     # on the VPS
REGISTRY=ghcr.io/<you>/switchboard TAG=0.1.0 scripts/build-images.sh             # from your laptop
ADMIN_EMAIL=you@example.com LLM_API_KEY=gsk_... scripts/deploy.sh prod
```

## Using it

### Place an order (storefront)
1. Open http://store.localtest.me, open a product, click **Add to cart**, then **Checkout**.
2. Fill in any address, choose **Cash on delivery**, click **Place order**.
3. In http://store.localtest.me/wp-admin → **WooCommerce → Orders**, the order is listed as *Processing*.

### Team setup (admin)
1. Sign in to the dashboard with the admin credentials from `scripts/credentials.sh`.
2. **Servers:** WooCommerce, Team Notes and the reference server are already registered and *Connected*. Expand one to see its tools as exposed (`woo__list_orders`, …), mark tools *admins only* or *hidden*, disable, edit or remove a server, or **Add server** by URL + optional bearer/header credential.
3. **Members → Invite** gives a one-time invite link; send it to the teammate. Admins can also issue and revoke anyone's keys there.
4. **Audit log:** every tool call, with user, MCP client vs chat agent, server, tool, duration and outcome, plus per-server call counts, failure rate and p50/p95.

### Connect an external MCP client (member)
In the dashboard, **API keys → Generate key**. The key is shown once, together with ready-to-paste config:

```bash
# Claude Code
claude mcp add --transport http switchboard http://gateway.localtest.me/mcp \
  --header "Authorization: Bearer sbk_..."

# MCP Inspector (UI: transport "Streamable HTTP", URL above, header Authorization: Bearer sbk_...)
npx @modelcontextprotocol/inspector --cli http://gateway.localtest.me/mcp --transport http \
  --header "Authorization: Bearer sbk_..." --method tools/list
```

```jsonc
// Cursor: ~/.cursor/mcp.json
{ "mcpServers": { "switchboard": { "url": "http://gateway.localtest.me/mcp",
    "headers": { "Authorization": "Bearer sbk_..." } } } }
```

Then ask: *"What orders came in today?"* or, across two servers, *"Summarise today's WooCommerce orders and save the summary as a team note tagged daily-report."*

Clients that struggle with many tools can use `http://gateway.localtest.me/mcp?tools=search`, which exposes `switchboard__search_tools` + `switchboard__call_tool`.

### Chat agent
Dashboard → **Chat**. It uses the same gateway tools, as you: members can't trigger admin-only tools through it, and each call shows in the audit log as *chat agent* under your name. Each answer lists the tools it called; expand one to see the arguments and result.

## Definition of done: where each check lives

| Check | How it's shown |
|---|---|
| Order via storefront, visible in wp-admin | manual (above); the Store API path is exercised in testing |
| A (admin) creates a product via chat → on storefront; asks today's orders → gets the hand-placed order | chat agent, verified against the fake model end to end and live on the storefront |
| B connects an external client with only URL + key, sees all servers' tools, asks orders, runs a two-server prompt | MCP Inspector CLI verified; `smoke-test.sh` |
| Revoke B's key → rejected | `smoke-test.sh` (HTTP 401) |
| Disable a server → tools disappear (chat + external) | `smoke-test.sh`; chat lists tools fresh on every message |
| Kill an upstream pod → others keep working, dashboard shows Unreachable | `smoke-test.sh` (scale to 0), or `kubectl -n mcp-servers delete pod -l app.kubernetes.io/name=everything` |
| Every call audited under the right user | `smoke-test.sh` + Audit page |

## Beyond the core (stand-out items attempted)

| Item | Where |
|---|---|
| **Tool permissions** (2): per-tool *admins only* / *hidden*, enforced in list **and** call | `services/gateway/src/catalog.ts`, `router.ts`; Servers page |
| **Many tools** (4): search + call meta-tools, auto-used by chat above 40 tools | `services/gateway/src/mcp-endpoint.ts` (`?tools=search`) |
| **Security hardening** (6): SSRF checks at add time *and* connect time (DNS-rebinding safe), no redirects; default-deny NetworkPolicies in every namespace; non-root, read-only rootfs, no SA tokens; upstream credentials AES-256-GCM encrypted at rest; tool-definition pinning (rug-pull detection) | `ssrf.ts`, `crypto.ts`, `charts/*/templates/networkpolicy.yaml`, `upstreams.ts` |
| **Scaling** (7): 2 gateway replicas (stateless MCP endpoint, Postgres-backed state), per-user rate limit shared across replicas, PDB | `mcp-endpoint.ts`, `router.ts`, `charts/gateway` |
| **Observability** (8): Prometheus metrics; classified unreachable reasons; per-server latency/failure stats | `metrics.ts`, `upstreams.ts` (`describeError`), Audit page |
| **Upgrades and rollback** (9): documented and exercised | [docs/OPERATIONS.md](docs/OPERATIONS.md) |

Not attempted: the multi-store provisioning bonus, OAuth on the gateway, hosted (image-based) MCP servers.
