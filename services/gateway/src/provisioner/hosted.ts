// Hosted MCP servers: an admin gives a container image instead of a URL and
// the platform runs it in the mcp-hosted namespace, with its own Secret,
// fixed limits, a locked-down pod and a NetworkPolicy, then registers it.
import { config } from "../config.js";
import { decrypt } from "../crypto.js";
import { one, pool, q } from "../db.js";
import { audit, LABELS, markFailed, markReady, remainingMs, setStep, sleep, type ResourceRow } from "./common.js";
import { kube } from "./kube.js";

const P = config.provisioning;
const NS = () => P.hostedNamespace;

export interface HostedRow extends ResourceRow {
  image: string;
  port: number;
  path: string;
  env: Record<string, string>;
  secret_env_enc: string | null;
  allow_internet: boolean;
  size: "small" | "medium";
}

const SIZES = {
  small: { requests: { cpu: "25m", memory: "64Mi" }, limits: { cpu: "250m", memory: "256Mi" } },
  medium: { requests: { cpu: "50m", memory: "128Mi" }, limits: { cpu: "500m", memory: "512Mi" } },
};

export const hostedName = (slug: string) => `hosted-${slug}`;
export const hostedUrl = (h: Pick<HostedRow, "slug" | "path">) => `http://${hostedName(h.slug)}.${NS()}.svc.cluster.local:8080${h.path}`;

function manifests(h: HostedRow) {
  const name = hostedName(h.slug);
  const labels = { "app.kubernetes.io/name": name, "app.kubernetes.io/part-of": "switchboard", [LABELS.managed]: "true", [LABELS.kind]: "hosted", [LABELS.resourceId]: h.id };
  const selector = { "app.kubernetes.io/name": name };
  const meta = { name, namespace: NS(), labels };
  const secretEnv: Record<string, string> = h.secret_env_enc ? JSON.parse(decrypt(h.secret_env_enc)) : {};
  const probe = { tcpSocket: { port: "mcp" } };
  return [
    { apiVersion: "v1", kind: "Secret", metadata: meta, type: "Opaque", stringData: secretEnv },
    {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: meta,
      spec: {
        replicas: 1,
        selector: { matchLabels: selector },
        template: {
          metadata: { labels },
          spec: {
            automountServiceAccountToken: false, // no Kubernetes API access
            enableServiceLinks: false, // no env vars describing other services
            // A fixed unprivileged UID whatever the image says: many images
            // default to root, and a named USER cannot be verified as non-root.
            securityContext: { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, seccompProfile: { type: "RuntimeDefault" } },
            containers: [
              {
                name: "mcp",
                image: h.image,
                imagePullPolicy: "IfNotPresent",
                ports: [{ name: "mcp", containerPort: h.port }],
                env: Object.entries(h.env).map(([k, v]) => ({ name: k, value: v })),
                envFrom: [{ secretRef: { name } }],
                securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } },
                resources: SIZES[h.size],
                startupProbe: { ...probe, periodSeconds: 2, failureThreshold: 60 },
                readinessProbe: { ...probe, periodSeconds: 5 },
                livenessProbe: { ...probe, periodSeconds: 15, failureThreshold: 4 },
                volumeMounts: [{ name: "tmp", mountPath: "/tmp" }],
              },
            ],
            volumes: [{ name: "tmp", emptyDir: { sizeLimit: "64Mi" } }],
          },
        },
      },
    },
    {
      apiVersion: "v1",
      kind: "Service",
      metadata: meta,
      spec: { selector, ports: [{ name: "http", port: 8080, targetPort: "mcp" }] },
    },
    {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: meta,
      spec: {
        podSelector: { matchLabels: selector },
        policyTypes: ["Ingress", "Egress"],
        // Only the gateway may call it.
        ingress: [
          {
            from: [
              {
                namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": P.gatewayNamespace } },
                podSelector: { matchLabels: { "app.kubernetes.io/component": "gateway" } },
              },
            ],
            ports: [{ protocol: "TCP", port: h.port }],
          },
        ],
        // DNS always; the public internet only if the admin opted in, and
        // never private ranges (no other pods, no cloud metadata).
        egress: [
          {
            to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } }, podSelector: { matchLabels: { "k8s-app": "kube-dns" } } }],
            ports: [{ protocol: "UDP", port: 53 }, { protocol: "TCP", port: 53 }],
          },
          ...(h.allow_internet
            ? [
                {
                  to: [{ ipBlock: { cidr: "0.0.0.0/0", except: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "169.254.0.0/16", "127.0.0.0/8"] } }],
                  ports: [{ protocol: "TCP", port: 443 }, { protocol: "TCP", port: 80 }],
                },
              ]
            : []),
        ],
      },
    },
  ];
}

