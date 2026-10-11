#!/usr/bin/env bash
# Build images and push them to a registry.
#   scripts/build-images.sh                    # all images -> local k3d registry (localhost:5111)
#   scripts/build-images.sh woo-mcp gateway    # only some
#   REGISTRY=ghcr.io/you/switchboard TAG=0.1.0 scripts/build-images.sh   # for a VPS
# In-cluster, the local registry is reachable as registry.localhost:5111
# (see deploy/k3d-config.yaml and values-local.yaml).
set -euo pipefail
cd "$(dirname "$0")/.."

TAG="${TAG:-dev}"
REGISTRY="${REGISTRY:-localhost:5111/switchboard}"

declare -A CONTEXT=(
  [woo-store]=images/woo-store
  [woo-mcp]=services/woo-mcp
  [notes-mcp]=services/notes-mcp
  [everything-mcp]=images/everything-mcp
  [gateway]=services/gateway
  [dashboard]=services/dashboard
)

names=("$@")
[ ${#names[@]} -eq 0 ] && names=(woo-store woo-mcp notes-mcp everything-mcp gateway dashboard)

for n in "${names[@]}"; do
  img="$REGISTRY/$n:$TAG"
  echo "==> $img"
  docker build -q -t "$img" "${CONTEXT[$n]}" >/dev/null
  docker push -q "$img" >/dev/null
done
echo "pushed: ${names[*]} ($TAG)"
