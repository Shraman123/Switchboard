// Store provisioning: one WooCommerce store per namespace, installed with the
// same Helm chart as the main store, then registered in the gateway.
//
// Every step is idempotent (server-side apply, create-if-absent Secrets,
// `helm upgrade --install`), so the reconciler can simply re-run a store from
// the top after a crash or a retry; the deadline turns "stuck" into "failed".
import { randomBytes } from "node:crypto";
import { config } from "../config.js";
import { encrypt } from "../crypto.js";
import { one, pool, q } from "../db.js";
import { audit, LABELS, markFailed, markReady, remainingMs, setStep, sleep, type ResourceRow } from "./common.js";
import { releaseStatus, uninstall, upgradeInstall } from "./helm.js";
import { kube } from "./kube.js";

const P = config.provisioning;
const RELEASE = "woo-store";

export interface StoreRow extends ResourceRow {
  namespace: string;
  url: string | null;
  ready_at: string | null;
}

// Automatic retries within one attempt; after that the store fails with the
// reason and the user decides (Retry or Delete).
const MAX_AUTO_RETRIES = 2;
const failures = new Map<string, number>();

export const storeUrl = (slug: string) => P.storeUrlTemplate.replace("{slug}", slug);
export const storeMcpUrl = (ns: string) => `http://${RELEASE}-mcp.${ns}.svc.cluster.local:8080/mcp`;

const hex = (n: number) => randomBytes(n).toString("hex").slice(0, n);

async function ensureNamespace(s: StoreRow) {
  await kube.apply({
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: s.namespace,
      labels: {
        [LABELS.managed]: "true",
        [LABELS.kind]: "store",
        [LABELS.resourceId]: s.id,
        // Lets the gateway's egress NetworkPolicy reach this store's MCP server.
        [LABELS.upstream]: "true",
        // Every pod in a store namespace must meet the "restricted" standard.
        "pod-security.kubernetes.io/enforce": "restricted",
      },
    },
  });
  // The provisioner gets rights inside this namespace only, via a RoleBinding
  // to a ClusterRole it is allowed to bind but does not itself hold cluster-wide.
  await kube.apply({
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "RoleBinding",
    metadata: { name: "switchboard-provisioner", namespace: s.namespace, labels: { [LABELS.managed]: "true" } },
    roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: P.tenantClusterRole },
    subjects: [{ kind: "ServiceAccount", name: P.serviceAccount, namespace: P.serviceAccountNamespace }],
  });
}

// Generated once and never overwritten: the database on the volume keeps
// using these values, so a retry must not rotate them.
async function ensureSecret(s: StoreRow) {
  await kube.createIfAbsent({
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: "store-credentials", namespace: s.namespace, labels: { [LABELS.managed]: "true" } },
    type: "Opaque",
    stringData: {
      "db-password": hex(32),
      "db-root-password": hex(32),
      "admin-password": hex(20),
      "wp-salt": hex(64),
      "wc-consumer-key": `ck_${hex(40)}`,
      "wc-consumer-secret": `cs_${hex(40)}`,
      "mcp-token": hex(48),
    },
  } as any);
}

// A store that never became ready holds no user data, so an interrupted or
// failed install is cleared completely, volumes included: a database killed
// during its first-time initialisation leaves files it cannot start from.
async function clearInterruptedInstall(s: StoreRow) {
  const status = await releaseStatus(RELEASE, s.namespace);
  if (!status || status === "deployed") return;
  await setStep("stores", s.id, `clearing interrupted install (helm status: ${status})`);
  await uninstall(RELEASE, s.namespace, 180_000);
  // Helm does not remove hook resources: the bootstrap Job's pod would keep
  // the content volume "in use" and block its deletion.
  for (const job of await kube.list("Job", s.namespace, "")) await kube.delete("Job", s.namespace, job.metadata.name);
  for (const pvc of await kube.list("PersistentVolumeClaim", s.namespace, "")) {
    await kube.delete("PersistentVolumeClaim", s.namespace, pvc.metadata.name);
  }
  for (let i = 0; i < 60 && (await kube.list("PersistentVolumeClaim", s.namespace, "")).length; i++) await sleep(2000);
  // Never install onto a volume that is still going away; retry next tick.
  if ((await kube.list("PersistentVolumeClaim", s.namespace, "")).length) throw new Error("old volumes are still being deleted");
}

// While helm waits, watch the pods: a crash loop or an image that cannot be
// pulled will never get better, so stop early with the pod's own reason.
async function watchPods(s: StoreRow, abort: AbortController) {
  while (!abort.signal.aborted) {
    await sleep(10_000);
    if (abort.signal.aborted) return;
    try {
      // Deleted while provisioning: stop now, the delete runs next.
      const cur = await storeById(s.id);
      if (!cur || cur.status === "deleting") return abort.abort(new Error("store deleted during provisioning"));
      for (const pod of await kube.list("Pod", s.namespace, "")) {
        for (const cs of [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])]) {
          const w = cs.state?.waiting;
          if (w && ["ImagePullBackOff", "ErrImagePull", "CreateContainerConfigError"].includes(w.reason)) {
            return abort.abort(new Error(`${pod.metadata.name}: ${w.reason}: ${w.message ?? ""}`.trim()));
          }
          if (w?.reason === "CrashLoopBackOff" && cs.restartCount >= 3) {
            const logs = (await kube.podLogs(s.namespace, pod.metadata.name, 3)).split("\n").pop() ?? "";
            return abort.abort(new Error(`${pod.metadata.name} (${cs.name}) keeps crashing${logs ? `: ${logs}` : ""}`.slice(0, 500)));
          }
        }
      }
    } catch {
      // Watching is best effort; helm's own timeout still applies.
    }
  }
}