// Turn a pod that will never become ready into a clear reason, early.
async function podProblem(h: HostedRow): Promise<string | null> {
  const pods = await kube.list("Pod", NS(), `app.kubernetes.io/name=${hostedName(h.slug)}`);
  for (const pod of pods) {
    for (const cs of pod.status?.containerStatuses ?? []) {
      const w = cs.state?.waiting;
      if (w && ["ImagePullBackOff", "ErrImagePull", "InvalidImageName", "CreateContainerConfigError", "CreateContainerError"].includes(w.reason)) {
        return `${w.reason}: ${w.message ?? ""}`.trim();
      }
      if (w?.reason === "CrashLoopBackOff" && cs.restartCount >= 2) {
        const logs = await kube.podLogs(NS(), pod.metadata.name, 5);
        return `container keeps crashing (exit ${cs.lastState?.terminated?.exitCode ?? "?"})${logs ? `; last log lines: ${logs}` : ""}`;
      }
    }
    const unsched = (pod.status?.conditions ?? []).find((c: any) => c.type === "PodScheduled" && c.status === "False");
    if (unsched?.message && /Insufficient|quota/i.test(unsched.message)) return `cannot be scheduled: ${unsched.message}`;
  }
  return null;
}

async function register(h: HostedRow): Promise<string> {
  const row = await one<{ id: string }>(
    `INSERT INTO servers (slug, name, url, auth_type, timeout_ms, managed_by, owner_id)
     VALUES ($1, $2, $3, 'none', $4, 'hosted', $5)
     ON CONFLICT (slug) DO UPDATE SET url=EXCLUDED.url, updated_at=now() WHERE servers.managed_by='hosted'
     RETURNING id`,
    [h.slug, h.name, hostedUrl(h), config.upstream.defaultCallTimeoutMs, h.owner_id],
  );
  if (!row) throw new Error(`server slug "${h.slug}" is taken by a non-hosted server`);
  return row.id;
}

export async function provisionHosted(h: HostedRow) {
  const t0 = Date.now();
  if (remainingMs(h) <= 0) {
    await markFailed("hosted_servers", h.id, `did not become ready within ${P.hostedTimeoutMs / 60000} minutes`);
    return;
  }
  try {
    await setStep("hosted_servers", h.id, "applying Secret, Deployment, Service and NetworkPolicy");
    for (const m of manifests(h)) await kube.apply(m as any);
    await setStep("hosted_servers", h.id, "waiting for the pod to become ready");
    for (;;) {
      const d = await kube.get("Deployment", NS(), hostedName(h.slug));
      if ((d?.status?.availableReplicas ?? 0) >= 1) break;
      const problem = await podProblem(h);
      if (problem) throw new Error(problem);
      if (remainingMs(h) <= 0) throw new Error(`not ready within ${P.hostedTimeoutMs / 60000} minutes`);
      await sleep(3000);
    }
    const serverId = await register(h);
    await markReady("hosted_servers", h.id, serverId);
    await audit(h.owner_id, "hosted.deploy", h.slug, "ok", Date.now() - t0);
  } catch (err) {
    const msg = (err as Error).message;
    await markFailed("hosted_servers", h.id, msg);
    await audit(h.owner_id, "hosted.deploy", h.slug, "error", Date.now() - t0, msg);
  }
}

export async function deleteHosted(h: HostedRow) {
  const t0 = Date.now();
  try {
    await q("DELETE FROM servers WHERE managed_by='hosted' AND (id=$1 OR slug=$2)", [h.server_id, h.slug]);
    const name = hostedName(h.slug);
    for (const kind of ["NetworkPolicy", "Service", "Deployment", "Secret"]) await kube.delete(kind, NS(), name);
    for (let i = 0; i < 30 && (await kube.list("Pod", NS(), `app.kubernetes.io/name=${name}`)).length; i++) await sleep(2000);
    await pool.query("DELETE FROM hosted_servers WHERE id=$1", [h.id]);
    await audit(h.owner_id, "hosted.delete", h.slug, "ok", Date.now() - t0);
  } catch (err) {
    await q("UPDATE hosted_servers SET reason=$2, updated_at=now() WHERE id=$1", [h.id, `delete retrying: ${(err as Error).message}`.slice(0, 1000)]);
  }
}

export const hostedNeedingWork = () => q<HostedRow>("SELECT * FROM hosted_servers WHERE status IN ('provisioning', 'deleting') ORDER BY created_at");
