#!/usr/bin/env bash
# Store the chat agent's LLM API key (e.g. a Groq key) in the gateway Secret.
# The key is read without echo, so it never lands in shell history, git or logs.
#   scripts/set-llm-key.sh
set -euo pipefail
NS="${GATEWAY_NS:-gateway}"
read -rsp "LLM API key (input hidden): " KEY; echo
[ -n "$KEY" ] || { echo "no key given" >&2; exit 1; }
kubectl -n "$NS" patch secret gateway-secrets --type merge \
  -p "{\"data\":{\"llm-api-key\":\"$(printf %s "$KEY" | base64 | tr -d '\n')\"}}" >/dev/null
kubectl -n "$NS" rollout restart deploy/gateway-backend >/dev/null
kubectl -n "$NS" rollout status deploy/gateway-backend --timeout=180s >/dev/null
echo "LLM key stored in $NS/gateway-secrets; gateway restarted."
