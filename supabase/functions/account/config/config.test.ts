// integration: PATCH /account/config
//
// Tests call handleAccountConfig() directly. Network calls to Supabase Auth
// and PostgREST are intercepted via globalThis.fetch stubs.
// No real Supabase instance is needed.
//
// Test naming follows the ci.sh filter: "unit|integration".

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

// Set required env vars before importing the handler so requireEnv() doesn't throw.
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_ANON_KEY", "test-anon-key");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");

import { handleAccountConfig } from "./index.ts";

// ─── Fixtures ─────────────────────────────────────────────────────────────

const MOCK_USER_ID = "user-uuid-landlord";

const MOCK_USER = {
  id: MOCK_USER_ID,
  email: "landlord@example.com",
  user_metadata: {},
};

// ─── Fetch stub builder ──────────────────────────────────────────────────

type MockFetchOpts = {
  authUser?: typeof MOCK_USER | null;
  updateFail?: boolean;
};

function buildMockFetch(opts: MockFetchOpts) {
  const mockFetch = async function (
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

    // Supabase Auth — getUser
    if (url.includes("/auth/v1/user")) {
      if (opts.authUser === null) {
        return new Response(JSON.stringify({ error: "invalid_token" }), {
          status: 401,
        });
      }
      return new Response(JSON.stringify(opts.authUser ?? MOCK_USER), {
        status: 200,
      });
    }

    // PostgREST: landlords PATCH
    if (url.includes("/rest/v1/landlords") && method === "PATCH") {
      if (opts.updateFail) {
        return new Response(
          JSON.stringify({ message: "db error", code: "PGRST000" }),
          { status: 500 },
        );
      }
      // 204 No Content — must have null body (status 204 cannot have a body).
      return new Response(null, { status: 204 });
    }

    throw new Error(`Unexpected fetch in test: ${method} ${url}`);
  };

  return mockFetch;
}

// ─── Request helpers ──────────────────────────────────────────────────────

