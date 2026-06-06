// unit: POST /payments + GET /payments?month=YYYY-MM
//
// Tests call handlePayments() directly. Network calls to Supabase Auth and
// PostgREST are intercepted via globalThis.fetch stubs.
// No real Supabase instance is needed.
//
// Test names follow the "unit:" / "integration:" prefix convention.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

// Set required env vars before importing the handler so requireEnv() doesn't throw.
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_ANON_KEY", "test-anon-key");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");

import { handlePayments } from "./index.ts";

// ─── Fixtures ─────────────────────────────────────────────────────────────

const MOCK_USER_ID = "user-uuid-landlord";

const MOCK_USER = {
  id: MOCK_USER_ID,
  email: "landlord@example.com",
  user_metadata: {},
};

const MOCK_TENANT_ID = "tenant-uuid-1";
const MOCK_TENANT_ID_2 = "tenant-uuid-2";
const MOCK_TENANT_ID_3 = "tenant-uuid-3";

const MOCK_PAYMENT_ID = "payment-uuid-1";

// Payments for GET /payments tests
const MOCK_PAYMENTS = [
  {
    id: MOCK_PAYMENT_ID,
    tenant_id: MOCK_TENANT_ID,
    amount: 1500.0,
    paid_at: "2026-05-03T12:00:00Z",
    on_time: true,
    tenants: { name: "João Silva" },
  },
];

// Active properties/tenants for overdue calculation (uses current_tenant_id FK — ADR-0019)
const MOCK_PROPERTIES = [
  { current_tenant_id: MOCK_TENANT_ID },
  { current_tenant_id: MOCK_TENANT_ID_2 },
  { current_tenant_id: MOCK_TENANT_ID_3 },
];

const MOCK_ACTIVE_TENANTS = [
  { id: MOCK_TENANT_ID, name: "João Silva" },
  { id: MOCK_TENANT_ID_2, name: "Maria Souza" },
  { id: MOCK_TENANT_ID_3, name: "Carlos Lima" },
];

const MOCK_REMINDERS = [
  { tenant_id: MOCK_TENANT_ID_2, sent_at: "2026-05-10T09:00:00Z" },
  { tenant_id: MOCK_TENANT_ID_2, sent_at: "2026-05-08T09:00:00Z" }, // older
];

// ─── Fetch stub builder ──────────────────────────────────────────────────

type MockFetchOpts = {
  authUser?: typeof MOCK_USER | null;
  paymentInsert?: { id: string } | null;
  dbInsertFail?: boolean;
  payments?: typeof MOCK_PAYMENTS | null;
  properties?: typeof MOCK_PROPERTIES | null;
  activeTenants?: typeof MOCK_ACTIVE_TENANTS | null;
  reminders?: typeof MOCK_REMINDERS | null;
  paymentsQueryFail?: boolean;
  propertiesQueryFail?: boolean;
  tenantsQueryFail?: boolean;
  remindersQueryFail?: boolean;
};

function buildMockFetch(opts: MockFetchOpts) {
  // Track which POST/GET calls have been made to distinguish payments insert vs query
  let paymentsPostCount = 0;
  let propertiesGetCount = 0;
  let tenantsGetCount = 0;
  let remindersGetCount = 0;

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

    // PostgREST: payments
    if (url.includes("/rest/v1/payments")) {
      if (method === "POST") {
        paymentsPostCount++;
        if (opts.dbInsertFail) {
          return new Response(
            JSON.stringify({ message: "db error", code: "PGRST000" }),
            { status: 500 },
          );
        }
        if (opts.paymentInsert === null) {
          return new Response(JSON.stringify(null), { status: 500 });
        }
        const insertData = opts.paymentInsert ?? { id: MOCK_PAYMENT_ID };
        return new Response(JSON.stringify(insertData), { status: 201 });
      }
      if (method === "GET") {
        if (opts.paymentsQueryFail) {
          return new Response(
            JSON.stringify({ message: "db error", code: "PGRST000" }),
            { status: 500 },
          );
        }
        const data = opts.payments ?? MOCK_PAYMENTS;
        return new Response(JSON.stringify(data ?? []), { status: 200 });
      }
    }

    // PostgREST: properties
    if (url.includes("/rest/v1/properties")) {
      if (method === "GET") {
        propertiesGetCount++;
        if (opts.propertiesQueryFail) {
          return new Response(
            JSON.stringify({ message: "db error", code: "PGRST000" }),
            { status: 500 },
          );
        }
        const data = opts.properties ?? MOCK_PROPERTIES;
        return new Response(JSON.stringify(data ?? []), { status: 200 });
      }
    }

    // PostgREST: tenants
    if (url.includes("/rest/v1/tenants")) {
      if (method === "GET") {
        tenantsGetCount++;
        if (opts.tenantsQueryFail) {
          return new Response(
            JSON.stringify({ message: "db error", code: "PGRST000" }),
            { status: 500 },
          );
        }
        const data = opts.activeTenants ?? MOCK_ACTIVE_TENANTS;
        return new Response(JSON.stringify(data ?? []), { status: 200 });
      }
    }

    // PostgREST: payment_reminders
    if (url.includes("/rest/v1/payment_reminders")) {
      if (method === "GET") {
        remindersGetCount++;
        if (opts.remindersQueryFail) {
          return new Response(
            JSON.stringify({ message: "db error", code: "PGRST000" }),
            { status: 500 },
          );
        }
        const data = opts.reminders ?? [];
        return new Response(JSON.stringify(data), { status: 200 });
      }
    }

    throw new Error(`Unexpected fetch in test: ${method} ${url}`);
  };

  // Expose call counts for assertions if needed.
  (mockFetch as unknown as Record<string, unknown>)["paymentsPostCount"] = () =>
    paymentsPostCount;
  (mockFetch as unknown as Record<string, unknown>)["propertiesGetCount"] =
    () => propertiesGetCount;
  (mockFetch as unknown as Record<string, unknown>)["tenantsGetCount"] = () =>
    tenantsGetCount;
  (mockFetch as unknown as Record<string, unknown>)["remindersGetCount"] = () =>
    remindersGetCount;

  return mockFetch;
}

