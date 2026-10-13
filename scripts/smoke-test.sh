#!/usr/bin/env bash
# End-to-end checks against a running deployment (local or VPS).
# Exercises the "team and control" part of the definition of done through the
# public Ingress only, plus two in-cluster checks with kubectl.
#   GATEWAY=http://gateway.localtest.me scripts/smoke-test.sh
set -uo pipefail

G="${GATEWAY:-http://gateway.localtest.me}"
GW_NS="${GATEWAY_NS:-gateway}"
SERVERS_NS="${SERVERS_NS:-mcp-servers}"
STORE_NS="${STORE_NS:-store}"
TMP="$(mktemp -d)"
PASS=0
FAIL=0

ok() { echo "  PASS  $*"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL  $*"; FAIL=$((FAIL + 1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
json() { python -c "import sys,json; d=json.load(sys.stdin); print($1)"; }

# api <cookiejar> <METHOD> <path> [json-body]
api() {
  local jar=$1 method=$2 path=$3 body=${4:-}
  if [ -n "$body" ]; then
    curl -s -b "$jar" -c "$jar" -X "$method" "$G/api$path" -H 'content-type: application/json' -H 'x-switchboard: 1' -d "$body"
  else
    curl -s -b "$jar" -c "$jar" -X "$method" "$G/api$path" -H 'x-switchboard: 1'
  fi
}
# mcp <key> <json-rpc>
mcp() {
  curl -s "$G/mcp" -H "Authorization: Bearer $1" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d "$2"
}
tools() { mcp "$1" '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | json "' '.join(t['name'] for t in d['result']['tools'])"; }
call() { mcp "$1" "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"$2\",\"arguments\":${3:-{\}}}}"; }
server_id() { api "$A" GET /servers | json "[s['id'] for s in d if s['slug']=='$1'][0]"; }
server_status() { api "$A" GET /servers | json "[s['status'] for s in d if s['slug']=='$1'][0]"; }

echo "== sign in as admin (user A)"
A="$TMP/a.jar"
ADMIN_EMAIL=$(kubectl -n "$GW_NS" get secret gateway-secrets -o jsonpath='{.data.admin-email}' | base64 -d)
ADMIN_PW=$(kubectl -n "$GW_NS" get secret gateway-secrets -o jsonpath='{.data.admin-password}' | base64 -d)
check "admin login" "api '$A' POST /auth/login '{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PW\"}' | grep -q '\"role\":\"admin\"'"
KEY_A=$(api "$A" POST /keys '{"name":"smoke-admin"}' | json "d['key']")

echo "== servers"
for i in $(seq 1 30); do  # give a just-restarted upstream time to reconnect
  [ "$(api "$A" GET /servers | json "all(x['status']=='connected' for x in d)")" = True ] && break
  sleep 2
done
for s in woo notes everything; do
  check "$s is connected" "[ \"\$(server_status $s)\" = connected ]"
done

echo "== invite member (user B), accept, generate own key"
B_EMAIL="member-$RANDOM@example.com"
INVITE=$(api "$A" POST /users/invite "{\"email\":\"$B_EMAIL\",\"role\":\"member\"}" | json "d['inviteUrl'].rsplit('/',1)[1]")
B="$TMP/b.jar"
check "member accepts invite" "api '$B' POST /auth/accept-invite '{\"token\":\"$INVITE\",\"name\":\"Bea Member\",\"password\":\"member-password-123\"}' | grep -q '\"role\":\"member\"'"
KEY_B=$(api "$B" POST /keys '{"name":"smoke-member"}' | json "d['key']")
check "member key issued" "[ -n '$KEY_B' ]"
check "member cannot add servers" "api '$B' POST /servers '{\"name\":\"x\",\"slug\":\"xx\",\"url\":\"https://example.com/mcp\"}' | grep -q 'admins only'"

echo "== member sees tools from every server, minus admin-only ones"
TB=$(tools "$KEY_B")
check "member sees woo__list_orders" "echo '$TB' | grep -qw woo__list_orders"
check "member sees notes + everything tools" "echo '$TB' | grep -qw notes__create_note && echo '$TB' | grep -qw everything__echo"
check "member does not see woo__create_product" "! echo '$TB' | grep -qw woo__create_product"
check "member calling woo__create_product directly is rejected" "call '$KEY_B' woo__create_product '{\"name\":\"x\",\"regular_price\":1}' | grep -q 'restricted to admins'"
check "admin sees woo__create_product" "tools '$KEY_A' | grep -qw woo__create_product"
check "member can list orders" "call '$KEY_B' woo__list_orders '{}' | grep -q orders"
check "same tool name on two servers is disambiguated" "[ \"\$(call '$KEY_B' notes__echo '{\"message\":\"x\"}' | json \"d['result']['content'][0]['text']\")\" != \"\$(call '$KEY_B' everything__echo '{\"message\":\"x\"}' | json \"d['result']['content'][0]['text']\")\" ]"

echo "== revoke member key"
KID=$(api "$A" GET '/keys?all=1' | json "[k['id'] for k in d if k['name']=='smoke-member' and not k['revoked_at']][0]")
api "$A" DELETE "/keys/$KID" >/dev/null
check "revoked key is rejected (HTTP 401)" "[ \"\$(curl -s -o /dev/null -w '%{http_code}' $G/mcp -H 'Authorization: Bearer $KEY_B' -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}')\" = 401 ]"

echo "== disable a server"
NOTES=$(server_id notes)
api "$A" PATCH "/servers/$NOTES" '{"enabled":false}' >/dev/null
check "disabled server's tools disappear" "! tools '$KEY_A' | grep -q notes__"
check "calling a disabled server's tool is rejected" "call '$KEY_A' notes__list_notes | grep -q disabled"
api "$A" PATCH "/servers/$NOTES" '{"enabled":true}' >/dev/null
check "re-enabled server's tools come back" "tools '$KEY_A' | grep -q notes__list_notes"

echo "== kill an upstream (scale to 0 so it stays dead)"
kubectl -n "$SERVERS_NS" scale deploy/everything --replicas=0 >/dev/null
kubectl -n "$SERVERS_NS" wait --for=delete pod -l app.kubernetes.io/name=everything --timeout=60s >/dev/null 2>&1
OUT=$(call "$KEY_A" everything__echo '{"message":"x"}')
# (grep on the variable directly: the message itself may contain quotes)
if grep -qiE 'unreachable|refused|timed out|unavailable' <<<"$OUT"; then ok "call to dead upstream fails fast with a clear error"; else bad "call to dead upstream fails fast with a clear error"; fi
check "dashboard shows it as unreachable" "[ \"\$(server_status everything)\" = unreachable ]"
check "other servers keep working" "call '$KEY_A' woo__list_products '{\"per_page\":1}' | grep -q products && call '$KEY_A' notes__list_notes | grep -q title"
check "dead server's tools leave the list" "! tools '$KEY_A' | grep -q everything__"
kubectl -n "$SERVERS_NS" scale deploy/everything --replicas=1 >/dev/null

echo "== SSRF protection on server URLs"
check "cloud metadata URL rejected" "api '$A' POST /servers '{\"name\":\"m\",\"slug\":\"meta\",\"url\":\"http://169.254.169.254/latest/meta-data\"}' | grep -q 'URL rejected'"
check "gateway's own database rejected" "api '$A' POST /servers '{\"name\":\"p\",\"slug\":\"pg\",\"url\":\"http://gateway-postgres.gateway.svc.cluster.local:5432/\"}' | grep -q 'URL rejected'"
check "loopback rejected" "api '$A' POST /servers '{\"name\":\"l\",\"slug\":\"lo\",\"url\":\"http://127.0.0.1:8080/mcp\"}' | grep -q 'URL rejected'"

echo "== network isolation (in-cluster)"
check "WooCommerce MCP server not reachable from another namespace" \
  "! kubectl run np-probe-$RANDOM -n default --rm -i --restart=Never --image=busybox:1.36 --command -- wget -qO- -T 4 http://woo-store-mcp.$STORE_NS.svc.cluster.local:8080/healthz >/dev/null 2>&1"
check "WooCommerce MCP server has no Ingress" "! kubectl -n $STORE_NS get ingress -o jsonpath='{.items[*].spec.rules[*].http.paths[*].backend.service.name}' | grep -q mcp"

echo "== audit log"
AUDIT=$(api "$A" GET '/audit?limit=200')
check "member's calls are attributed to the member" "echo '$AUDIT' | json \"any(r['user_email']=='$B_EMAIL' and r['tool_name']=='list_orders' and r['outcome']=='ok' for r in d)\" | grep -q True"
check "denied call is logged as denied" "echo '$AUDIT' | json \"any(r['user_email']=='$B_EMAIL' and r['tool_name']=='create_product' and r['outcome']=='denied' for r in d)\" | grep -q True"
check "dead-upstream call is logged as unavailable" "echo '$AUDIT' | json \"any(r['server_slug']=='everything' and r['outcome'] in ('unavailable','timeout') for r in d)\" | grep -q True"

api "$A" DELETE "/keys/$(api "$A" GET /keys | json "[k['id'] for k in d if k['name']=='smoke-admin' and not k['revoked_at']][0]")" >/dev/null
rm -rf "$TMP"
echo
echo "passed: $PASS  failed: $FAIL"
[ "$FAIL" -eq 0 ]
