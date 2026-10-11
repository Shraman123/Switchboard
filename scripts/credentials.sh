#!/usr/bin/env bash
# Print the generated sign-in credentials (read from the Kubernetes Secrets).
set -euo pipefail
get() { kubectl -n "$1" get secret "$2" -o "jsonpath={.data.$3}" | base64 -d; }
echo "Dashboard admin:  $(get gateway gateway-secrets admin-email) / $(get gateway gateway-secrets admin-password)"
echo "WordPress admin:  storeadmin / $(get store store-credentials admin-password)"
