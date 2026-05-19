// integration: POST /payments/remind
//
// Tests call handleRemind() directly. Network calls to Supabase Auth,
// PostgREST, and the Meta WhatsApp API are intercepted via globalThis.fetch
// stubs. No real Supabase instance is needed.
//
// Test names follow the "unit:" / "integration:" prefix convention.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

// Set required env vars before importing the handler.
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_ANON_KEY", "test-anon-key");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
Deno.env.set("META_WHATSAPP_TOKEN", "test-token");
Deno.env.set("META_WHATSAPP_PHONE_ID", "test-phone-id");

import { handleRemind } from "./index.ts";

// ─── Fixtures ─────────────────────────────────────────────────────────────

const MOCK_USER_ID = "user-uuid-landlord";
const MOCK_USER = {
  id: MOCK_USER_ID,
  email: "landlord@example.com",
  user_metadata: {},
};
const MOCK_TENANT_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const MOCK_TENANT = {
  id: MOCK_TENANT_ID,
  name: "João Silva",
  whatsapp: "+5511999999999",
};
const MOCK_TENANT_NO_WHATSAPP = {
  id: MOCK_TENANT_ID,
  name: "Maria Souza",
  whatsapp: null,
};

// ─── Fetch stub builder ──────────────────────────────────────────────────

type MockFetchOpts = {
  authUser?: typeof MOCK_USER | null;
  tenant?: typeof MOCK_TENANT | typeof MOCK_TENANT_NO_WHATSAPP | null;
  tenantQueryFail?: boolean;
  whatsappOk?: boolean;
  whatsappStatus?: number;
  reminderInsertFail?: boolean;
};

function buildMockFetch(opts: MockFetchOpts = {}) {
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

    // PostgREST: tenants
    if (url.includes("/rest/v1/tenants")) {
      if (method === "GET") {
        if (opts.tenantQueryFail) {
          return new Response(
            JSON.stringify({ message: "db error", code: "PGRST000" }),
            { status: 500 },
          );
        }
        if (opts.tenant === null) {
          return new Response(JSON.stringify(null), { status: 200 });
        }
        const data = opts.tenant ?? MOCK_TENANT;
        return new Response(JSON.stringify(data), { status: 200 });
      }
    }

    // PostgREST: payment_reminders
    if (url.includes("/rest/v1/payment_reminders")) {
      if (method === "POST") {
        if (opts.reminderInsertFail) {
          return new Response(
            JSON.stringify({ message: "db error", code: "PGRST000" }),
            { status: 500 },
          );
        }
        return new Response(JSON.stringify([{ id: "reminder-uuid-1" }]), {
          status: 201,
        });
      }
    }

    // Meta WhatsApp API
    if (url.includes("graph.facebook.com")) {
      const status = opts.whatsappStatus ??
        (opts.whatsappOk === false ? 500 : 200);
      return new Response(
        JSON.stringify({ messages: [{ id: "wamid.test" }] }),
        { status },
      );
    }

    throw new Error(`Unexpected fetch in test: ${method} ${url}`);
  };

  return mockFetch;
}

// ─── Request helpers ──────────────────────────────────────────────────────