async function installChart(s: StoreRow) {
  if (!s.ready_at) await clearInterruptedInstall(s);
  await setStep("stores", s.id, "installing chart (database, WordPress, WooCommerce bootstrap, MCP server)");
  const abort = new AbortController();
  void watchPods(s, abort);
  try {
    await upgradeInstall({
    release: RELEASE,
    namespace: s.namespace,
    chart: P.storeChart,
    valuesFiles: [P.storeValuesFile],
    set: {
      siteUrl: storeUrl(s.slug),
      title: s.name,
      "quota.enabled": "true",
      "mcp.allowedClients.namespace": P.gatewayNamespace,
    },
    timeoutMs: Math.max(60_000, remainingMs(s)),
      signal: abort.signal,
    });
  } finally {
    if (!abort.signal.aborted) abort.abort("done");
  }
}

async function register(s: StoreRow): Promise<string> {
  const secret = await kube.get("Secret", s.namespace, "store-credentials");
  const token = Buffer.from(secret.data["mcp-token"], "base64").toString();
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const row = await c.query(
      `INSERT INTO servers (slug, name, url, auth_type, credential_enc, timeout_ms, managed_by, owner_id)
       VALUES ($1, $2, $3, 'bearer', $4, $5, 'store', $6)
       ON CONFLICT (slug) DO UPDATE SET url=EXCLUDED.url, credential_enc=EXCLUDED.credential_enc, updated_at=now()
         WHERE servers.managed_by='store'
       RETURNING id`,
      [s.slug, `Store: ${s.name}`, storeMcpUrl(s.namespace), encrypt(token), config.upstream.defaultCallTimeoutMs, s.owner_id],
    );
    if (!row.rowCount) throw new Error(`server slug "${s.slug}" is taken by a non-store server`);
    const id = row.rows[0].id;
    // Same defaults as the main store: writes need an admin (or the owner).
    for (const tool of ["create_product", "update_order_status"]) {
      await c.query("INSERT INTO tool_policies (server_id, tool_name, admin_only) VALUES ($1,$2,true) ON CONFLICT DO NOTHING", [id, tool]);
    }
    await c.query("COMMIT");
    return id;
  } catch (err) {
    await c.query("ROLLBACK");
    throw err;
  } finally {
    c.release();
  }
}

export async function provisionStore(s: StoreRow) {
  const t0 = Date.now();
  if (remainingMs(s) <= 0) {
    await markFailed("stores", s.id, `provisioning did not finish within ${P.storeTimeoutMs / 60000} minutes (last step: ${s.step ?? "start"})`);
    await audit(s.owner_id, "store.create", s.slug, "error", 0, "timeout");
    return;
  }
  try {
    await setStep("stores", s.id, "creating namespace, RBAC and Secrets");
    await ensureNamespace(s);
    await ensureSecret(s);
    await installChart(s);
    await setStep("stores", s.id, "registering MCP server in the gateway");
    const serverId = await register(s);
    await markReady("stores", s.id, serverId, { url: storeUrl(s.slug) });
    failures.delete(s.id);
    await audit(s.owner_id, "store.create", s.slug, "ok", Date.now() - t0);
    console.log(`store ${s.slug} ready`);
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`store ${s.slug}: ${msg}`);
    // Out of time, out of retries, or not retryable: fail with the reason.
    // Otherwise the next tick retries from the top.
    const n = (failures.get(s.id) ?? 0) + 1;
    failures.set(s.id, n);
    if (remainingMs(s) <= 5_000 || n > MAX_AUTO_RETRIES || /quota|forbidden|invalid/i.test(msg)) {
      failures.delete(s.id);
      await markFailed("stores", s.id, msg);
      await audit(s.owner_id, "store.create", s.slug, "error", Date.now() - t0, msg);
    } else {
      await q("UPDATE stores SET reason=$2, updated_at=now() WHERE id=$1", [s.id, `retrying: ${msg}`.slice(0, 1000)]);
    }
  }
}

// Teardown order: stop routing first (tools disappear at once), then remove
// the release, then the namespace, which takes Secrets, volumes and the
// Ingress with it.
export async function deleteStore(s: StoreRow) {
  const t0 = Date.now();
  try {
    await q("DELETE FROM servers WHERE managed_by='store' AND (id=$1 OR slug=$2)", [s.server_id, s.slug]);
    await setStep("stores", s.id, "uninstalling chart");
    if (await kube.get("Namespace", undefined, s.namespace)) {
      await uninstall(RELEASE, s.namespace, 180_000);
      await setStep("stores", s.id, "deleting namespace (volumes, Secrets, Ingress)");
      await kube.delete("Namespace", undefined, s.namespace);
      for (let i = 0; i < 90 && (await kube.get("Namespace", undefined, s.namespace)); i++) await sleep(2000);
      if (await kube.get("Namespace", undefined, s.namespace)) throw new Error("namespace still terminating");
    }
    await q("DELETE FROM stores WHERE id=$1", [s.id]);
    await audit(s.owner_id, "store.delete", s.slug, "ok", Date.now() - t0);
    console.log(`store ${s.slug} deleted`);
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`store ${s.slug} delete: ${msg}`);
    await q("UPDATE stores SET reason=$2, updated_at=now() WHERE id=$1", [s.id, `delete retrying: ${msg}`.slice(0, 1000)]);
  }
}

export const storesNeedingWork = () => q<StoreRow>("SELECT * FROM stores WHERE status IN ('provisioning', 'deleting') ORDER BY created_at");
export const storeById = (id: string) => one<StoreRow>("SELECT * FROM stores WHERE id=$1", [id]);
