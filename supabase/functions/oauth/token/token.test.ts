// unit: POST /oauth/token
//
// Proves the handler itself never requires a Bearer JWT — it is a public
// endpoint. Tests call handleOAuthToken() directly (bypassing Kong) and assert
// that missing or absent Authorization headers do NOT produce 401/403.
// External calls (Google token endpoint, Supabase auth) are stubbed via
// globalThis.fetch replacement.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

// Set required env vars BEFORE importing the handler so requireEnv() passes.
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_ANON_KEY", "test-anon-key");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
Deno.env.set("GOOGLE_CLIENT_ID", "test-client-id");
Deno.env.set("GOOGLE_CLIENT_SECRET", "test-client-secret");

import { handleOAuthToken } from "./index.ts";

// ─── Fetch stub ───────────────────────────────────────────────────────────────

// Minimal Google token response needed for authorization_code flow.
const MOCK_GOOGLE_ID_TOKEN = "google.id.token";
const MOCK_ACCESS_TOKEN = "supabase-access-token";
const MOCK_REFRESH_TOKEN = "supabase-refresh-token";

type MockFetchOpts = {
  googleTokenOk?: boolean;
  supabaseSignInOk?: boolean;
};

function buildMockFetch(opts: MockFetchOpts = {}) {
  const {
    googleTokenOk = true,
    supabaseSignInOk = true,
  } = opts;

  return async function mockFetch(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : (input as Request).url;
    const method = (init as RequestInit | undefined)?.method?.toUpperCase() ??
      "GET";

    // Google token endpoint
    if (url.includes("oauth2.googleapis.com/token") && method === "POST") {
      if (!googleTokenOk) {
        return new Response(
          JSON.stringify({ error: "invalid_grant" }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          id_token: MOCK_GOOGLE_ID_TOKEN,
          access_token: "google-access-token",
          token_type: "Bearer",
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Supabase Auth REST — signInWithIdToken
    if (
      url.includes("/auth/v1/token") &&
      url.includes("grant_type=id_token")
    ) {
      if (!supabaseSignInOk) {
        return new Response(
          JSON.stringify({ error: "invalid_id_token" }),
          { status: 422, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          access_token: MOCK_ACCESS_TOKEN,
          refresh_token: MOCK_REFRESH_TOKEN,
          token_type: "Bearer",
          expires_in: 3600,
          user: { id: "user-uuid-123" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Supabase Auth REST — refreshSession
    if (
      url.includes("/auth/v1/token") &&
      url.includes("grant_type=refresh_token")
    ) {
      if (!supabaseSignInOk) {
        return new Response(
          JSON.stringify({ error: "invalid_refresh_token" }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          access_token: MOCK_ACCESS_TOKEN,
          refresh_token: MOCK_REFRESH_TOKEN,
          token_type: "Bearer",
          expires_in: 3600,
          user: { id: "user-uuid-123" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Supabase Admin API — updateUserById (store google_refresh_token)
    if (url.includes("/auth/v1/admin/users/")) {
      return new Response(
        JSON.stringify({ id: "user-uuid-123" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    throw new Error(`Unexpected fetch in test: ${method} ${url}`);
  };
}

// ─── Request helpers ──────────────────────────────────────────────────────────

function makeTokenRequest(
  body: string,
  headers: Record<string, string> = {},
): Request {
  return new Request("http://localhost/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Unauthenticated access — handler must not reject missing JWT
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("unit: oauth/token — authorization_code: proxies to Google with no Authorization header", async () => {
  // No Authorization header — simulates OpenAI exchanging an auth code for
  // tokens. Must NOT return 401 or 403 — any such response means the handler
  // (or Kong config) is incorrectly requiring authentication on a public endpoint.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: "google-auth-code",
      redirect_uri: "https://example.com/callback",
      client_id: "test-client-id",
      client_secret: "test-client-secret",
    }).toString();

    const req = makeTokenRequest(body);
    const res = await handleOAuthToken(req);

    // The handler should either succeed (200) or fail with a proxied Google
    // error — never with 401/403 that would indicate a JWT check.
    const status = res.status;
    assertEquals(
      status !== 401 && status !== 403,
      true,
      `Expected non-401/403 status for unauthenticated request, got: ${status}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("unit: oauth/token — authorization_code: 200 on successful Google exchange", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: "google-auth-code",
      redirect_uri: "https://example.com/callback",
      client_id: "test-client-id",
      client_secret: "test-client-secret",
    }).toString();

    const req = makeTokenRequest(body);
    const res = await handleOAuthToken(req);
    assertEquals(res.status, 200);
    const json = await res.json() as {
      access_token: string;
      refresh_token: string;
      token_type: string;
    };
    assertEquals(json.access_token, MOCK_ACCESS_TOKEN);
    assertEquals(json.refresh_token, MOCK_REFRESH_TOKEN);
    assertEquals(json.token_type, "Bearer");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("unit: oauth/token — refresh_token: proxies to Supabase with no Authorization header", async () => {
  // No Authorization header — simulates OpenAI refreshing an access token.
  // Must NOT return 401 or 403.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: "supabase-refresh-token",
    }).toString();

    const req = makeTokenRequest(body);
    const res = await handleOAuthToken(req);

    const status = res.status;
    assertEquals(
      status !== 401 && status !== 403,
      true,
      `Expected non-401/403 status for unauthenticated refresh request, got: ${status}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("unit: oauth/token — refresh_token: 200 on successful Supabase session refresh", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: "supabase-refresh-token",
    }).toString();

    const req = makeTokenRequest(body);
    const res = await handleOAuthToken(req);
    assertEquals(res.status, 200);
    const json = await res.json() as {
      access_token: string;
      token_type: string;
    };
    assertEquals(json.access_token, MOCK_ACCESS_TOKEN);
    assertEquals(json.token_type, "Bearer");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Validation errors — bad grant_type, missing fields
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("unit: oauth/token — 400 when grant_type is unsupported", async () => {
  const req = makeTokenRequest(
    new URLSearchParams({ grant_type: "client_credentials" }).toString(),
  );
  const res = await handleOAuthToken(req);
  assertEquals(res.status, 400);
  const json = await res.json() as { error: string };
  assertEquals(json.error, "unsupported_grant_type");
});

Deno.test("unit: oauth/token — 400 when refresh_token is missing from refresh flow", async () => {
  const req = makeTokenRequest(
    new URLSearchParams({ grant_type: "refresh_token" }).toString(),
  );
  const res = await handleOAuthToken(req);
  assertEquals(res.status, 400);
  const json = await res.json() as { error: string };
  assertEquals(json.error, "invalid_request");
});

// ═══════════════════════════════════════════════════════════════════════════════
// Method validation
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("unit: oauth/token — 405 when method is GET", async () => {
  const req = new Request("http://localhost/oauth/token", { method: "GET" });
  const res = await handleOAuthToken(req);
  assertEquals(res.status, 405);
});

Deno.test("unit: oauth/token — 405 when method is DELETE", async () => {
  const req = new Request("http://localhost/oauth/token", { method: "DELETE" });
  const res = await handleOAuthToken(req);
  assertEquals(res.status, 405);
});
