// Minimal Kubernetes API client for the provisioner: in-cluster service
// account, server-side apply, get, list, delete. Small enough to read in one
// sitting, which matters more here than covering the whole API.
import fs from "node:fs";
import { Agent, fetch } from "undici";

const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";
const FIELD_MANAGER = "switchboard-provisioner";

export class KubeError extends Error {
  constructor(message: string, readonly status: number, readonly reason?: string) {
    super(message);
  }
}

// kind -> [api prefix, plural, namespaced]
const KINDS: Record<string, [string, string, boolean]> = {
  Namespace: ["/api/v1", "namespaces", false],
  Secret: ["/api/v1", "secrets", true],
  Service: ["/api/v1", "services", true],
  Pod: ["/api/v1", "pods", true],
  PersistentVolumeClaim: ["/api/v1", "persistentvolumeclaims", true],
  Job: ["/apis/batch/v1", "jobs", true],
  Deployment: ["/apis/apps/v1", "deployments", true],
  NetworkPolicy: ["/apis/networking.k8s.io/v1", "networkpolicies", true],
  RoleBinding: ["/apis/rbac.authorization.k8s.io/v1", "rolebindings", true],
};

export interface KObj {
  kind: string;
  metadata: { name: string; namespace?: string; labels?: Record<string, string> };
  [k: string]: unknown;
}

export function kindPath(kind: string, namespace?: string, name?: string): string {
  const k = KINDS[kind];
  if (!k) throw new Error(`unsupported kind ${kind}`);
  const [prefix, plural, namespaced] = k;
  let p = prefix;
  if (namespaced) p += `/namespaces/${encodeURIComponent(namespace ?? "")}`;
  p += `/${plural}`;
  if (name) p += `/${encodeURIComponent(name)}`;
  return p;
}

class Kube {
  private agent?: Agent;
  private base = `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT ?? "443"}`;

  private dispatcher() {
    this.agent ??= new Agent({ connect: { ca: fs.readFileSync(`${SA_DIR}/ca.crt`) } });
    return this.agent;
  }

  // The projected token rotates, so it is read on every request.
  private async request(method: string, path: string, body?: unknown, contentType = "application/json") {
    const token = fs.readFileSync(`${SA_DIR}/token`, "utf8").trim();
    const res = await fetch(this.base + path, {
      method,
      dispatcher: this.dispatcher(),
      headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body ? { "content-type": contentType } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new KubeError(`${method} ${path}: ${data?.message ?? `HTTP ${res.status}`}`, res.status, data?.reason);
    return data;
  }

  async get<T = any>(kind: string, namespace: string | undefined, name: string): Promise<T | null> {
    try {
      return await this.request("GET", kindPath(kind, namespace, name));
    } catch (err) {
      if (err instanceof KubeError && err.status === 404) return null;
      throw err;
    }
  }

  async list<T = any>(kind: string, namespace: string | undefined, labelSelector: string): Promise<T[]> {
    const data = await this.request("GET", `${kindPath(kind, namespace)}?labelSelector=${encodeURIComponent(labelSelector)}`);
    return data.items ?? [];
  }

  // Server-side apply: declarative, idempotent, safe to repeat after a crash.
  async apply(obj: KObj) {
    const path = kindPath(obj.kind, obj.metadata.namespace, obj.metadata.name);
    return this.request("PATCH", `${path}?fieldManager=${FIELD_MANAGER}&force=true`, obj, "application/apply-patch+yaml");
  }

  // Create only if absent; never overwrite (used for generated credentials,
  // which must stay stable across retries because the database keeps them).
  async createIfAbsent(obj: KObj): Promise<boolean> {
    try {
      await this.request("POST", kindPath(obj.kind, obj.metadata.namespace), obj);
      return true;
    } catch (err) {
      if (err instanceof KubeError && err.status === 409) return false;
      throw err;
    }
  }

  async delete(kind: string, namespace: string | undefined, name: string): Promise<void> {
    try {
      await this.request("DELETE", kindPath(kind, namespace, name), { propagationPolicy: "Foreground" });
    } catch (err) {
      if (err instanceof KubeError && err.status === 404) return;
      throw err;
    }
  }

  async podLogs(namespace: string, pod: string, lines = 5): Promise<string> {
    const token = fs.readFileSync(`${SA_DIR}/token`, "utf8").trim();
    const res = await fetch(`${this.base}${kindPath("Pod", namespace, pod)}/log?tailLines=${lines}`, {
      dispatcher: this.dispatcher(),
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok ? (await res.text()).trim() : "";
  }
}

export const kube = new Kube();
