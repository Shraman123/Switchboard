# Switchboard: a team MCP gateway on Kubernetes

A WooCommerce store, an MCP server for it (written from scratch), and a team **MCP gateway** with a React dashboard and a chat agent, all running on Kubernetes and deployed with Helm.

An admin registers MCP servers once. Every team member then gets **every enabled server's tools through one URL and their own API key (or a browser login over OAuth)**, in Claude Code, Cursor, MCP Inspector or the dashboard's chat. Members never see upstream credentials, and every tool call lands in an audit log under the person who made it.

On top of that it is a small **store platform**: anyone on the team can create a new WooCommerce store from the dashboard. It is provisioned into its own namespace with the same Helm chart, and its MCP server is registered in the gateway automatically. Admins can also run MCP servers **from a container image** instead of a URL.

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
| `services/gateway` | Gateway backend: MCP client to upstreams, MCP server at `/mcp`, dashboard API at `/api`, OAuth authorization server (`src/oauth.ts`), chat agent, audit, metrics |
| `services/gateway/src/provisioner` | Provisioner (its own Deployment, same codebase): reconciles stores and hosted MCP servers into the cluster with Helm and the Kubernetes API |
| `services/dashboard` | React dashboard (Vite, served by unprivileged nginx) |
| `services/notes-mcp` | Second upstream: small team-notes MCP server that requires a bearer token |
| `images/woo-store` | WordPress 7.1.3 + WooCommerce 11.2.1 image and the idempotent store bootstrap |
| `images/everything-mcp` | Third upstream: the official MCP reference server, unmodified |
| `charts/{woo-store,gateway,mcp-servers}` | Helm charts, each with `values.yaml`, `values-local.yaml`, `values-prod.yaml` |
| `scripts/` | `up-local.sh`, `deploy.sh`, `create-secrets.sh`, `set-llm-key.sh`, `build-images.sh`, `credentials.sh`, `smoke-test.sh`, `smoke-test-platform.sh`, `check-manifests.py` |
| `.github/workflows/ci.yml` | CI: build + unit tests; Helm lint, render, kubeconform and policy check; full k3d deploy + both smoke tests; image release to GHCR |
| `test/fake-llm` | Scripted OpenAI-compatible endpoint for testing the chat tool loop without an API key |

## Local setup (k3d)

**Prerequisites:** Docker, [k3d](https://k3d.io) ≥ 5.8, kubectl, Helm 3, bash (Git Bash on Windows), Python 3 (used by the scripts for JSON), Node 22 (for the OAuth test), and about 4 GB of RAM free for Docker. Each provisioned store needs about 700 MB more.

**Chat model.** By default the chat agent uses Groq's free tier (`openai/gpt-oss-120b`, OpenAI-compatible). Get a key at console.groq.com and store it with `scripts/set-llm-key.sh`. The script reads the key without echoing it, writes it into the `gateway-secrets` Secret and restarts the gateway. For a fully offline setup, use a local model through [Ollama](https://ollama.com): run `ollama pull qwen2.5:3b`, then `LLM=ollama scripts/deploy.sh local`. That adds `values-ollama.yaml`: the Ollama URL on the host (`192.168.65.254:11434`, Docker Desktop's host address) plus one narrow egress rule for exactly that IP and port. Any OpenAI-compatible endpoint works.

```bash
scripts/up-local.sh
scripts/set-llm-key.sh      # paste the Groq key (input hidden)
```

That script:
1. creates a single-node k3s cluster with a local registry (`deploy/k3d-config.yaml`; host ports 80/443 → Traefik, API on `127.0.0.1:6445`);
2. builds the seven images and pushes them to the registry;
3. generates every Secret with random values (`scripts/create-secrets.sh`, idempotent);
4. installs the three charts with `values-local.yaml`;
5. prints the URLs and the generated admin passwords.

**Local domains.** `*.localtest.me` is public DNS that resolves to `127.0.0.1`, and k3d maps host port 80 to the cluster's Traefik, so there's nothing to add to `/etc/hosts`:

| URL | What |
|---|---|
| http://store.localtest.me | Storefront (wp-admin at `/wp-admin`, user `storeadmin`) |
| http://gateway.localtest.me | Dashboard |
| http://gateway.localtest.me/mcp | The team MCP endpoint |
| http://&lt;store-id&gt;-store.localtest.me | Each provisioned store |

If your network blocks DNS answers that resolve to 127.0.0.1, add `127.0.0.1 store.localtest.me gateway.localtest.me` to your hosts file.

**k3d quirk:** after `k3d cluster stop/start`, k3s's embedded NetworkPolicy controller can come back without per-pod firewall rules (policies exist but aren't enforced; the smoke test's isolation check catches it). `docker restart k3d-switchboard-server-0` fixes it.

Re-print the credentials at any time with `scripts/credentials.sh`. End-to-end checks:

- `scripts/smoke-test.sh`: 30 checks. Two users, permissions, revoke, disable, dead upstream, SSRF, NetworkPolicy isolation, audit.
- `scripts/smoke-test-platform.sh`: provisions two stores at once; checks isolation, quotas, routing and teardown; deploys and removes a hosted MCP server; runs the OAuth flow with the official MCP SDK client (`services/gateway/test/oauth-e2e.ts`).
- Unit tests: `cd services/gateway && npm test` and `cd services/woo-mcp && npm test`. CI runs all of the above on every push.

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

Same charts, `values-prod.yaml` instead of `values-local.yaml`: real domains, TLS through cert-manager, the published `ghcr.io/shraman123/switchboard/*:0.2.0` images (public, no pull secret), secure cookies, HTTPS-only external upstreams. Full steps are in [docs/OPERATIONS.md](docs/OPERATIONS.md):