// ─── Request helpers ──────────────────────────────────────────────────────

function makePostRequest(body?: unknown, jwt?: string): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (jwt) headers["Authorization"] = `Bearer ${jwt}`;
  return new Request("http://localhost/payments", {
    method: "POST",
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function makeGetRequest(month?: string, jwt?: string): Request {
  const headers: Record<string, string> = {};
  if (jwt) headers["Authorization"] = `Bearer ${jwt}`;
  const url = month
    ? `http://localhost/payments?month=${month}`
    : "http://localhost/payments";
  return new Request(url, {
    method: "GET",
    headers,
  });
}

async function jsonBody(res: Response): Promise<unknown> {
  return await res.json();
}

// ═══════════════════════════════════════════════════════════════════════════
// OPTIONS / CORS
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: payments OPTIONS — returns 200 with CORS headers", async () => {
  const res = await handlePayments(
    new Request("http://localhost/payments", { method: "OPTIONS" }),
  );
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("Access-Control-Allow-Origin") !== null, true);
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /payments
// ═══════════════════════════════════════════════════════════════════════════

// ─── 201 — on_time=true (paid on 3rd, before 5th) ────────────────────────

Deno.test("unit: POST /payments — 201 with on_time=true when paid on 3rd of month", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handlePayments(
      makePostRequest(
        {
          tenant_id: MOCK_TENANT_ID,
          amount: 1500.0,
          reference_month: "2026-05",
          paid_at: "2026-05-03T10:00:00Z",
        },
        "valid.jwt",
      ),
    );
    assertEquals(res.status, 201);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals(typeof body.id, "string");
    assertEquals(body.on_time, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 201 — on_time=false (paid on 8th, after 5th) ────────────────────────

Deno.test("unit: POST /payments — 201 with on_time=false when paid on 8th of month", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handlePayments(
      makePostRequest(
        {
          tenant_id: MOCK_TENANT_ID,
          amount: 1500.0,
          reference_month: "2026-05",
          paid_at: "2026-05-08T10:00:00Z",
        },
        "valid.jwt",
      ),
    );
    assertEquals(res.status, 201);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals(typeof body.id, "string");
    assertEquals(body.on_time, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 201 — reference_month as YYYY-MM-DD ─────────────────────────────────

Deno.test("unit: POST /payments — 201 accepts YYYY-MM-DD reference_month format", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handlePayments(
      makePostRequest(
        {
          tenant_id: MOCK_TENANT_ID,
          amount: 2000.0,
          reference_month: "2026-05-01",
          paid_at: "2026-05-03T10:00:00Z",
        },
        "valid.jwt",
      ),
    );
    assertEquals(res.status, 201);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals(body.on_time, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 401 — missing JWT ────────────────────────────────────────────────────

Deno.test("unit: POST /payments — 401 when no JWT provided", async () => {
  const res = await handlePayments(
    makePostRequest({
      tenant_id: MOCK_TENANT_ID,
      amount: 1500.0,
      reference_month: "2026-05",
      paid_at: "2026-05-03T10:00:00Z",
    }),
  );
  assertEquals(res.status, 401);
  const body = await jsonBody(res) as Record<string, unknown>;
  assertEquals((body.error as Record<string, string>).code, "UNAUTHORIZED");
});

// ─── 401 — invalid JWT ────────────────────────────────────────────────────

Deno.test("unit: POST /payments — 401 when JWT is invalid or expired", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ authUser: null }) as typeof fetch;
  try {
    const res = await handlePayments(
      makePostRequest(
        {
          tenant_id: MOCK_TENANT_ID,
          amount: 1500.0,
          reference_month: "2026-05",
          paid_at: "2026-05-03T10:00:00Z",
        },
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

// ─── 400 — invalid reference_month format ────────────────────────────────

Deno.test("unit: POST /payments — 400 when reference_month format is invalid", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handlePayments(
      makePostRequest(
        {
          tenant_id: MOCK_TENANT_ID,
          amount: 1500.0,
          reference_month: "05-2026",
          paid_at: "2026-05-03T10:00:00Z",
        },
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

// ─── 400 — missing tenant_id ──────────────────────────────────────────────

Deno.test("unit: POST /payments — 400 when tenant_id is missing", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handlePayments(
      makePostRequest(
        {
          amount: 1500.0,
          reference_month: "2026-05",
          paid_at: "2026-05-03T10:00:00Z",
        },
        "valid.jwt",
      ),
    );
    assertEquals(res.status, 400);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals(
      (body.error as Record<string, string>).code,
      "MISSING_TENANT_ID",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 400 — missing amount ─────────────────────────────────────────────────

Deno.test("unit: POST /payments — 400 when amount is missing or not a positive number", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handlePayments(
      makePostRequest(
        {
          tenant_id: MOCK_TENANT_ID,
          amount: -100,
          reference_month: "2026-05",
          paid_at: "2026-05-03T10:00:00Z",
        },
        "valid.jwt",
      ),
    );
    assertEquals(res.status, 400);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals(
      (body.error as Record<string, string>).code,
      "INVALID_AMOUNT",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 400 — missing paid_at ────────────────────────────────────────────────

Deno.test("unit: POST /payments — 400 when paid_at is missing", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handlePayments(
      makePostRequest(
        {
          tenant_id: MOCK_TENANT_ID,
          amount: 1500.0,
          reference_month: "2026-05",
        },
        "valid.jwt",
      ),
    );
    assertEquals(res.status, 400);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals(
      (body.error as Record<string, string>).code,
      "MISSING_PAID_AT",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 400 — invalid paid_at format ────────────────────────────────────────

Deno.test("unit: POST /payments — 400 when paid_at is not a valid datetime", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handlePayments(
      makePostRequest(
        {
          tenant_id: MOCK_TENANT_ID,
          amount: 1500.0,
          reference_month: "2026-05",
          paid_at: "not-a-date",
        },
        "valid.jwt",
      ),
    );
    assertEquals(res.status, 400);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals(
      (body.error as Record<string, string>).code,
      "INVALID_PAID_AT",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 201 — on_time boundary tests ────────────────────────────────────────

Deno.test("unit: POST /payments — on_time=true when paid exactly at boundary (5th 23:59:59Z)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({
    paymentInsert: { id: "pay-boundary" },
  }) as typeof fetch;
  try {
    const res = await handlePayments(
      makePostRequest(
        {
          tenant_id: MOCK_TENANT_ID,
          amount: 1500.0,
          reference_month: "2026-05",
          paid_at: "2026-05-05T23:59:59Z",
        },
        "valid.jwt",
      ),
    );
    assertEquals(res.status, 201);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals(body.on_time, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("unit: POST /payments — on_time=false when paid one second after boundary (6th 00:00:00Z)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({
    paymentInsert: { id: "pay-late" },
  }) as typeof fetch;
  try {
    const res = await handlePayments(
      makePostRequest(
        {
          tenant_id: MOCK_TENANT_ID,
          amount: 1500.0,
          reference_month: "2026-05",
          paid_at: "2026-05-06T00:00:00Z",
        },
        "valid.jwt",
      ),
    );
    assertEquals(res.status, 201);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals(body.on_time, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── CORS headers ─────────────────────────────────────────────────────────

Deno.test("unit: POST /payments — success response includes CORS headers", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handlePayments(
      makePostRequest(
        {
          tenant_id: MOCK_TENANT_ID,
          amount: 1500.0,
          reference_month: "2026-05",
          paid_at: "2026-05-03T10:00:00Z",
        },
        "valid.jwt",
      ),
    );
    assertEquals(res.headers.get("Access-Control-Allow-Origin") !== null, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /payments?month=YYYY-MM
// ═══════════════════════════════════════════════════════════════════════════

// ─── 200 — correct paid/overdue split ────────────────────────────────────

Deno.test("unit: GET /payments — 200 returns correct paid and overdue split", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({
    payments: MOCK_PAYMENTS,
    properties: MOCK_PROPERTIES,
    activeTenants: MOCK_ACTIVE_TENANTS,
    reminders: MOCK_REMINDERS,
  }) as typeof fetch;
  try {
    const res = await handlePayments(makeGetRequest("2026-05", "valid.jwt"));
    assertEquals(res.status, 200);
    const body = await jsonBody(res) as Record<string, unknown>;

    // Paid: only MOCK_TENANT_ID (tenant-uuid-1)
    const paid = body.paid as Array<Record<string, unknown>>;
    assertEquals(paid.length, 1);
    assertEquals(paid[0].tenant_id, MOCK_TENANT_ID);
    assertEquals(paid[0].name, "João Silva");
    assertEquals(paid[0].amount, 1500.0);
    assertEquals(paid[0].on_time, true);

    // Overdue: MOCK_TENANT_ID_2 and MOCK_TENANT_ID_3 (not in paid set)
    const overdue = body.overdue as Array<Record<string, unknown>>;
    assertEquals(overdue.length, 2);

    const overdueIds = overdue.map((o) => o.tenant_id);
    assertEquals(overdueIds.includes(MOCK_TENANT_ID_2), true);
    assertEquals(overdueIds.includes(MOCK_TENANT_ID_3), true);

    // MOCK_TENANT_ID_2 has a reminder
    const overdueTenant2 = overdue.find(
      (o) => o.tenant_id === MOCK_TENANT_ID_2,
    );
    assertEquals(
      overdueTenant2?.last_reminder_sent_at,
      "2026-05-10T09:00:00Z",
    );

    // MOCK_TENANT_ID_3 has no reminder
    const overdueTenant3 = overdue.find(
      (o) => o.tenant_id === MOCK_TENANT_ID_3,
    );
    assertEquals(overdueTenant3?.last_reminder_sent_at, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 200 — empty month (no payments, no active tenants) ──────────────────

Deno.test("unit: GET /payments — 200 returns empty paid and overdue when no data", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({
    payments: [],
    properties: [],
    activeTenants: [],
    reminders: [],
  }) as typeof fetch;
  try {
    const res = await handlePayments(makeGetRequest("2026-01", "valid.jwt"));
    assertEquals(res.status, 200);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals((body.paid as unknown[]).length, 0);
    assertEquals((body.overdue as unknown[]).length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 400 — invalid month format ───────────────────────────────────────────

Deno.test("unit: GET /payments — 400 when month format is invalid", async () => {
  const res = await handlePayments(makeGetRequest("2026-5", "valid.jwt"));
  assertEquals(res.status, 400);
  const body = await jsonBody(res) as Record<string, unknown>;
  assertEquals((body.error as Record<string, string>).code, "INVALID_MONTH");
});

// ─── 400 — missing month param ────────────────────────────────────────────

Deno.test("unit: GET /payments — 400 when month param is missing", async () => {
  const res = await handlePayments(makeGetRequest(undefined, "valid.jwt"));
  assertEquals(res.status, 400);
  const body = await jsonBody(res) as Record<string, unknown>;
  assertEquals((body.error as Record<string, string>).code, "INVALID_MONTH");
});

// ─── 401 — missing JWT ────────────────────────────────────────────────────

Deno.test("unit: GET /payments — 401 when no JWT provided", async () => {
  const res = await handlePayments(makeGetRequest("2026-05"));
  assertEquals(res.status, 401);
  const body = await jsonBody(res) as Record<string, unknown>;
  assertEquals((body.error as Record<string, string>).code, "UNAUTHORIZED");
});

// ─── 401 — invalid JWT ────────────────────────────────────────────────────

Deno.test("unit: GET /payments — 401 when JWT is invalid or expired", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ authUser: null }) as typeof fetch;
  try {
    const res = await handlePayments(
      makeGetRequest("2026-05", "expired.jwt"),
    );
    assertEquals(res.status, 401);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals((body.error as Record<string, string>).code, "UNAUTHORIZED");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── CORS headers ─────────────────────────────────────────────────────────

Deno.test("unit: GET /payments — response includes CORS headers", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({
    payments: MOCK_PAYMENTS,
    properties: MOCK_PROPERTIES,
    activeTenants: MOCK_ACTIVE_TENANTS,
    reminders: [],
  }) as typeof fetch;
  try {
    const res = await handlePayments(makeGetRequest("2026-05", "valid.jwt"));
    assertEquals(res.headers.get("Access-Control-Allow-Origin") !== null, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 405 — wrong method ───────────────────────────────────────────────────

Deno.test("unit: payments — 405 when DELETE is used", async () => {
  const res = await handlePayments(
    new Request("http://localhost/payments", { method: "DELETE" }),
  );
  assertEquals(res.status, 405);
  const body = await jsonBody(res) as Record<string, unknown>;
  assertEquals(
    (body.error as Record<string, string>).code,
    "METHOD_NOT_ALLOWED",
  );
});
