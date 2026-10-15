# Demo video script (~16 min)

Two browser profiles (or one normal + one incognito window): **A = admin**, **B = member**. A terminal with `kubectl` for the Kubernetes parts. Print the credentials first with `scripts/credentials.sh`.

**Before recording:**
- Set the Groq key (`scripts/set-llm-key.sh`) so chat answers take seconds.
- Create the two demo stores about 5 minutes ahead (Stores → *Kolkata Sweets*, *Howrah Bakery*), so section 10 doesn't wait on provisioning.
- Place one order in each store by hand.

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

## 10. Bonus: multi-store provisioning (2.5 min)
- Stores page: the two stores are *Ready*, with URL and created time. Create a third (*Salt Lake Cafe*): it shows *Provisioning* and the live step.
- Meanwhile in the terminal:
```bash
kubectl get ns -l switchboard.dev/kind=store
kubectl -n store-kolkata-sweets get deploy,sts,pvc,secret,ingress,resourcequota,limitrange,netpol
kubectl -n store-salt-lake-cafe get pods -w        # the new store coming up
```
- Servers page: each store is registered automatically (*provisioned store* badge), tools `kolkata-sweets__list_orders`, `howrah-bakery__list_orders`.
- Chat: **"Compare today's orders across kolkata-sweets and howrah-bakery."** Show both `…__list_orders` calls.
- Isolation, from inside one store's MCP pod:
```bash
POD=$(kubectl -n store-kolkata-sweets get pod -l app.kubernetes.io/component=mcp -o name)
kubectl -n store-kolkata-sweets exec $POD -- wget -qO- -T4 http://woo-store-web:8080/wp-json/ | head -c 80   # own store: works
kubectl -n store-kolkata-sweets exec $POD -- wget -qO- -T4 http://woo-store-web.store-howrah-bakery:8080/   # other store: refused by NetworkPolicy
```
- Delete *Howrah Bakery*. It goes *Deleting*, then disappears. `kubectl get ns store-howrah-bakery` is gone, `kubectl get pv` shows its volumes gone, and its tools are gone from the chat and the external client.
- Recovery (optional, or describe it): create a store, `kubectl -n gateway delete pod -l app.kubernetes.io/component=provisioner` mid-install. The new provisioner resumes, clears the interrupted release and finishes, or fails after the deadline with a reason.
- Guardrails: per-user limit (try a third store as B), quota, 15 min deadline. RBAC: `kubectl auth can-i create deployments -n kube-system --as=system:serviceaccount:gateway:gateway-provisioner` → no.

## 11. Hosted MCP server from an image (1 min)
Hosted → Deploy from image: `registry.localhost:5111/switchboard/everything-mcp:dev`, slug `ref2`, a secret env var. Show:
- it becoming ready;
- `kubectl -n mcp-hosted get deploy,svc,secret,netpol`;
- the pod's securityContext (UID 10001, read-only root filesystem);
- `ref2__echo` in the tool list.

Delete it: everything is gone. Optional: deploy a nonexistent image tag and show the *Failed: ImagePullBackOff* reason.

## 12. OAuth instead of an API key (1 min)
```bash
claude mcp add --transport http switchboard-oauth https://gateway.<domain>/mcp
claude   # /mcp → switchboard-oauth → Authenticate → browser opens the consent screen → Allow
```
Then:
- Ask "what orders came in today?".
- The Audit log shows *MCP client (OAuth)* with the app name.
- API keys → Connected apps → Disconnect; the next call fails.
- Mention that `services/gateway/test/oauth-e2e.ts` proves the whole flow, including refresh-token rotation and replay detection.