```bash
curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="--secrets-encryption" sh -     # on the VPS
ADMIN_EMAIL=you@example.com scripts/deploy.sh prod                               # then scripts/set-llm-key.sh
```

### Public HTTPS URL without a VPS

`scripts/tunnel.sh` puts the local cluster behind a Cloudflare quick tunnel (no account, no card) and prints a `https://<random>.trycloudflare.com` URL. It switches `publicUrl` to that URL (so OAuth discovery, the MCP URL and invite links use it) and sets `ingress.host` to `gateway.localtest.me`, because the tunnel rewrites the Host header. Ctrl-C closes it and switches back. Both `scripts/smoke-test.sh` (30/30) and the OAuth e2e test (8/8) pass through the tunnel. The URL changes on every start and works only while the laptop is on, so it is for demos, not production.

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

### Connect with OAuth instead of a key
Clients that implement the MCP authorization spec need only the URL:

```bash
claude mcp add --transport http switchboard https://gateway.<domain>/mcp   # then /mcp → Authenticate
```

The flow:
1. The client gets a 401 that points at `/.well-known/oauth-protected-resource`.
2. It discovers the gateway's authorization server and registers itself.
3. It opens the browser on the dashboard's consent screen.
4. After **Allow**, it holds a 1-hour access token, refreshed automatically, that acts as you through the same policy and audit path as an API key.

**API keys → Connected apps** lists connected clients and disconnects them.

### Stores (multi-store provisioning)
Dashboard → **Stores → Create store**.
- The store shows *Provisioning* with the current step, then *Ready* with its URL (about 2–3 minutes).
- Its tools appear for everyone as `<store-id>__list_orders` and so on. The store's owner and admins can use its write tools.
- **Delete** removes the namespace, database, volumes, Secrets, Ingress and the gateway registration.

To try it, ask the chat agent: *"Compare today's orders across kolkata-sweets and howrah-bakery."*

### Hosted MCP servers (admin)
Dashboard → **Hosted → Deploy from image**. You give the image, port, path, plain and secret environment variables, and whether it may reach the internet. The server runs in the `mcp-hosted` namespace and is registered once its pod is ready. A pod that can't start fails with the reason, such as `ImagePullBackOff` or the last lines of its crash log.

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

## Bonus and stand-out items

| Item | Where |
|---|---|
| **Bonus: multi-store provisioning.** Create and delete stores from the dashboard, with status, URL and created time; several can provision at once. Each store is a Helm release of the same chart in its own namespace, with its own database, Secret, PVCs and Ingress host. Its MCP server is registered automatically with store-named tools. Teardown removes the namespace, volumes, Secrets and registration. NetworkPolicies isolate stores from each other. Guardrails: ResourceQuota + LimitRange per store, per-user and global store limits, and a provisioning deadline. Create is idempotent and resumes safely after a crash (tested by killing the provisioner mid-install). | `services/gateway/src/provisioner/`, `charts/gateway/templates/provisioner.yaml`, `charts/woo-store/templates/quota.yaml`, Stores page, `scripts/smoke-test-platform.sh` |
| **OAuth on the gateway** (3). Follows the MCP authorization spec: protected-resource and authorization-server metadata, dynamic client registration, PKCE S256, audience-bound short-lived tokens, rotating refresh tokens with replay detection, a consent screen, and revocation from Connected apps. | `services/gateway/src/oauth.ts`, Consent and API keys pages, `test/oauth-e2e.ts` |
| **Hosted MCP servers** (5). Deploy by image, with its own Secret, fixed limits, a non-root read-only pod, a per-server NetworkPolicy and a registry allowlist; removal is clean. | `services/gateway/src/provisioner/hosted.ts`, Hosted page |
| **Least-privilege RBAC** (6). Only the provisioner has Kubernetes API rights. It can bind one tenant ClusterRole in each namespace it created, and a ValidatingAdmissionPolicy restricts it to its own namespaces. | `charts/gateway/templates/provisioner.yaml` |
| **CI.** Unit tests; chart policy checks (`check-manifests.py`: probes, limits, non-root, no literal Secrets); a full k3d end-to-end run; GHCR release. | `.github/workflows/ci.yml` |
| **Tool permissions** (2): per-tool *admins only* / *hidden*, enforced in list **and** call | `services/gateway/src/catalog.ts`, `router.ts`; Servers page |
| **Many tools** (4): search + call meta-tools, auto-used by chat above 40 tools | `services/gateway/src/mcp-endpoint.ts` (`?tools=search`) |
| **Security hardening** (6): SSRF checks at add time *and* connect time (DNS-rebinding safe), no redirects; default-deny NetworkPolicies in every namespace; non-root, read-only rootfs, no SA tokens; upstream credentials AES-256-GCM encrypted at rest; tool-definition pinning (rug-pull detection) | `ssrf.ts`, `crypto.ts`, `charts/*/templates/networkpolicy.yaml`, `upstreams.ts` |
| **Scaling** (7): 2 gateway replicas (stateless MCP endpoint, Postgres-backed state), per-user rate limit shared across replicas, PDB | `mcp-endpoint.ts`, `router.ts`, `charts/gateway` |
| **Observability** (8): Prometheus metrics; classified unreachable reasons; per-server latency/failure stats | `metrics.ts`, `upstreams.ts` (`describeError`), Audit page |
| **Upgrades and rollback** (9): documented and exercised | [docs/OPERATIONS.md](docs/OPERATIONS.md) |