function makePostRequest(body?: unknown, jwt?: string): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (jwt) headers["Authorization"] = `Bearer ${jwt}`;
  return new Request("http://localhost/payments/remind", {
    method: "POST",
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

Deno.test("integration: remind OPTIONS — returns 200 with CORS headers", async () => {
  const res = await handleRemind(
    new Request("http://localhost/payments/remind", { method: "OPTIONS" }),
  );
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("Access-Control-Allow-Origin") !== null, true);
});

// ═══════════════════════════════════════════════════════════════════════════
// 200 — happy path
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("integration: POST /payments/remind — 200 when WhatsApp send succeeds", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ whatsappOk: true }) as typeof fetch;
  try {
    const res = await handleRemind(
      makePostRequest(
        { tenant_id: MOCK_TENANT_ID, reference_month: "2026-05" },
        "valid.jwt",
      ),
    );
    assertEquals(res.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("integration: POST /payments/remind — 200 accepts YYYY-MM-DD reference_month", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ whatsappOk: true }) as typeof fetch;
  try {
    const res = await handleRemind(
      makePostRequest(
        { tenant_id: MOCK_TENANT_ID, reference_month: "2026-05-01" },
        "valid.jwt",
      ),
    );
    assertEquals(res.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("integration: POST /payments/remind — success response includes CORS headers", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ whatsappOk: true }) as typeof fetch;
  try {
    const res = await handleRemind(
      makePostRequest(
        { tenant_id: MOCK_TENANT_ID, reference_month: "2026-05" },
        "valid.jwt",
      ),
    );
    assertEquals(res.headers.get("Access-Control-Allow-Origin") !== null, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 422 — WhatsApp send failure (non-500, reminder still recorded)
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("integration: POST /payments/remind — 422 (not 500) when WhatsApp send fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ whatsappOk: false }) as typeof fetch;
  try {
    const res = await handleRemind(
      makePostRequest(
        { tenant_id: MOCK_TENANT_ID, reference_month: "2026-05" },
        "valid.jwt",
      ),
    );
    assertEquals(res.status, 422);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals(
      (body.error as Record<string, string>).code,
      "WHATSAPP_SEND_FAILED",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("integration: POST /payments/remind — 422 on invalid_token from WhatsApp API", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ whatsappStatus: 401 }) as typeof fetch;
  try {
    const res = await handleRemind(
      makePostRequest(
        { tenant_id: MOCK_TENANT_ID, reference_month: "2026-05" },
        "valid.jwt",
      ),
    );
    assertEquals(res.status, 422);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals(
      (body.error as Record<string, string>).code,
      "WHATSAPP_SEND_FAILED",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 422 — tenant has no WhatsApp
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("integration: POST /payments/remind — 422 when tenant has no WhatsApp", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({
    tenant: MOCK_TENANT_NO_WHATSAPP,
  }) as typeof fetch;
  try {
    const res = await handleRemind(
      makePostRequest(
        { tenant_id: MOCK_TENANT_ID, reference_month: "2026-05" },
        "valid.jwt",
      ),
    );
    assertEquals(res.status, 422);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals(
      (body.error as Record<string, string>).code,
      "TENANT_WHATSAPP_MISSING",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 404 — tenant not found
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("integration: POST /payments/remind — 404 when tenant not found", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ tenant: null }) as typeof fetch;
  try {
    const res = await handleRemind(
      makePostRequest(
        { tenant_id: MOCK_TENANT_ID, reference_month: "2026-05" },
        "valid.jwt",
      ),
    );
    assertEquals(res.status, 404);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals(
      (body.error as Record<string, string>).code,
      "TENANT_NOT_FOUND",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 500 — DB insert failure for reminder
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("integration: POST /payments/remind — 500 when reminder DB insert fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({
    reminderInsertFail: true,
  }) as typeof fetch;
  try {
    const res = await handleRemind(
      makePostRequest(
        { tenant_id: MOCK_TENANT_ID, reference_month: "2026-05" },
        "valid.jwt",
      ),
    );
    assertEquals(res.status, 500);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals((body.error as Record<string, string>).code, "DB_ERROR");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 401 — auth failures
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("integration: POST /payments/remind — 401 when no JWT provided", async () => {
  const res = await handleRemind(
    makePostRequest({ tenant_id: MOCK_TENANT_ID, reference_month: "2026-05" }),
  );
  assertEquals(res.status, 401);
  const body = await jsonBody(res) as Record<string, unknown>;
  assertEquals((body.error as Record<string, string>).code, "UNAUTHORIZED");
});

Deno.test("integration: POST /payments/remind — 401 when JWT is invalid", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ authUser: null }) as typeof fetch;
  try {
    const res = await handleRemind(
      makePostRequest(
        { tenant_id: MOCK_TENANT_ID, reference_month: "2026-05" },
        "bad.jwt",
      ),
    );
    assertEquals(res.status, 401);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals((body.error as Record<string, string>).code, "UNAUTHORIZED");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 400 — input validation
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("integration: POST /payments/remind — 400 when tenant_id is missing", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handleRemind(
      makePostRequest({ reference_month: "2026-05" }, "valid.jwt"),
    );
    assertEquals(res.status, 400);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals(
      (body.error as Record<string, string>).code,
      "INVALID_TENANT_ID",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("integration: POST /payments/remind — 400 when tenant_id is not a UUID", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handleRemind(
      makePostRequest(
        { tenant_id: "not-a-uuid", reference_month: "2026-05" },
        "valid.jwt",
      ),
    );
    assertEquals(res.status, 400);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals(
      (body.error as Record<string, string>).code,
      "INVALID_TENANT_ID",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("integration: POST /payments/remind — 400 when reference_month is missing", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handleRemind(
      makePostRequest({ tenant_id: MOCK_TENANT_ID }, "valid.jwt"),
    );
    assertEquals(res.status, 400);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals(
      (body.error as Record<string, string>).code,
      "INVALID_REFERENCE_MONTH",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("integration: POST /payments/remind — 400 when reference_month format is invalid", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handleRemind(
      makePostRequest(
        { tenant_id: MOCK_TENANT_ID, reference_month: "05-2026" },
        "valid.jwt",
      ),
    );
    assertEquals(res.status, 400);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals(
      (body.error as Record<string, string>).code,
      "INVALID_REFERENCE_MONTH",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("integration: POST /payments/remind — 400 when body is invalid JSON", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handleRemind(
      new Request("http://localhost/payments/remind", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer valid.jwt",
        },
        body: "not json",
      }),
    );
    assertEquals(res.status, 400);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals((body.error as Record<string, string>).code, "INVALID_JSON");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 405 — wrong method
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("integration: POST /payments/remind — 405 when GET is used", async () => {
  const res = await handleRemind(
    new Request("http://localhost/payments/remind", { method: "GET" }),
  );
  assertEquals(res.status, 405);
  const body = await jsonBody(res) as Record<string, unknown>;
  assertEquals(
    (body.error as Record<string, string>).code,
    "METHOD_NOT_ALLOWED",
  );
});
