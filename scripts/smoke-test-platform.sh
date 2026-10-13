#!/usr/bin/env bash
# End-to-end checks for the platform features (bonus + stand-outs):
# store provisioning, isolation, guardrails, teardown, hosted MCP servers, OAuth.
# Takes a few minutes: it provisions two real stores.
#   GATEWAY=http://gateway.localtest.me scripts/smoke-test-platform.sh
set -uo pipefail
cd "$(dirname "$0")/.."

G="${GATEWAY:-http://gateway.localtest.me}"
GW_NS="${GATEWAY_NS:-gateway}"
HOSTED_NS="${HOSTED_NS:-mcp-hosted}"
HOSTED_IMAGE="${HOSTED_IMAGE:-registry.localhost:5111/switchboard/everything-mcp:dev}"
TMP="$(mktemp -d)"
PASS=0
FAIL=0
SUF=$RANDOM
A="shop-a$SUF"
B="shop-b$SUF"

ok() { echo "  PASS  $*"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL  $*"; FAIL=$((FAIL + 1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
json() { python -c "import sys,json; d=json.load(sys.stdin); print($1)"; }
api() {
  local method=$1 path=$2 body=${3:-}
  if [ -n "$body" ]; then
    curl -s -b "$TMP/jar" -c "$TMP/jar" -X "$method" "$G/api$path" -H 'content-type: application/json' -H 'x-switchboard: 1' -d "$body"
  else
    curl -s -b "$TMP/jar" -c "$TMP/jar" -X "$method" "$G/api$path" -H 'x-switchboard: 1'
  fi
}
mcp() { curl -s "$G/mcp" -H "Authorization: Bearer $KEY" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d "$1"; }
tools() { mcp '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | json "' '.join(t['name'] for t in d['result']['tools'])"; }
call() { mcp "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":${2:-{\}}}}"; }
store_field() { api GET /stores | json "([s['$2'] for s in d['stores'] if s['slug']=='$1'] or ['none'])[0]"; }
wait_store() { # slug status timeout_s
  for _ in $(seq 1 $(($3 / 5))); do
    st=$(store_field "$1" status)
    [ "$st" = "$2" ] && return 0
    [ "$st" = failed ] && { echo "    $1 failed: $(store_field "$1" reason)"; return 1; }
    sleep 5
  done
  return 1
}

EMAIL=$(kubectl -n "$GW_NS" get secret gateway-secrets -o jsonpath='{.data.admin-email}' | base64 -d)
PW=$(kubectl -n "$GW_NS" get secret gateway-secrets -o jsonpath='{.data.admin-password}' | base64 -d)
api POST /auth/login "{\"email\":\"$EMAIL\",\"password\":\"$PW\"}" >/dev/null
KEY=$(api POST /keys '{"name":"smoke-platform"}' | json "d['key']")

echo "== provision two stores at the same time"
check "create store A (202)" "api POST /stores '{\"name\":\"Smoke $A\",\"slug\":\"$A\"}' | grep -q '\"status\":\"provisioning\"'"
check "create store B (202)" "api POST /stores '{\"name\":\"Smoke $B\",\"slug\":\"$B\"}' | grep -q '\"status\":\"provisioning\"'"
ID_A=$(store_field "$A" id)
check "creating the same store again is idempotent" "[ \"\$(api POST /stores '{\"name\":\"Smoke $A\",\"slug\":\"$A\"}' | json \"d['id']\")\" = '$ID_A' ]"
check "dashboard lists them as Provisioning with a step" "[ \"\$(store_field $B status)\" = provisioning ]"
check "store A becomes Ready" "wait_store $A ready 900"
check "store B becomes Ready" "wait_store $B ready 900"

echo "== each store: own namespace, database, volumes, Secret, Ingress, guardrails"
for s in "$A" "$B"; do
  ns="store-$s"
  check "$s: namespace, 2 PVCs, Secret, Ingress" "[ \$(kubectl -n $ns get pvc --no-headers | wc -l) -eq 2 ] && kubectl -n $ns get secret store-credentials >/dev/null && kubectl -n $ns get ingress >/dev/null"
  check "$s: ResourceQuota + LimitRange" "kubectl -n $ns get resourcequota --no-headers | grep -q quota && kubectl -n $ns get limitrange --no-headers | grep -q limits"
  check "$s: storefront serves over its own Ingress host" "curl -s \$(store_field $s url)/ | grep -q 'Smoke $s'"
done

echo "== automatic MCP registration, tool names say which store"
for _ in $(seq 1 15); do tools | grep -qw "${B}__list_orders" && break; sleep 2; done
TL=$(tools)
check "both stores' tools are listed (${A}__list_orders, ${B}__list_orders)" "echo '$TL' | grep -qw ${A}__list_orders && echo '$TL' | grep -qw ${B}__list_orders"
check "a store tool call is routed to that store" "call ${A}__list_products '{\"per_page\":1}' | grep -q products"

echo "== isolation between stores (NetworkPolicy)"
POD_A=$(kubectl -n "store-$A" get pod -l app.kubernetes.io/component=mcp -o jsonpath='{.items[0].metadata.name}')
check "store A's MCP server reaches its own WordPress" "kubectl -n store-$A exec $POD_A -- wget -qO- -T 4 http://woo-store-web:8080/wp-json/ >/dev/null 2>&1"
# Blocked by policy = the connection times out (packets dropped); anything
# else (an answer, even a protocol error) would mean it got through.
blocked() { kubectl -n "store-$A" exec "$POD_A" -- wget -qO- -T 4 "$1" 2>&1 | grep -q 'timed out'; }
check "store A's MCP server cannot reach store B's WordPress" "blocked http://woo-store-web.store-$B.svc.cluster.local:8080/wp-json/"
check "store A's MCP server cannot reach store B's database" "blocked http://woo-store-db.store-$B.svc.cluster.local:3306/"
check "store A's MCP server cannot reach the gateway's Postgres" "blocked http://gateway-postgres.$GW_NS.svc.cluster.local:5432/"
check "provisioner cannot touch kube-system (admission policy + RBAC)" "! kubectl auth can-i create deployments -n kube-system --as=system:serviceaccount:$GW_NS:gateway-provisioner | grep -q yes"

echo "== delete store B: tools, namespace, volumes, Secrets gone"
ID_B=$(store_field "$B" id)
PVS_B=$(kubectl get pv -o jsonpath="{range .items[?(@.spec.claimRef.namespace=='store-$B')]}{.metadata.name} {end}")
api DELETE "/stores/$ID_B" >/dev/null
for _ in $(seq 1 90); do [ "$(store_field "$B" status)" = none ] && break; sleep 3; done
check "store B is gone from the dashboard" "[ \"\$(store_field $B status)\" = none ]"
check "store B's tools are gone from the gateway" "! tools | grep -q ${B}__"
check "store B's namespace (Secrets, Ingress) is gone" "! kubectl get ns store-$B >/dev/null 2>&1"
check "store B's volumes are gone" "[ -z \"\$(for pv in $PVS_B; do kubectl get pv \$pv --no-headers 2>/dev/null; done)\" ]"
check "store A still works" "call ${A}__list_orders '{}' | grep -q orders"

echo "== hosted MCP server from a container image"
H="ref$SUF"
check "deploy $HOSTED_IMAGE as a hosted server" "api POST /hosted '{\"name\":\"Hosted ref\",\"slug\":\"$H\",\"image\":\"$HOSTED_IMAGE\",\"port\":8080,\"path\":\"/mcp\",\"secretEnv\":{\"DEMO_TOKEN\":\"s3cret\"}}' | grep -q provisioning"
for _ in $(seq 1 60); do api GET /hosted | grep -q "\"slug\":\"$H\".*\"status\":\"ready\"" && break; sleep 3; done
for _ in $(seq 1 15); do tools | grep -qw "${H}__echo" && break; sleep 2; done
check "hosted server is Ready and its tools are listed" "tools | grep -qw ${H}__echo"
check "hosted pod: non-root, read-only root fs, limits set" "kubectl -n $HOSTED_NS get deploy hosted-$H -o jsonpath='{.spec.template.spec.securityContext.runAsNonRoot}{.spec.template.spec.containers[0].securityContext.readOnlyRootFilesystem}{.spec.template.spec.containers[0].resources.limits.memory}' | grep -q 'truetrue256Mi'"
check "hosted server has its own Secret and NetworkPolicy" "kubectl -n $HOSTED_NS get secret hosted-$H >/dev/null && kubectl -n $HOSTED_NS get networkpolicy hosted-$H >/dev/null"
check "image outside the allowed registries is rejected" "api POST /hosted '{\"name\":\"x\",\"slug\":\"evil$SUF\",\"image\":\"quay.io/evil/x:1\"}' | grep -q 'allowed registr'"
HID=$(api GET /hosted | json "[h['id'] for h in d['servers'] if h['slug']=='$H'][0]")
api DELETE "/hosted/$HID" >/dev/null
for _ in $(seq 1 40); do api GET /hosted | grep -q "\"slug\":\"$H\"" || break; sleep 3; done
check "deleting it removes its tools and every resource" "! tools | grep -q ${H}__ && ! kubectl -n $HOSTED_NS get deploy,svc,secret,networkpolicy hosted-$H >/dev/null 2>&1"

echo "== OAuth (MCP authorization spec), with the official SDK client"
if (cd services/gateway && GATEWAY="$G" EMAIL="$EMAIL" PASSWORD="$PW" npx --no-install tsx test/oauth-e2e.ts) > "$TMP/oauth.log" 2>&1; then
  ok "OAuth flow: $(tail -1 "$TMP/oauth.log")"
else
  bad "OAuth flow"; cat "$TMP/oauth.log"
fi

echo "== audit"
AUDIT=$(api GET '/audit?limit=500')
check "provisioning actions are audited" "echo '$AUDIT' | json \"all(any(r['tool_name']==a and r['outcome']=='ok' for r in d) for a in ['store.create','store.delete','hosted.deploy','hosted.delete'])\" | grep -q True"

echo "== cleanup"
api DELETE "/stores/$ID_A" >/dev/null
for _ in $(seq 1 90); do [ "$(store_field "$A" status)" = none ] && break; sleep 3; done
check "store A deleted" "[ \"\$(store_field $A status)\" = none ]"
api DELETE "/keys/$(api GET /keys | json "[k['id'] for k in d if k['name']=='smoke-platform' and not k['revoked_at']][0]")" >/dev/null
rm -rf "$TMP"
echo
echo "passed: $PASS  failed: $FAIL"
[ "$FAIL" -eq 0 ]
