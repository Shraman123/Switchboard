#!/usr/bin/env bash
# Install or upgrade the whole platform with Helm.
#   scripts/deploy.sh local          # k3d (values-local.yaml)
#   scripts/deploy.sh prod           # VPS k3s (values-prod.yaml)
#   LLM=ollama scripts/deploy.sh local   # chat agent on a local Ollama model
# Extra args are passed to every `helm upgrade`, e.g. --set backend.image.tag=0.1.1
set -euo pipefail
cd "$(dirname "$0")/.."
ENV="${1:-local}"; shift || true
HELM="${HELM:-helm}"

bash scripts/create-secrets.sh

# Order matters only for the first install: the gateway seeds the upstreams it
# finds, and its health loop simply retries until they are up.
"$HELM" upgrade --install woo-store charts/woo-store -n store \
  -f "charts/woo-store/values-$ENV.yaml" --wait --timeout 15m "$@"
"$HELM" upgrade --install mcp-servers charts/mcp-servers -n mcp-servers \
  -f "charts/mcp-servers/values-$ENV.yaml" --wait --timeout 5m "$@"
"$HELM" upgrade --install gateway charts/gateway -n gateway \
  -f "charts/gateway/values-$ENV.yaml" --wait --timeout 10m "$@"

GW_URL=$("$HELM" get values gateway -n gateway -a -o json | python -c "import sys,json;print(json.load(sys.stdin)['publicUrl'])")
ST_URL=$("$HELM" get values woo-store -n store -a -o json | python -c "import sys,json;print(json.load(sys.stdin)['siteUrl'])")
cat <<MSG

Storefront:    $ST_URL           (wp-admin: $ST_URL/wp-admin)
Dashboard:     $GW_URL
MCP endpoint:  $GW_URL/mcp

Credentials:   scripts/credentials.sh
MSG
