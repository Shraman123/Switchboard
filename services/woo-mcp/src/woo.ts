// Minimal WooCommerce REST API (v3) client.
//
// Transport choice: the MCP server reaches WordPress over the in-cluster
// Service on plain HTTP. WooCommerce only accepts consumer keys over HTTP when
// the request is signed with OAuth 1.0a (one-legged), so that is what we do:
// the consumer secret never crosses the network, only an HMAC-SHA256
// signature, and WooCommerce rejects replayed nonces and stale timestamps.
import { createHmac, randomBytes } from "node:crypto";

export class WooError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) {
    super(message);
  }
}

type Query = Record<string, string | number | boolean | undefined>;

// RFC 3986 percent-encoding, matching PHP's rawurlencode (WooCommerce's side).
const enc = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

export interface WooConfig {
  baseUrl: string; // in-cluster URL, e.g. http://woo-store-web.store.svc:8080
  consumerKey: string;
  consumerSecret: string;
  timeoutMs: number;
}

export class WooClient {
  private homeUrl?: string;

  constructor(private cfg: WooConfig) {}

  // WooCommerce builds the signature base string from the site's *home URL*
  // (always with the http scheme when the request itself is not TLS), not from
  // the Host we connected to. We read it from the public REST index once.
  private async signingBase(): Promise<string> {
    if (!this.homeUrl) {
      const res = await fetch(new URL("/wp-json/", this.cfg.baseUrl), {
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
      if (!res.ok) throw new WooError(`store index returned HTTP ${res.status}`, res.status);
      const index = (await res.json()) as { home?: string };
      if (!index.home) throw new WooError("store index has no home URL");
      this.homeUrl = index.home.replace(/^https:/, "http:").replace(/\/$/, "");
    }
    return this.homeUrl;
  }

  sign(method: string, base: string, path: string, query: Record<string, string>): Record<string, string> {
    const params: Record<string, string> = {
      ...query,
      oauth_consumer_key: this.cfg.consumerKey,
      oauth_nonce: randomBytes(16).toString("hex"),
      oauth_signature_method: "HMAC-SHA256",
      oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    };
    // Same steps as WooCommerce's check_oauth_signature(): sort by raw key,
    // encode key and value, encode "key=value" again, join with "%26".
    const paramString = Object.keys(params)
      .sort()
      .map((k) => enc(`${enc(k)}=${enc(params[k])}`))
      .join("%26");
    const baseString = `${method.toUpperCase()}&${enc(base + path)}&${paramString}`;
    const signature = createHmac("sha256", this.cfg.consumerSecret + "&").update(baseString).digest("base64");
    return { ...params, oauth_signature: signature };
  }

  async request<T>(method: "GET" | "POST" | "PUT", path: string, query: Query = {}, body?: unknown): Promise<T> {
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") clean[k] = String(v);

    const fullPath = `/wp-json/wc/v3${path}`;
    const signed = this.sign(method, await this.signingBase(), fullPath, clean);
    const url = new URL(fullPath, this.cfg.baseUrl);
    for (const [k, v] of Object.entries(signed)) url.searchParams.set(k, v);

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
        redirect: "error",
      });
    } catch (err) {
      const reason = (err as Error).name === "TimeoutError" ? `timed out after ${this.cfg.timeoutMs}ms` : (err as Error).message;
      throw new WooError(`store unreachable: ${reason}`);
    }
    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      throw new WooError(`store returned non-JSON (HTTP ${res.status})`, res.status);
    }
    if (!res.ok) {
      const e = data as { code?: string; message?: string } | null;
      throw new WooError(e?.message ?? `HTTP ${res.status}`, res.status, e?.code);
    }
    return data as T;
  }
}
