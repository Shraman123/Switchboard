// The signature must match what WooCommerce's PHP check_oauth_signature()
// computes on the server, or every call fails with 401. This re-implements
// that PHP routine independently and checks our client against it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { WooClient } from "./woo.js";

const rawurlencode = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

// Port of WC_REST_Authentication::check_oauth_signature (WooCommerce 9+).
function wooServerSignature(method: string, url: string, params: Record<string, string>, secret: string) {
  const p = { ...params };
  delete p.oauth_signature;
  const sorted = Object.keys(p).sort();
  const pairs = sorted.map((k) => rawurlencode(rawurlencode(k) + "=" + rawurlencode(p[k])));
  const base = method + "&" + rawurlencode(url) + "&" + pairs.join("%26");
  return createHmac("sha256", secret + "&").update(base).digest("base64");
}

const client = new WooClient({ baseUrl: "http://web:8080", consumerKey: "ck_abc", consumerSecret: "cs_s3cret", timeoutMs: 1000 });

test("signature matches WooCommerce's server-side computation", () => {
  const query = { status: "processing", after: "2026-10-14T00:00:00+05:30", search: "mishti doi & co" };
  const signed = client.sign("GET", "http://store.localtest.me", "/wp-json/wc/v3/orders", query);
  const expected = wooServerSignature("GET", "http://store.localtest.me/wp-json/wc/v3/orders", signed, "cs_s3cret");
  assert.equal(signed.oauth_signature, expected);
  assert.equal(signed.oauth_signature_method, "HMAC-SHA256");
});

test("signed parameters never include the consumer secret", () => {
  const signed = client.sign("POST", "http://store.localtest.me", "/wp-json/wc/v3/products", {});
  assert.ok(!Object.values(signed).some((v) => v.includes("cs_s3cret")));
});

test("every request gets a fresh nonce", () => {
  const a = client.sign("GET", "http://s", "/x", {});
  const b = client.sign("GET", "http://s", "/x", {});
  assert.notEqual(a.oauth_nonce, b.oauth_nonce);
});
