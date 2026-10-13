#!/usr/bin/env python3
"""Policy check over rendered Helm output (CI runs it on every chart x values file).

    helm template x charts/gateway -f charts/gateway/values-prod.yaml | python scripts/check-manifests.py

Fails if any workload container is missing resource requests/limits or (for
long-running workloads) readiness/liveness probes, runs as root, allows
privilege escalation, or if a Secret carries literal data in the chart.
"""
import sys

import yaml

LONG_RUNNING = {"Deployment", "StatefulSet", "DaemonSet"}
WORKLOADS = LONG_RUNNING | {"Job", "CronJob"}


def pod_spec(doc):
    spec = doc.get("spec", {})
    if doc["kind"] == "CronJob":
        spec = spec.get("jobTemplate", {}).get("spec", {})
    return spec.get("template", {}).get("spec", {})


def main():
    errors, checked = [], 0
    for doc in yaml.safe_load_all(sys.stdin):
        if not doc or "kind" not in doc:
            continue
        kind, name = doc["kind"], doc.get("metadata", {}).get("name", "?")
        where = f"{kind}/{name}"
        if kind == "Secret" and (doc.get("data") or doc.get("stringData")):
            errors.append(f"{where}: Secret with literal data rendered from the chart")
        if kind not in WORKLOADS:
            continue
        checked += 1
        spec = pod_spec(doc)
        pod_sc = spec.get("securityContext", {})
        for c in spec.get("initContainers", []) + spec.get("containers", []):
            cw = f"{where} container {c['name']}"
            res = c.get("resources", {})
            for part in ("requests", "limits"):
                for r in ("cpu", "memory"):
                    if r not in res.get(part, {}):
                        errors.append(f"{cw}: missing resources.{part}.{r}")
            sc = c.get("securityContext", {})
            if not (sc.get("runAsNonRoot") or pod_sc.get("runAsNonRoot")):
                errors.append(f"{cw}: runAsNonRoot not set")
            if sc.get("allowPrivilegeEscalation") is not False:
                errors.append(f"{cw}: allowPrivilegeEscalation must be false")
            if "ALL" not in sc.get("capabilities", {}).get("drop", []):
                errors.append(f"{cw}: capabilities.drop must include ALL")
            is_init = c in spec.get("initContainers", [])
            if kind in LONG_RUNNING and not is_init:
                for probe in ("readinessProbe", "livenessProbe"):
                    if probe not in c:
                        errors.append(f"{cw}: missing {probe}")
    for e in errors:
        print("FAIL", e)
    print(f"checked {checked} workloads, {len(errors)} problems")
    sys.exit(1 if errors or checked == 0 else 0)


if __name__ == "__main__":
    main()
