# Operations: VPS deploy, upgrades, rollback

## Production-like VPS (k3s)

Target: one Ubuntu 24.04 VM with 2 vCPU / 4 GB RAM (any provider's free or entry tier). The local cluster runs k3s too (via k3d), so this path uses the same distribution the charts were built and tested on; the VPS steps themselves are documented, not yet run. k3s brings the same Traefik ingress and `local-path` storage the local k3d cluster uses, so **the same charts deploy with only `values-prod.yaml` changes**.

```bash
# 1. On the VPS: k3s (Traefik + local-path included; NetworkPolicy controller included)
curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="--secrets-encryption" sh -
sudo cat /etc/rancher/k3s/k3s.yaml   # copy to your laptop, replace 127.0.0.1 with the VPS IP

# 2. DNS: two A records -> VPS IP
#    store.example.com, gateway.example.com

# 3. TLS: cert-manager + a Let's Encrypt issuer named "letsencrypt"
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.18.2/cert-manager.yaml
kubectl apply -f deploy/cluster-issuer.yaml        # edit the email first

# 4. Images: push to a registry the VPS can pull from
echo $GITHUB_TOKEN | docker login ghcr.io -u YOUR_GH_USER --password-stdin
REGISTRY=ghcr.io/YOUR_GH_USER/switchboard TAG=0.1.0 scripts/build-images.sh
#    (make the GHCR packages public, or add an imagePullSecret)

# 5. Edit the three values-prod.yaml files: domains, image repos, sizes. Then:
ADMIN_EMAIL=you@example.com LLM_API_KEY=gsk_... scripts/deploy.sh prod
scripts/credentials.sh
```

### What changes between local and VPS (values only)

| Value | Local (`values-local.yaml`) | VPS (`values-prod.yaml`) |
|---|---|---|
| `woo-store.siteUrl` / `gateway.publicUrl` | `http://store.localtest.me` / `http://gateway.localtest.me` | `https://store.example.com` / `https://gateway.example.com` |
| `ingress.tls.enabled` + cert-manager annotation | off | on (`cert-manager.io/cluster-issuer: letsencrypt`) |
| `backend.cookieSecure` | false | true |
| `ssrf.allowHttp` | true | false (external upstreams must be HTTPS) |
| image repository / tag / pullPolicy | `registry.localhost:5111/...:dev`, `Always` | `ghcr.io/...:0.1.0`, `IfNotPresent` |
| `storageClass`, `*.storage` | default class, 1-2 Gi | `local-path` (or a CSI class), 5-10 Gi |

Secrets don't live in values in either environment: `scripts/create-secrets.sh` generates them in the cluster (idempotent). On a real team, swap it for Sealed Secrets or External Secrets Operator writing the **same Secret names**; the charts don't change. `--secrets-encryption` makes k3s encrypt Secrets at rest in its datastore.

Changing the store domain later is just `siteUrl` + `helm upgrade`: the bootstrap hook re-applies `home`/`siteurl`.

## Upgrades

Everything is `helm upgrade` with a new image tag. Order: **store → MCP servers → gateway**. The gateway tolerates upstreams being briefly down, so the order matters only for downtime, not correctness.

| What | How | What happens |
|---|---|---|
| Gateway / dashboard | `helm upgrade gateway charts/gateway -n gateway -f charts/gateway/values-prod.yaml --set backend.image.tag=0.1.1 --wait` | Rolling update, `maxUnavailable: 0`, PDB `minAvailable: 1`. The MCP endpoint is stateless, so no client sessions break. DB migrations run at startup under a Postgres advisory lock (safe with 2 replicas starting together) and are additive. |
| WooCommerce MCP server | `helm upgrade woo-store ... --set mcp.image.tag=0.1.1` | Rolling update. The gateway's next call rebuilds its client if the session was lost. |
| WooCommerce / WordPress | build the store image with a new `WOOCOMMERCE_VERSION` (or WP base tag), then `helm upgrade woo-store ... --set image.tag=wc-11.3.0` | Web pod is `Recreate` (RWO volume). The **post-upgrade hook** re-runs the idempotent bootstrap, which installs the new WooCommerce zip into `wp-content` and runs `wp wc update` (DB migrations). WordPress core comes from the image, so it updates with the tag. |
| Config only | `helm upgrade ... --reuse-values --set backend.rateLimitPerMinute=60` | Pods roll (config is env). |

Always take a DB backup before a WooCommerce upgrade (its migrations are one-way):

```bash
kubectl -n store exec woo-store-db-0 -- sh -c 'mariadb-dump -uroot -p"$MARIADB_ROOT_PASSWORD" wordpress' > store-$(date +%F).sql
kubectl -n gateway exec gateway-postgres-0 -- pg_dump -U switchboard switchboard > gateway-$(date +%F).sql
```

## Rollback

```bash
helm history gateway -n gateway
helm rollback gateway <REVISION> -n gateway --wait
```

Verified on the local cluster: an upgrade that changed `rateLimitPerMinute` (120 → 60) produced revision 4, and `helm rollback gateway 3` restored 120 with a zero-downtime rolling restart.

- **Gateway / MCP servers:** stateless images, so rollback is always safe. Gateway migrations are additive (new columns/tables), so an older image runs against a newer schema.
- **Store:** `helm rollback woo-store` restores the previous image and manifests, and the hook re-runs bootstrap. But WooCommerce **database** migrations don't roll back, so after a failed WooCommerce upgrade restore the SQL dump taken beforehand, then roll back the release. The PVC (`helm.sh/resource-policy: keep`) and the StatefulSet's volume claim survive both upgrades and `helm uninstall`.

## Day-2

- **Rotate a credential:** delete the key from the Secret (or the Secret) → `scripts/create-secrets.sh` → `helm upgrade` (the store bootstrap re-registers the WooCommerce key; update the upstream's credential in the dashboard).
- **Metrics:** `gateway-backend:8080/metrics` (Prometheus format, cluster-internal only): `switchboard_tool_calls_total{server,tool,outcome,via}`, `switchboard_tool_call_duration_seconds`, `switchboard_upstream_up{server}`, `switchboard_auth_failures_total`. Pods carry `prometheus.io/scrape` annotations. The dashboard's audit page shows per-server calls, failure rate and p50/p95 for the last 24 h.
- **Why is a server unreachable?** The dashboard shows the classified reason (refused / DNS / timeout / HTTP 401 / SSRF-blocked) and when it was last OK.
