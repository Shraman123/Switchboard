#!/usr/bin/env bash
# Public HTTPS URL for the local gateway, without a VPS: a Cloudflare quick
# tunnel (no account, no card) -> k3d's Traefik on localhost:80.
# The tunnel rewrites Host to gateway.localtest.me so the Ingress is unchanged;
# publicUrl is switched to the tunnel URL so OAuth discovery, MCP URLs and
# invite links point at it. Ctrl-C closes the tunnel and switches back.
#   scripts/tunnel.sh
set -euo pipefail
cd "$(dirname "$0")/.."
CF="${CLOUDFLARED:-cloudflared}"
HELM="${HELM:-helm}"
LOCAL_HOST=gateway.localtest.me
LOG="$(mktemp)"

"$CF" tunnel --no-autoupdate --url http://localhost:80 --http-host-header "$LOCAL_HOST" >"$LOG" 2>&1 &
CF_PID=$!

restore() {
  kill "$CF_PID" 2>/dev/null || true
  echo "switching the gateway back to http://$LOCAL_HOST"
  "$HELM" upgrade gateway charts/gateway -n gateway --reuse-values \
    --set publicUrl="http://$LOCAL_HOST" --set ingress.host= --wait --timeout 5m >/dev/null
  rm -f "$LOG"
}
trap restore EXIT

URL=""
for _ in $(seq 1 30); do
  URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1 || true)
  [ -n "$URL" ] && break
  sleep 1
done
[ -n "$URL" ] || { cat "$LOG"; echo "tunnel did not start"; exit 1; }

"$HELM" upgrade gateway charts/gateway -n gateway --reuse-values \
  --set publicUrl="$URL" --set ingress.host="$LOCAL_HOST" --wait --timeout 5m >/dev/null

# DNS for a fresh trycloudflare host can take a few seconds to appear.
for _ in $(seq 1 30); do
  curl -fs "$URL/.well-known/oauth-authorization-server" | grep -q "\"issuer\":\"$URL\"" && break
  sleep 2
done

cat <<MSG

Dashboard:     $URL
MCP endpoint:  $URL/mcp      (API key or OAuth)

Keep this window open; Ctrl-C closes the tunnel.
MSG
wait "$CF_PID"
