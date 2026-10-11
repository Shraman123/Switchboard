# Demo video script (~12 min)

Two browser profiles (or one normal + one incognito window): **A = admin**, **B = member**. A terminal with `kubectl` for the Kubernetes parts. Print the credentials first with `scripts/credentials.sh`.

## 0. Architecture (1 min)
README diagram → `docs/DESIGN.md` table. One sentence each: the store chart (WordPress + MariaDB + its own MCP server), the MCP servers chart, the gateway chart (backend = MCP client to upstreams + MCP server to members, dashboard, Postgres).

## 1. Kubernetes tour (2 min)
```bash
kubectl get ns store gateway mcp-servers
kubectl get deploy,sts,svc,ingress,pvc -n store
kubectl get deploy,sts,svc,ingress,pvc -n gateway
kubectl get secret -n store store-credentials -o jsonpath='{.data}' | head -c 200   # values exist, never in git
kubectl get netpol -A
kubectl -n store get deploy woo-store-mcp -o yaml | grep -A8 -E "readinessProbe|resources:"
```
Points: only the storefront and gateway have Ingress; woo-mcp is ClusterIP + NetworkPolicy (gateway pods only). Show `scripts/smoke-test.sh`'s isolation check, or run:
`kubectl run probe --rm -it --image=busybox:1.36 --restart=Never -- wget -qO- -T4 http://woo-store-mcp.store.svc.cluster.local:8080/healthz` → times out.

## 2. Store (1 min)
Storefront → product → Add to cart → Checkout → Cash on delivery → Place order. wp-admin → WooCommerce → Orders: it's there.

## 3. Admin (A) dashboard (1.5 min)
Servers: three Connected servers, tools per server, `woo__*` naming, the `notes__echo` / `everything__echo` collision, credential "stored (encrypted)" (never shown), the per-tool **admins only** policy on `create_product` / `update_order_status`. Members → invite B (copy link).

## 4. Chat as A (1.5 min)
- "Create a product called Nolen Gur Sandesh priced at 350" → expand the `woo__create_product` step → refresh the storefront: the product is there.
- Place an order for it on the storefront by hand.
- "What orders came in today?" → returns that order.
- Audit log: those calls show as *chat agent* under A.

## 5. External client as B (2 min)
B opens the invite link, sets a password → API keys → Generate → copy the Claude Code command.
```bash
claude mcp add --transport http switchboard http://gateway.localtest.me/mcp --header "Authorization: Bearer sbk_..."
claude   # then /mcp shows switchboard with its tools
```
- "What orders came in today?"
- Two servers: "Summarise today's WooCommerce orders and save it as a team note tagged daily-report" → `woo__list_orders` then `notes__create_note`.
- B doesn't see `woo__create_product` (admin-only). Ask Claude to create a product → it can't.

## 6. Team and control (2 min)
- A: Members → All API keys → revoke B's key → B's next call fails (401).
- A: Servers → Disable *Team Notes* → in chat its tools are gone; in Claude Code (`/mcp` reconnect) they're gone.
- `kubectl -n mcp-servers delete pod -l app.kubernetes.io/name=everything` (or `scale --replicas=0` to keep it down) → dashboard shows **Unreachable** with "connection refused (nothing listening — pod down?)"; woo and notes keep answering.
- Audit log: everything above attributed to A or B, including `denied` and `unavailable`.

## 7. MCP internals (1 min)
Walk one call: Claude Code → Traefik → gateway `/mcp` (stateless Streamable HTTP; key → user) → catalog lookup `woo__list_orders` → policy + rate limit → persistent MCP client to `woo-store-mcp` with the gateway's bearer token, 15 s timeout → woo-mcp → OAuth1-signed REST → WooCommerce → back, audit row written. Show `upstreams.ts` `callTool` + `describeError`, `catalog.ts` naming, and the health loop (`tools/list` never waits on upstreams).

## 8. Security posture (1 min)
API keys: shown once, SHA-256 in DB. Upstream credentials: AES-256-GCM, decrypted only in gateway memory, never sent to browsers or clients, and member tokens never passed upstream. Malicious server: admin-only registration, SSRF guard (try adding `http://169.254.169.254/` → rejected), tool pinning (a changed description is held for review), provenance prefixes, least privilege. See `docs/THREAT_MODEL.md`.

## 9. Local → VPS, upgrade, rollback (1 min)
`diff charts/gateway/values-local.yaml charts/gateway/values-prod.yaml`: domain, TLS + cert-manager, image tags, secure cookies, HTTPS-only upstreams, storage. Then:
```bash
helm upgrade gateway charts/gateway -n gateway -f charts/gateway/values-local.yaml --reuse-values --set backend.rateLimitPerMinute=60 --wait
helm history gateway -n gateway
helm rollback gateway <previous> -n gateway --wait
```
