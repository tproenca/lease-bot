// integration: OAuth integrated setup flow — issue #89
//
// Tests the new-landlord and existing-landlord paths for the ChatGPT-embedded
// onboarding flow. The handler functions are called directly; external calls
// (Google OAuth, Supabase Auth signInWithIdToken) are stubbed via
// globalThis.fetch, while real Supabase DB operations (landlords table,
// oauth_codes table, auth.admin) go to the local instance.
//
// Prerequisites: `supabase start` must be running.
// Test names follow the "integration:" prefix convention.

import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createClient } from "@supabase/supabase-js";

// ─── Local Supabase configuration ────────────────────────────────────────────

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRFA0NiK7W9oaLFwQ1egSTumqSwalckNOm0NqZouAKc";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hj04zWl196z2-SBc0";

// ─── Availability check ───────────────────────────────────────────────────────

let supabaseAvailable = false;
try {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/`, {
    headers: { apikey: ANON_KEY },
    signal: AbortSignal.timeout(2000),
  });
  supabaseAvailable = r.status < 500;
} catch {
  supabaseAvailable = false;
}

function skipIfUnavailable(): boolean {
  if (!supabaseAvailable) {
    console.log(
      "  [SKIP] local Supabase not running — skipping integration test",
    );
    return true;
  }
  return false;
}

// ─── Environment setup ────────────────────────────────────────────────────────

Deno.env.set("SUPABASE_URL", SUPABASE_URL);
Deno.env.set("SUPABASE_ANON_KEY", ANON_KEY);
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);
Deno.env.set("GOOGLE_CLIENT_ID", "test-google-client-id");
Deno.env.set("GOOGLE_CLIENT_SECRET", "test-google-client-secret");
Deno.env.set(
  "PUBLIC_FUNCTIONS_BASE_URL",
  `${SUPABASE_URL}/functions/v1`,
);

import { handleAuthCallback } from "../auth/callback/index.ts";
import { handleOAuthToken } from "./token/index.ts";

// ─── Admin client (service role, bypasses RLS) ────────────────────────────────

// Admin client available for test setup/teardown if needed in future tests.
const _adminDb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ─── Test constants ───────────────────────────────────────────────────────────

const CHATGPT_REDIRECT_URI = "https://chat.openai.com/aip/test-callback";
const CHATGPT_STATE = "openai-state-integration-test";
const MOCK_ACCESS_TOKEN = "mock-supabase-access-token-integration";
const MOCK_REFRESH_TOKEN = "mock-supabase-refresh-token-integration";
const MOCK_USER_ID = "00000000-0000-0000-0000-000000000099";
const MOCK_USER_EMAIL = "integration-test@example.com";
const MOCK_GOOGLE_ID_TOKEN = "mock.google.id.token";

// ─── Fetch stub helpers ───────────────────────────────────────────────────────

/**
 * Build a fetch stub that handles Google and Supabase Auth calls while
 * forwarding real Supabase DB/REST calls to the local stack.
 */
function buildAuthCallbackFetchStub(opts: {
  landlordExists: boolean;
}): typeof fetch {
  const realFetch = globalThis.fetch;
  return async function (
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

    // Google token exchange: return id_token + refresh_token.
    if (url.includes("oauth2.googleapis.com/token") && method === "POST") {
      return new Response(
        JSON.stringify({
          id_token: MOCK_GOOGLE_ID_TOKEN,
          access_token: "google-access-token",
          refresh_token: "google-refresh-token",
          token_type: "Bearer",
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Supabase Auth: signInWithIdToken — return a mock session.
    if (url.includes("/auth/v1/token") && url.includes("grant_type=id_token")) {
      return new Response(
        JSON.stringify({
          access_token: MOCK_ACCESS_TOKEN,
          refresh_token: MOCK_REFRESH_TOKEN,
          token_type: "Bearer",
          expires_in: 3600,
          user: {
            id: MOCK_USER_ID,
            email: MOCK_USER_EMAIL,
            user_metadata: { full_name: "Integration Test User" },
            app_metadata: {},
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Supabase Auth Admin: updateUserById (store google_refresh_token).
    if (url.includes("/auth/v1/admin/users/") && method === "PUT") {
      return new Response(
        JSON.stringify({ id: MOCK_USER_ID }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Supabase Auth: getUser (verifies session JWT).
    if (url.includes("/auth/v1/user") && method === "GET") {
      return new Response(
        JSON.stringify({
          id: MOCK_USER_ID,
          email: MOCK_USER_EMAIL,
          user_metadata: { full_name: "Integration Test User" },
          app_metadata: { google_refresh_token: "google-refresh-token" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // landlords table: check if landlord exists (SELECT by id).
    if (
      url.includes("/rest/v1/landlords") &&
      url.includes(MOCK_USER_ID) &&
      method === "GET"
    ) {
      if (opts.landlordExists) {
        return new Response(
          JSON.stringify({ id: MOCK_USER_ID }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        "null",
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // oauth_codes table: INSERT (issueOAuthCode).
    if (url.includes("/rest/v1/oauth_codes") && method === "POST") {
      return new Response(null, { status: 201 });
    }

    // oauth_codes table: SELECT (redeemOAuthCode lookup).
    if (url.includes("/rest/v1/oauth_codes") && method === "GET") {
      // Return the row so the token endpoint can redeem it.
      return new Response(
        JSON.stringify([{
          access_token: MOCK_ACCESS_TOKEN,
          refresh_token: MOCK_REFRESH_TOKEN,
          expires_at: new Date(Date.now() + 300_000).toISOString(),
        }]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // oauth_codes table: DELETE (single-use deletion).
    if (url.includes("/rest/v1/oauth_codes") && method === "DELETE") {
      return new Response(null, { status: 204 });
    }

    // Forward all other calls to the real local Supabase stack.
    return realFetch(input, init);
  } as typeof fetch;
}

// ─── Cookie builders ──────────────────────────────────────────────────────────

function buildChatgptRedirectCookie(): string {
  const value = encodeURIComponent(
    JSON.stringify({
      redirect_uri: CHATGPT_REDIRECT_URI,
      state: CHATGPT_STATE,
    }),
  );
  return `chatgpt_redirect=${value}; oauth_state=expected-state`;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

Deno.test(
  "integration: /auth/callback — existing landlord → issues one-time code and redirects to ChatGPT without showing setup form",
  async () => {
    if (skipIfUnavailable()) return;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = buildAuthCallbackFetchStub({ landlordExists: true });

    try {
      const req = new Request(
        `${SUPABASE_URL}/functions/v1/auth/callback?code=google-auth-code&state=expected-state`,
        {
          method: "GET",
          headers: {
            Cookie: buildChatgptRedirectCookie(),
          },
        },
      );

      const res = await handleAuthCallback(req);

      // Should redirect directly to ChatGPT — not to /setup.
      assertEquals(res.status, 302);
      const location = res.headers.get("Location") ?? "";
      assertStringIncludes(
        location,
        "chat.openai.com",
        "Expected redirect to ChatGPT callback URL",
      );
      assertStringIncludes(
        location,
        "code=",
        "Expected one-time code in ChatGPT callback URL",
      );
      assertStringIncludes(
        location,
        `state=${CHATGPT_STATE}`,
        "Expected OpenAI state in ChatGPT callback URL",
      );
      // Must NOT redirect to /setup.
      assertEquals(
        location.includes("/setup"),
        false,
        "Must not redirect to /setup for existing landlord",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

Deno.test(
  "integration: /auth/callback — new landlord → sets session cookie and redirects to /setup?via=oauth",
  async () => {
    if (skipIfUnavailable()) return;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = buildAuthCallbackFetchStub({ landlordExists: false });

    try {
      const req = new Request(
        `${SUPABASE_URL}/functions/v1/auth/callback?code=google-auth-code&state=expected-state`,
        {
          method: "GET",
          headers: {
            Cookie: buildChatgptRedirectCookie(),
          },
        },
      );

      const res = await handleAuthCallback(req);

      // Should redirect to /setup?via=oauth to show the form in the OAuth window.
      assertEquals(res.status, 302);
      const location = res.headers.get("Location") ?? "";
      assertStringIncludes(location, "/setup");
      assertStringIncludes(location, "via=oauth");

      // Must set the session cookie so /setup can render the form.
      const cookies = res.headers.getSetCookie?.() ??
        [res.headers.get("Set-Cookie") ?? ""];
      const sessionCookie = cookies.find((c) => c.startsWith("sb_session="));
      assertEquals(
        sessionCookie !== undefined,
        true,
        "Expected sb_session cookie to be set",
      );

      // Must also set the refresh token cookie for /setup/complete.
      const refreshCookie = cookies.find((c) =>
        c.startsWith("sb_session_refresh=")
      );
      assertEquals(
        refreshCookie !== undefined,
        true,
        "Expected sb_session_refresh cookie to be set",
      );

      // Must NOT redirect to ChatGPT directly.
      assertEquals(
        location.includes("chat.openai.com"),
        false,
        "Must not redirect directly to ChatGPT for new landlord",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

Deno.test(
  "integration: /auth/callback — no ChatGPT cookie → original behaviour, redirects to /setup without via=oauth",
  async () => {
    if (skipIfUnavailable()) return;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = buildAuthCallbackFetchStub({ landlordExists: false });

    try {
      const req = new Request(
        `${SUPABASE_URL}/functions/v1/auth/callback?code=google-auth-code&state=expected-state`,
        {
          method: "GET",
          headers: {
            // No chatgpt_redirect cookie — direct /setup page flow.
            Cookie: "oauth_state=expected-state",
          },
        },
      );

      const res = await handleAuthCallback(req);

      assertEquals(res.status, 302);
      const location = res.headers.get("Location") ?? "";
      assertStringIncludes(location, "/setup");
      assertEquals(
        location.includes("via=oauth"),
        false,
        "Direct flow must not add via=oauth",
      );
      assertEquals(
        location.includes("chat.openai.com"),
        false,
        "Direct flow must not redirect to ChatGPT",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

Deno.test(
  "integration: /oauth/token — redeems one-time code and returns Supabase JWT pair",
  async () => {
    if (skipIfUnavailable()) return;

    const ONE_TIME_CODE = "integration-test-one-time-code";

    const originalFetch = globalThis.fetch;
    globalThis.fetch = buildAuthCallbackFetchStub({
      landlordExists: true,
    });

    try {
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code: ONE_TIME_CODE,
      }).toString();

      const req = new Request(`${SUPABASE_URL}/functions/v1/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });

      const res = await handleOAuthToken(req);

      assertEquals(res.status, 200);
      const json = await res.json() as {
        access_token: string;
        refresh_token: string;
        token_type: string;
        expires_in: number;
      };
      assertEquals(json.access_token, MOCK_ACCESS_TOKEN);
      assertEquals(json.refresh_token, MOCK_REFRESH_TOKEN);
      assertEquals(json.token_type, "Bearer");
      assertEquals(typeof json.expires_in, "number");
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);
