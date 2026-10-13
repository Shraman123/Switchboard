// End-to-end OAuth check against a running gateway, using the official MCP
// SDK client's own OAuth implementation (discovery, dynamic registration,
// PKCE, token exchange). The "browser" step signs in to the dashboard API and
// approves the consent request, exactly what a user clicks through.
//
//   GATEWAY=http://gateway.localtest.me EMAIL=... PASSWORD=... npx tsx test/oauth-e2e.ts
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

const G = (process.env.GATEWAY ?? "http://gateway.localtest.me").replace(/\/$/, "");
const EMAIL = process.env.EMAIL!;
const PASSWORD = process.env.PASSWORD!;

class TestProvider implements OAuthClientProvider {
  info?: OAuthClientInformationFull;
  saved?: OAuthTokens;
  verifier = "";
  authUrl?: URL;
  get redirectUrl() {
    return "http://127.0.0.1:53682/callback";
  }
  get clientMetadata() {
    return { client_name: "Switchboard OAuth e2e", redirect_uris: [this.redirectUrl], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(i: OAuthClientInformationFull) {
    this.info = i;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(t: OAuthTokens) {
    this.saved = t;
  }
  redirectToAuthorization(url: URL) {
    this.authUrl = url;
  }
  saveCodeVerifier(v: string) {
    this.verifier = v;
  }
  codeVerifier() {
    return this.verifier;
  }
}

let passed = 0;
const step = (name: string) => {
  passed++;
  console.log(`  PASS  ${name}`);
};

const provider = new TestProvider();
const mcpUrl = new URL(`${G}/mcp`);

// 1. Unauthenticated connect: 401 -> discovery -> registration -> authorize URL.
const first = new StreamableHTTPClientTransport(mcpUrl, { authProvider: provider });
await assert.rejects(new Client({ name: "e2e", version: "1" }).connect(first), UnauthorizedError);
assert.ok(provider.info?.client_id.startsWith("sbcl_"), "client registered dynamically");
assert.ok(provider.authUrl, "got an authorization URL");
assert.equal(provider.authUrl!.searchParams.get("code_challenge_method"), "S256");
step("401 -> metadata discovery -> dynamic client registration -> PKCE authorize URL");

// 2. The browser part: authorize redirects to the dashboard consent screen.
const auth = await fetch(provider.authUrl!, { redirect: "manual" });
assert.equal(auth.status, 302);
const consent = new URL(auth.headers.get("location")!, G);
assert.equal(consent.pathname, "/consent");
const request = consent.searchParams.get("request")!;

const login = await fetch(`${G}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-switchboard": "1" },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
assert.equal(login.status, 200);
const cookie = login.headers.get("set-cookie")!.split(";")[0];
const dash = (path: string, body?: unknown) =>
  fetch(`${G}/api${path}`, {
    method: body ? "POST" : "GET",
    headers: { cookie, "x-switchboard": "1", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

const info = await (await dash(`/oauth/request?request=${encodeURIComponent(request)}`)).json();
assert.equal(info.clientName, "Switchboard OAuth e2e");
const decision = await (await dash("/oauth/decision", { request, approve: true })).json();
const callback = new URL(decision.redirectTo);
assert.equal(`${callback.origin}${callback.pathname}`, provider.redirectUrl);
assert.equal(callback.searchParams.get("state"), provider.authUrl!.searchParams.get("state"));
const code = callback.searchParams.get("code")!;
step("authorize -> sign in -> consent -> code returned to the app's redirect URI with state");

// 3. Code -> tokens (SDK does the PKCE verifier exchange).
await first.finishAuth(code);
assert.ok(provider.saved?.access_token.startsWith("sbo_"));
assert.ok(provider.saved?.refresh_token);
step("code + PKCE verifier exchanged for an access + refresh token");

// The code is single-use.
const replay = await fetch(`${G}/oauth/token`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: provider.verifier, client_id: provider.info!.client_id, redirect_uri: provider.redirectUrl }),
});
assert.equal(replay.status, 400);
step("authorization code cannot be used twice");

// 4. Use it: the same tools an API key would see, as the same user.
const client = new Client({ name: "e2e", version: "1" });
await client.connect(new StreamableHTTPClientTransport(mcpUrl, { authProvider: provider }));
const tools = await client.listTools();
assert.ok(tools.tools.some((t) => t.name === "notes__list_notes"));
const res = await client.callTool({ name: "notes__list_notes", arguments: {} });
assert.ok(!res.isError);
await client.close();
step(`connected with the access token: ${tools.tools.length} tools, notes__list_notes call OK`);

// 5. Refresh rotates; replaying the old refresh token revokes the grant.
const oldRefresh = provider.saved!.refresh_token!;
const refreshed = await (
  await fetch(`${G}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: oldRefresh, client_id: provider.info!.client_id }),
  })
).json();
assert.ok(refreshed.access_token && refreshed.refresh_token !== oldRefresh);
step("refresh token rotates");

const reuse = await fetch(`${G}/oauth/token`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: oldRefresh, client_id: provider.info!.client_id }),
});
assert.equal(reuse.status, 400);
const after = await fetch(mcpUrl, {
  method: "POST",
  headers: { authorization: `Bearer ${refreshed.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
});
assert.equal(after.status, 401);
assert.match(after.headers.get("www-authenticate") ?? "", /resource_metadata=/);
step("replaying a rotated refresh token revokes the whole grant (new access token now 401)");

// 6. Audit attributes OAuth calls to the user and the app.
const audit = await (await dash("/audit?limit=20")).json();
assert.ok(audit.some((r: any) => r.via === "oauth" && r.client === "app: Switchboard OAuth e2e" && r.tool_name === "list_notes"));
step("audit log shows the call as OAuth, attributed to the user and the app");

console.log(`\noauth e2e: ${passed} passed`);
