// Thin fetch wrapper for the gateway's /api. Same origin; the session is an
// httpOnly cookie the page never sees. Every state change carries the custom
// X-Switchboard header the backend requires (CSRF defence).
export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = opts.method ?? "GET";
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: {
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(method !== "GET" ? { "x-switchboard": "1" } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? `HTTP ${res.status}`, res.status);
  return data as T;
}

export interface Me {
  id: string;
  email: string;
  name: string;
  role: "admin" | "member";
  chatEnabled: boolean;
  mcpUrl: string;
}

export interface Tool {
  name: string;
  exposedName: string;
  description: string;
  inputSchema: any;
  adminOnly: boolean;
  hidden: boolean;
  pendingReview: boolean;
  availableToMe: boolean;
}

export interface Server {
  id: string;
  slug: string;
  name: string;
  url?: string;
  authType: "none" | "bearer" | "header";
  authHeaderName: string | null;
  hasCredential: boolean;
  enabled: boolean;
  timeoutMs: number;
  status: "connected" | "unreachable" | "disabled" | "unknown";
  statusReason: string | null;
  lastCheckedAt: string | null;
  lastOkAt: string | null;
  tools: Tool[];
}

export const ago = (iso: string | null) => {
  if (!iso) return "never";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.max(s, 0)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
};
