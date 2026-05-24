// unit: POST /setup/complete — input rejection tests
//
// These tests call handleSetupComplete() directly. They exercise the JWT
// verification + input validation layers without needing a real Supabase
// instance running, by intercepting the network calls that those layers make.
//
// Test names follow the "unit:" / "integration:" prefix convention.
// These are tagged "integration" because they involve the full handler stack
// (JWT check → body parse → field validation) even though they're synchronous
// and require no external services.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

// Set required env vars before importing the handler so requireEnv() doesn't throw.
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_ANON_KEY", "test-anon-key");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
Deno.env.set("GOOGLE_CLIENT_ID", "test-client-id");
Deno.env.set("GOOGLE_CLIENT_SECRET", "test-client-secret");

import { handleSetupComplete } from "./index.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeRequest(body: unknown, jwt?: string): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (jwt) headers["Authorization"] = `Bearer ${jwt}`;
  return new Request("http://localhost/setup/complete", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function jsonBody(res: Response): Promise<Record<string, unknown>> {
  return await res.json() as Record<string, unknown>;
}

// ─── No JWT ───────────────────────────────────────────────────────────────

Deno.test("unit: /setup/complete — 401 when no JWT provided", async () => {
  const res = await handleSetupComplete(
    new Request("http://localhost/setup/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }),
  );
  assertEquals(res.status, 401);
  const body = await jsonBody(res);
  assertEquals((body.error as Record<string, string>).code, "UNAUTHORIZED");
});

// ─── Invalid JWT ─────────────────────────────────────────────────────────
//
// getAuthenticatedUser calls Supabase Auth. We intercept fetch so it returns
// an error, simulating an invalid/expired token.

Deno.test("unit: /setup/complete — 401 when JWT is invalid", async () => {
  // Intercept calls to Supabase Auth endpoints.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : input.url;
    if (url.includes("/auth/v1/user")) {
      return Promise.resolve(
        new Response(JSON.stringify({ error: "invalid_token" }), {
          status: 401,
        }),
      );
    }
    return originalFetch(input as string);
  };
  try {
    const res = await handleSetupComplete(makeRequest({}, "bad.jwt.token"));
    assertEquals(res.status, 401);
    const body = await jsonBody(res);
    assertEquals((body.error as Record<string, string>).code, "UNAUTHORIZED");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── Input validation (bad Drive ID) ─────────────────────────────────────

Deno.test("unit: /setup/complete — 400 when root_folder_id is invalid", async () => {
  // Mock a valid auth user response so we get past JWT check.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : input.url;
    if (url.includes("/auth/v1/user")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: "user-uuid",
            email: "landlord@example.com",
            user_metadata: {},
            app_metadata: { google_refresh_token: "mock-refresh-token" },
          }),
          { status: 200 },
        ),
      );
    }
    return originalFetch(input as string);
  };
  try {
    const res = await handleSetupComplete(
      makeRequest(
        {
          root_folder_id: "!!bad!!",
          templates_folder_name: "Templates/",
          whatsapp: "+5511999999999",
          autentique_api_key: "a".repeat(32),
          autentique_webhook_secret: "b".repeat(32),
        },
        "valid.jwt.for.test",
      ),
    );
    assertEquals(res.status, 400);
    const body = await jsonBody(res);
    assertEquals(
      (body.error as Record<string, string>).code,
      "INVALID_ROOT_FOLDER",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── Input validation (bad WhatsApp) ─────────────────────────────────────

Deno.test("unit: /setup/complete — 400 when whatsapp is not a Brazilian number", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : input.url;
    if (url.includes("/auth/v1/user")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: "user-uuid",
            email: "landlord@example.com",
            user_metadata: {},
          }),
          { status: 200 },
        ),
      );
    }
    return originalFetch(input as string);
  };
  try {
    const res = await handleSetupComplete(
      makeRequest(
        {
          root_folder_id: "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms",
          templates_folder_name: "Templates/",
          whatsapp: "+14155552671", // US number
          autentique_api_key: "a".repeat(32),
          autentique_webhook_secret: "b".repeat(32),
        },
        "valid.jwt.for.test",
      ),
    );
    assertEquals(res.status, 400);
    const body = await jsonBody(res);
    assertEquals(
      (body.error as Record<string, string>).code,
      "INVALID_WHATSAPP",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── Input validation (empty API key) ────────────────────────────────────

Deno.test("unit: /setup/complete — 400 when autentique_api_key is empty", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : input.url;
    if (url.includes("/auth/v1/user")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: "user-uuid",
            email: "landlord@example.com",
            user_metadata: {},
          }),
          { status: 200 },
        ),
      );
    }
    return originalFetch(input as string);
  };
  try {
    const res = await handleSetupComplete(
      makeRequest(
        {
          root_folder_id: "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms",
          templates_folder_name: "Templates/",
          whatsapp: "+5511999999999",
          autentique_api_key: "",
        },
        "valid.jwt.for.test",
      ),
    );
    assertEquals(res.status, 400);
    const body = await jsonBody(res);
    assertEquals(
      (body.error as Record<string, string>).code,
      "MISSING_AUTENTIQUE_KEY",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── Input validation (API key with injection chars) ─────────────────────

Deno.test("unit: /setup/complete — 400 when autentique_api_key contains newline", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : input.url;
    if (url.includes("/auth/v1/user")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: "user-uuid",
            email: "landlord@example.com",
            user_metadata: {},
          }),
          { status: 200 },
        ),
      );
    }
    return originalFetch(input as string);
  };
  try {
    const res = await handleSetupComplete(
      makeRequest(
        {
          root_folder_id: "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms",
          templates_folder_name: "Templates/",
          whatsapp: "+5511999999999",
          autentique_api_key: "valid-looking-key\nX-Injected: evil",
        },
        "valid.jwt.for.test",
      ),
    );
    assertEquals(res.status, 400);
    const body = await jsonBody(res);
    assertEquals(
      (body.error as Record<string, string>).code,
      "MISSING_AUTENTIQUE_KEY",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── Input validation (missing webhook secret) ──────────────────────────

Deno.test("unit: /setup/complete — 400 when autentique_webhook_secret is missing", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : input.url;
    if (url.includes("/auth/v1/user")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: "user-uuid",
            email: "landlord@example.com",
            user_metadata: {},
          }),
          { status: 200 },
        ),
      );
    }
    return originalFetch(input as string);
  };
  try {
    const res = await handleSetupComplete(
      makeRequest(
        {
          root_folder_id: "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms",
          templates_folder_name: "Templates/",
          whatsapp: "+5511999999999",
          autentique_api_key: "a".repeat(32),
          // autentique_webhook_secret intentionally omitted
        },
        "valid.jwt.for.test",
      ),
    );
    assertEquals(res.status, 400);
    const body = await jsonBody(res);
    assertEquals(
      (body.error as Record<string, string>).code,
      "MISSING_AUTENTIQUE_WEBHOOK_SECRET",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("unit: /setup/complete — 400 when autentique_webhook_secret contains newline", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : input.url;
    if (url.includes("/auth/v1/user")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: "user-uuid",
            email: "landlord@example.com",
            user_metadata: {},
          }),
          { status: 200 },
        ),
      );
    }
    return originalFetch(input as string);
  };
  try {
    const res = await handleSetupComplete(
      makeRequest(
        {
          root_folder_id: "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms",
          templates_folder_name: "Templates/",
          whatsapp: "+5511999999999",
          autentique_api_key: "a".repeat(32),
          autentique_webhook_secret: "valid-looking-secret\r\nX-Injected: evil",
        },
        "valid.jwt.for.test",
      ),
    );
    assertEquals(res.status, 400);
    const body = await jsonBody(res);
    assertEquals(
      (body.error as Record<string, string>).code,
      "MISSING_AUTENTIQUE_WEBHOOK_SECRET",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── CORS headers on error responses ─────────────────────────────────────

Deno.test("unit: /setup/complete — error response carries CORS headers", async () => {
  const res = await handleSetupComplete(
    new Request("http://localhost/setup/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }),
  );
  // The Access-Control-Allow-Origin header must be present (even wildcard for
  // local dev where SUPABASE_URL is set to localhost).
  const origin = res.headers.get("Access-Control-Allow-Origin");
  assertEquals(origin !== null, true);
});
