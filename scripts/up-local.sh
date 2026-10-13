#!/usr/bin/env bash
# One command from zero to a running local platform:
# k3d cluster + local registry -> build/push images -> secrets -> helm installs.
#   LLM_API_KEY=gsk_... scripts/up-local.sh
set -euo pipefail
cd "$(dirname "$0")/.."
K3D="${K3D:-k3d}"

if ! "$K3D" cluster list 2>/dev/null | grep -q '^switchboard '; then
  "$K3D" cluster create --config deploy/k3d-config.yaml --wait
fi
kubectl config use-context k3d-switchboard >/dev/null
kubectl -n kube-system rollout status deploy/traefik --timeout=180s >/dev/null 2>&1 || true

scripts/build-images.sh
scripts/deploy.sh local
scripts/credentials.sh
