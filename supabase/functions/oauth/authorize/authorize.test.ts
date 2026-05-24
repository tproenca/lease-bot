// unit: GET /oauth/authorize
//
// Proves the handler itself never requires a Bearer JWT — it is a public
// endpoint. Tests call handleOAuthAuthorize() directly (bypassing Kong) and
// assert that missing or absent Authorization headers do NOT produce 401/403.
// Any future change that accidentally adds auth checks (e.g. removing
// `verify_jwt = false` from config.toml) will not be caught here — but these
// tests ensure the handler logic itself is auth-free.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { handleOAuthAuthorize } from "./index.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeGetRequest(
  queryString = "",
  headers: Record<string, string> = {},
): Request {
  const url = queryString
    ? `http://localhost/oauth/authorize?${queryString}`
    : "http://localhost/oauth/authorize";
  return new Request(url, {
    method: "GET",
    headers,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Unauthenticated access — handler must not reject missing JWT
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("unit: oauth/authorize — 302 redirect with no Authorization header", async () => {
  // No Authorization header — simulates OpenAI calling this endpoint before
  // the OAuth flow has started. Must not return 401 or 403.
  const req = makeGetRequest();
  const res = await handleOAuthAuthorize(req);
  assertEquals(res.status, 302);
});

Deno.test("unit: oauth/authorize — Location header points to accounts.google.com", async () => {
  const req = makeGetRequest();
  const res = await handleOAuthAuthorize(req);
  assertEquals(res.status, 302);
  const location = res.headers.get("Location") ?? "";
  assertEquals(
    location.startsWith("https://accounts.google.com/"),
    true,
    `Expected Location to start with https://accounts.google.com/, got: ${location}`,
  );
});

Deno.test("unit: oauth/authorize — 302 redirect even when Authorization header is present", async () => {
  // Confirm the handler does not break when a JWT *is* provided — it should
  // still redirect; it never inspects the JWT.
  const req = makeGetRequest("", {
    Authorization: "Bearer some.jwt.token",
  });
  const res = await handleOAuthAuthorize(req);
  assertEquals(res.status, 302);
});

Deno.test("unit: oauth/authorize — query params are forwarded to Google", async () => {
  const req = makeGetRequest(
    "client_id=test-client&redirect_uri=https%3A%2F%2Fexample.com%2Fcallback&response_type=code&scope=openid+email&state=abc123",
  );
  const res = await handleOAuthAuthorize(req);
  assertEquals(res.status, 302);
  const location = new URL(res.headers.get("Location") ?? "");
  assertEquals(location.searchParams.get("client_id"), "test-client");
  assertEquals(
    location.searchParams.get("redirect_uri"),
    "https://example.com/callback",
  );
  assertEquals(location.searchParams.get("response_type"), "code");
  assertEquals(location.searchParams.get("state"), "abc123");
});

Deno.test("unit: oauth/authorize — access_type=offline is always set", async () => {
  // Handler must always force offline access so Google issues a refresh token.
  const req = makeGetRequest("response_type=code");
  const res = await handleOAuthAuthorize(req);
  assertEquals(res.status, 302);
  const location = new URL(res.headers.get("Location") ?? "");
  assertEquals(location.searchParams.get("access_type"), "offline");
});

Deno.test("unit: oauth/authorize — prompt=consent is always set", async () => {
  const req = makeGetRequest("response_type=code");
  const res = await handleOAuthAuthorize(req);
  assertEquals(res.status, 302);
  const location = new URL(res.headers.get("Location") ?? "");
  assertEquals(location.searchParams.get("prompt"), "consent");
});

// ═══════════════════════════════════════════════════════════════════════════════
// Method validation
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("unit: oauth/authorize — 405 when method is POST", async () => {
  const req = new Request("http://localhost/oauth/authorize", {
    method: "POST",
  });
  const res = await handleOAuthAuthorize(req);
  assertEquals(res.status, 405);
});

Deno.test("unit: oauth/authorize — 405 when method is DELETE", async () => {
  const req = new Request("http://localhost/oauth/authorize", {
    method: "DELETE",
  });
  const res = await handleOAuthAuthorize(req);
  assertEquals(res.status, 405);
});
