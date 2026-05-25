// unit: GET /oauth/authorize
//
// Proves the handler itself never requires a Bearer JWT — it is a public
// endpoint. Tests call handleOAuthAuthorize() directly (bypassing Kong) and
// assert that missing or absent Authorization headers do NOT produce 401/403.
// Any future change that accidentally adds auth checks (e.g. removing
// `verify_jwt = false` from config.toml) will not be caught here — but these
// tests ensure the handler logic itself is auth-free.
//
// Integrated setup flow (issue #89): the handler now replaces the incoming
// redirect_uri with our own /auth/callback and stores ChatGPT's redirect_uri
// in a cookie. Tests below cover both behaviours.

// Set required env vars before importing the handler.
Deno.env.set(
  "PUBLIC_FUNCTIONS_BASE_URL",
  "http://localhost:54321/functions/v1",
);

import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
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
  // redirect_uri is replaced with our own /auth/callback (integrated flow);
  // other params (client_id, response_type, state, scope) are forwarded as-is.
  const req = makeGetRequest(
    "client_id=test-client&redirect_uri=https%3A%2F%2Fexample.com%2Fcallback&response_type=code&scope=openid+email&state=abc123",
  );
  const res = await handleOAuthAuthorize(req);
  assertEquals(res.status, 302);
  const location = new URL(res.headers.get("Location") ?? "");
  assertEquals(location.searchParams.get("client_id"), "test-client");
  // redirect_uri must be our /auth/callback, not the incoming ChatGPT URI.
  assertStringIncludes(
    location.searchParams.get("redirect_uri") ?? "",
    "/auth/callback",
  );
  assertEquals(location.searchParams.get("response_type"), "code");
  assertEquals(location.searchParams.get("state"), "abc123");
});

// ═══════════════════════════════════════════════════════════════════════════════
// Integrated setup flow — ChatGPT redirect_uri cookie (issue #89)
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("unit: oauth/authorize — sets chatgpt_redirect cookie when redirect_uri is present", async () => {
  const req = makeGetRequest(
    "redirect_uri=https%3A%2F%2Fchat.openai.com%2Faip%2Fcallback&state=openai-state-xyz&response_type=code",
  );
  const res = await handleOAuthAuthorize(req);
  assertEquals(res.status, 302);
  // At least one Set-Cookie header must contain our chatgpt_redirect cookie.
  const cookies = res.headers.getSetCookie?.() ??
    [res.headers.get("Set-Cookie") ?? ""];
  const chatgptCookie = cookies.find((c) => c.startsWith("chatgpt_redirect="));
  assertEquals(
    chatgptCookie !== undefined,
    true,
    "Expected chatgpt_redirect cookie to be set",
  );
  assertStringIncludes(chatgptCookie ?? "", "HttpOnly");
  assertStringIncludes(chatgptCookie ?? "", "SameSite=Lax");
});

Deno.test("unit: oauth/authorize — chatgpt_redirect cookie encodes redirect_uri and state", async () => {
  const chatgptUri = "https://chat.openai.com/aip/callback";
  const openaiState = "openai-state-abc";
  const req = makeGetRequest(
    `redirect_uri=${
      encodeURIComponent(chatgptUri)
    }&state=${openaiState}&response_type=code`,
  );
  const res = await handleOAuthAuthorize(req);
  const cookies = res.headers.getSetCookie?.() ??
    [res.headers.get("Set-Cookie") ?? ""];
  const chatgptCookie = cookies.find((c) => c.startsWith("chatgpt_redirect="));
  const rawValue = (chatgptCookie ?? "").split(";")[0].split("=").slice(1)
    .join("=");
  const decoded = JSON.parse(decodeURIComponent(rawValue));
  assertEquals(decoded.redirect_uri, chatgptUri);
  assertEquals(decoded.state, openaiState);
});

Deno.test("unit: oauth/authorize — does not set chatgpt_redirect cookie when no redirect_uri", async () => {
  // Direct /setup page flow: user clicks "Entrar com Google" — no redirect_uri
  // query param means we are not inside a ChatGPT OAuth window.
  const req = makeGetRequest("response_type=code&state=some-state");
  const res = await handleOAuthAuthorize(req);
  assertEquals(res.status, 302);
  const cookies = res.headers.getSetCookie?.() ??
    [res.headers.get("Set-Cookie") ?? ""];
  const chatgptCookie = cookies.find((c) => c.startsWith("chatgpt_redirect="));
  assertEquals(
    chatgptCookie,
    undefined,
    "Expected no chatgpt_redirect cookie when redirect_uri is absent",
  );
});

Deno.test("unit: oauth/authorize — redirect_uri sent to Google is our /auth/callback, not ChatGPT URI", async () => {
  const chatgptUri = "https://chat.openai.com/aip/callback";
  const req = makeGetRequest(
    `redirect_uri=${encodeURIComponent(chatgptUri)}&response_type=code`,
  );
  const res = await handleOAuthAuthorize(req);
  const location = new URL(res.headers.get("Location") ?? "");
  const sentRedirectUri = location.searchParams.get("redirect_uri") ?? "";
  // Must NOT be the ChatGPT URI — must be our callback.
  assertEquals(
    sentRedirectUri.includes("chat.openai.com"),
    false,
    "ChatGPT redirect_uri must not be forwarded to Google",
  );
  assertStringIncludes(sentRedirectUri, "/auth/callback");
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
// CSRF state cookie (oauth_state)
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("unit: oauth/authorize — sets oauth_state cookie when state param is present", async () => {
  const req = makeGetRequest(
    "redirect_uri=https%3A%2F%2Fchat.openai.com%2Faip%2Fcallback&state=csrf-nonce-123&response_type=code",
  );
  const res = await handleOAuthAuthorize(req);
  assertEquals(res.status, 302);
  const cookies = res.headers.getSetCookie?.() ??
    [res.headers.get("Set-Cookie") ?? ""];
  const stateCookie = cookies.find((c) => c.startsWith("oauth_state="));
  assertEquals(
    stateCookie !== undefined,
    true,
    "Expected oauth_state cookie to be set",
  );
  assertStringIncludes(stateCookie ?? "", "csrf-nonce-123");
  assertStringIncludes(stateCookie ?? "", "HttpOnly");
  assertStringIncludes(stateCookie ?? "", "SameSite=Lax");
});

Deno.test("unit: oauth/authorize — oauth_state cookie value matches state param", async () => {
  const state = "my-csrf-state-abc";
  const req = makeGetRequest(`state=${state}&response_type=code`);
  const res = await handleOAuthAuthorize(req);
  const cookies = res.headers.getSetCookie?.() ??
    [res.headers.get("Set-Cookie") ?? ""];
  const stateCookie = cookies.find((c) => c.startsWith("oauth_state="));
  const cookieValue = (stateCookie ?? "").split(";")[0].split("=").slice(1)
    .join("=");
  assertEquals(cookieValue, state);
});

Deno.test("unit: oauth/authorize — does not set oauth_state cookie when no state param", async () => {
  const req = makeGetRequest("response_type=code");
  const res = await handleOAuthAuthorize(req);
  const cookies = res.headers.getSetCookie?.() ??
    [res.headers.get("Set-Cookie") ?? ""];
  const stateCookie = cookies.find((c) => c.startsWith("oauth_state="));
  assertEquals(
    stateCookie,
    undefined,
    "Expected no oauth_state cookie when state param is absent",
  );
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
