#!/usr/bin/env bash
# Creates every Kubernetes Secret the platform needs, with fresh random values.
# Idempotent: an existing Secret is never overwritten (delete it to rotate).
# Secrets are generated here, at deploy time, so none live in git or in values files.
#
# Optional env:
#   LLM_API_KEY      key for the chat agent's LLM provider (Groq by default)
#   ADMIN_EMAIL      first dashboard admin (default admin@switchboard.local)
#   STORE_NS / GATEWAY_NS / SERVERS_NS   namespaces (defaults: store / gateway / mcp-servers)
set -euo pipefail

STORE_NS="${STORE_NS:-store}"
GATEWAY_NS="${GATEWAY_NS:-gateway}"
SERVERS_NS="${SERVERS_NS:-mcp-servers}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@switchboard.local}"

rand() { head -c 64 /dev/urandom | od -An -tx1 | tr -d ' \n' | head -c "$1"; }
exists() { kubectl -n "$1" get secret "$2" >/dev/null 2>&1; }

for ns in "$STORE_NS" "$GATEWAY_NS" "$SERVERS_NS"; do
  kubectl get ns "$ns" >/dev/null 2>&1 || kubectl create ns "$ns"
done

# --- store: database, WordPress admin + salts, WooCommerce REST key, MCP bearer token
if ! exists "$STORE_NS" store-credentials; then
  kubectl -n "$STORE_NS" create secret generic store-credentials \
    --from-literal=db-password="$(rand 32)" \
    --from-literal=db-root-password="$(rand 32)" \
    --from-literal=admin-password="$(rand 20)" \
    --from-literal=wp-salt="$(rand 64)" \
    --from-literal=wc-consumer-key="ck_$(rand 40)" \
    --from-literal=wc-consumer-secret="cs_$(rand 40)" \
    --from-literal=mcp-token="$(rand 48)"
fi

# --- in-cluster example upstream (notes) bearer token
if ! exists "$SERVERS_NS" notes-credentials; then
  kubectl -n "$SERVERS_NS" create secret generic notes-credentials --from-literal=token="$(rand 48)"
fi

get() { kubectl -n "$1" get secret "$2" -o "jsonpath={.data.$3}" | base64 -d; }

# --- gateway: its own DB, session signing key, credential encryption key, first admin, LLM key
if ! exists "$GATEWAY_NS" gateway-secrets; then
  kubectl -n "$GATEWAY_NS" create secret generic gateway-secrets \
    --from-literal=db-password="$(rand 32)" \
    --from-literal=session-secret="$(rand 64)" \
    --from-literal=encryption-key="$(rand 64)" \
    --from-literal=admin-email="$ADMIN_EMAIL" \
    --from-literal=admin-password="$(rand 20)" \
    --from-literal=llm-api-key="${LLM_API_KEY:-}"
elif [ -n "${LLM_API_KEY:-}" ]; then
  kubectl -n "$GATEWAY_NS" patch secret gateway-secrets --type merge \
    -p "{\"stringData\":{\"llm-api-key\":\"$LLM_API_KEY\"}}" >/dev/null
fi

# --- upstream credentials the gateway uses to seed its first servers. Copied
# (not referenced) because a Pod can only mount Secrets from its own namespace.
kubectl -n "$GATEWAY_NS" create secret generic gateway-upstream-seed \
  --from-literal=woo-token="$(get "$STORE_NS" store-credentials mcp-token)" \
  --from-literal=notes-token="$(get "$SERVERS_NS" notes-credentials token)" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null

echo "secrets ready in: $STORE_NS, $GATEWAY_NS, $SERVERS_NS"