function makePatchRequest(body?: unknown, jwt?: string): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (jwt) headers["Authorization"] = `Bearer ${jwt}`;
  return new Request("http://localhost/account/config", {
    method: "PATCH",
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function jsonBody(res: Response): Promise<unknown> {
  return await res.json();
}

// ═══════════════════════════════════════════════════════════════════════════
// OPTIONS / CORS
// ═══════════════════════════════════════════════════════════════════════════

Deno.test(
  "integration: account/config OPTIONS — returns 200 with CORS headers",
  async () => {
    const res = await handleAccountConfig(
      new Request("http://localhost/account/config", { method: "OPTIONS" }),
    );
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Access-Control-Allow-Origin") !== null, true);
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// PATCH /account/config — 200 success cases
// ═══════════════════════════════════════════════════════════════════════════

Deno.test(
  "integration: PATCH /account/config — 200 sets frequency to 'daily'",
  async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = buildMockFetch({}) as typeof fetch;
    try {
      const res = await handleAccountConfig(
        makePatchRequest(
          { payment_reminder_frequency: "daily" },
          "valid.jwt",
        ),
      );
      assertEquals(res.status, 200);
      const body = await jsonBody(res) as Record<string, unknown>;
      assertEquals(body.payment_reminder_frequency, "daily");
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

Deno.test(
  "integration: PATCH /account/config — 200 sets frequency to 'weekly'",
  async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = buildMockFetch({}) as typeof fetch;
    try {
      const res = await handleAccountConfig(
        makePatchRequest(
          { payment_reminder_frequency: "weekly" },
          "valid.jwt",
        ),
      );
      assertEquals(res.status, 200);
      const body = await jsonBody(res) as Record<string, unknown>;
      assertEquals(body.payment_reminder_frequency, "weekly");
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

Deno.test(
  "integration: PATCH /account/config — 200 sets frequency to 'disabled'",
  async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = buildMockFetch({}) as typeof fetch;
    try {
      const res = await handleAccountConfig(
        makePatchRequest(
          { payment_reminder_frequency: "disabled" },
          "valid.jwt",
        ),
      );
      assertEquals(res.status, 200);
      const body = await jsonBody(res) as Record<string, unknown>;
      assertEquals(body.payment_reminder_frequency, "disabled");
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

Deno.test(
  "integration: PATCH /account/config — 200 response includes CORS headers",
  async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = buildMockFetch({}) as typeof fetch;
    try {
      const res = await handleAccountConfig(
        makePatchRequest(
          { payment_reminder_frequency: "weekly" },
          "valid.jwt",
        ),
      );
      assertEquals(
        res.headers.get("Access-Control-Allow-Origin") !== null,
        true,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// PATCH /account/config — 400 validation errors
// ═══════════════════════════════════════════════════════════════════════════

Deno.test(
  "integration: PATCH /account/config — 400 when payment_reminder_frequency is missing",
  async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = buildMockFetch({}) as typeof fetch;
    try {
      const res = await handleAccountConfig(
        makePatchRequest({}, "valid.jwt"),
      );
      assertEquals(res.status, 400);
      const body = await jsonBody(res) as Record<string, unknown>;
      assertEquals(
        (body.error as Record<string, string>).code,
        "INVALID_FREQUENCY",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

Deno.test(
  "integration: PATCH /account/config — 400 when frequency value is invalid",
  async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = buildMockFetch({}) as typeof fetch;
    try {
      const res = await handleAccountConfig(
        makePatchRequest(
          { payment_reminder_frequency: "monthly" },
          "valid.jwt",
        ),
      );
      assertEquals(res.status, 400);
      const body = await jsonBody(res) as Record<string, unknown>;
      assertEquals(
        (body.error as Record<string, string>).code,
        "INVALID_FREQUENCY",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

Deno.test(
  "integration: PATCH /account/config — 400 when frequency is a number instead of string",
  async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = buildMockFetch({}) as typeof fetch;
    try {
      const res = await handleAccountConfig(
        makePatchRequest(
          { payment_reminder_frequency: 1 },
          "valid.jwt",
        ),
      );
      assertEquals(res.status, 400);
      const body = await jsonBody(res) as Record<string, unknown>;
      assertEquals(
        (body.error as Record<string, string>).code,
        "INVALID_FREQUENCY",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

Deno.test(
  "integration: PATCH /account/config — 400 when body is invalid JSON",
  async () => {
    // Auth is verified before body parsing, so we need a valid user mock.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = buildMockFetch({}) as typeof fetch;
    try {
      const res = await handleAccountConfig(
        new Request("http://localhost/account/config", {
          method: "PATCH",
          headers: {
            "Authorization": "Bearer valid.jwt",
            "Content-Type": "application/json",
          },
          body: "not-json",
        }),
      );
      assertEquals(res.status, 400);
      const body = await jsonBody(res) as Record<string, unknown>;
      assertEquals(
        (body.error as Record<string, string>).code,
        "INVALID_JSON",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// PATCH /account/config — 401 auth errors
// ═══════════════════════════════════════════════════════════════════════════

Deno.test(
  "integration: PATCH /account/config — 401 when no JWT provided",
  async () => {
    const res = await handleAccountConfig(
      makePatchRequest({ payment_reminder_frequency: "daily" }),
    );
    assertEquals(res.status, 401);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals(
      (body.error as Record<string, string>).code,
      "UNAUTHORIZED",
    );
  },
);

Deno.test(
  "integration: PATCH /account/config — 401 when JWT is invalid or expired",
  async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = buildMockFetch({ authUser: null }) as typeof fetch;
    try {
      const res = await handleAccountConfig(
        makePatchRequest(
          { payment_reminder_frequency: "daily" },
          "expired.jwt",
        ),
      );
      assertEquals(res.status, 401);
      const body = await jsonBody(res) as Record<string, unknown>;
      assertEquals(
        (body.error as Record<string, string>).code,
        "UNAUTHORIZED",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// PATCH /account/config — 500 DB error
// ═══════════════════════════════════════════════════════════════════════════

Deno.test(
  "integration: PATCH /account/config — 500 when DB update fails",
  async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = buildMockFetch({ updateFail: true }) as typeof fetch;
    try {
      const res = await handleAccountConfig(
        makePatchRequest(
          { payment_reminder_frequency: "weekly" },
          "valid.jwt",
        ),
      );
      assertEquals(res.status, 500);
      const body = await jsonBody(res) as Record<string, unknown>;
      assertEquals(
        (body.error as Record<string, string>).code,
        "DB_ERROR",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// Method not allowed
// ═══════════════════════════════════════════════════════════════════════════

Deno.test(
  "integration: account/config — 405 when GET is used",
  async () => {
    const res = await handleAccountConfig(
      new Request("http://localhost/account/config", {
        method: "GET",
        headers: { "Authorization": "Bearer valid.jwt" },
      }),
    );
    assertEquals(res.status, 405);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals(
      (body.error as Record<string, string>).code,
      "METHOD_NOT_ALLOWED",
    );
  },
);

Deno.test(
  "integration: account/config — 405 when POST is used",
  async () => {
    const res = await handleAccountConfig(
      new Request("http://localhost/account/config", {
        method: "POST",
        headers: {
          "Authorization": "Bearer valid.jwt",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ payment_reminder_frequency: "daily" }),
      }),
    );
    assertEquals(res.status, 405);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals(
      (body.error as Record<string, string>).code,
      "METHOD_NOT_ALLOWED",
    );
  },
);
