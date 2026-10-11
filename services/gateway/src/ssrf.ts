// SSRF guard for admin-supplied upstream URLs.
//
// Two layers:
//  1. validateUpstreamUrl() runs when a server is added/edited and gives the
//     admin a clear error.
//  2. upstreamDispatcher checks the *resolved IP of every connection* the
//     gateway opens to an upstream, so a hostname that later re-resolves to a
//     private address (DNS rebinding) is still blocked. Redirects are refused
//     by the MCP client, so a 30x cannot bounce us somewhere else.
// A Kubernetes NetworkPolicy on the gateway's egress is the third layer.
import dns from "node:dns";
import net from "node:net";
import { Agent } from "undici";
import { config } from "./config.js";

const BLOCKED_V4: [string, number][] = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, incl. 169.254.169.254 cloud metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4],
];

const v4ToInt = (ip: string) => ip.split(".").reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
const inV4 = (ip: string, [base, bits]: [string, number]) =>
  bits === 0 || (v4ToInt(ip) >>> (32 - bits)) === (v4ToInt(base) >>> (32 - bits));

export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return BLOCKED_V4.some((r) => inV4(ip, r));
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPrivateAddress(v6.slice(7)); // v4-mapped
  return (
    v6 === "::" ||
    v6 === "::1" ||
    v6.startsWith("fe8") || v6.startsWith("fe9") || v6.startsWith("fea") || v6.startsWith("feb") || // link-local
    v6.startsWith("fc") || v6.startsWith("fd") || // unique local, incl. fd00:ec2::254 (AWS metadata)
    v6.startsWith("ff") // multicast
  );
}

export function hostAllowedInternal(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return config.ssrf.allowedInternalSuffixes.some((s) => h.endsWith(s.toLowerCase()));
}

export class SsrfError extends Error {}

export async function validateUpstreamUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfError("not a valid URL");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && config.ssrf.allowHttp)) {
    throw new SsrfError(`scheme ${url.protocol} is not allowed`);
  }
  if (url.username || url.password) throw new SsrfError("credentials in the URL are not allowed; use the credential field");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (hostAllowedInternal(host)) return url;
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.promises.lookup(host, { all: true }).catch(() => {
    throw new SsrfError(`cannot resolve ${host}`);
  });
  const bad = addrs.find((a) => isPrivateAddress(a.address));
  if (bad) {
    throw new SsrfError(
      `${host} resolves to ${bad.address}, a private/internal address. In-cluster servers must use an allowed service suffix (${config.ssrf.allowedInternalSuffixes.join(", ") || "none configured"}).`,
    );
  }
  return url;
}

// Re-check at connect time (defeats DNS rebinding).
const guardedLookup: typeof dns.lookup = ((hostname: string, options: any, callback: any) => {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  dns.lookup(hostname, { ...options, all: true }, (err, addresses: any) => {
    if (err) return callback(err);
    const list = (addresses as dns.LookupAddress[]) ?? [];
    if (!hostAllowedInternal(hostname)) {
      const bad = list.find((a) => isPrivateAddress(a.address));
      if (bad) return callback(new SsrfError(`blocked connection to internal address ${bad.address} (${hostname})`));
    }
    if (options.all) return callback(null, list);
    return callback(null, list[0]?.address, list[0]?.family);
  });
}) as any;

export const upstreamDispatcher = new Agent({
  connect: { lookup: guardedLookup, timeout: 5000 },
  keepAliveTimeout: 30_000,
});
