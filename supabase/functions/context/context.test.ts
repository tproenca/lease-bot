// integration: GET /context
//
// Tests call handleContext() directly, following the same pattern as
// supabase/functions/setup/complete/complete.test.ts. Network calls to
// Supabase Auth and PostgREST are intercepted via globalThis.fetch stubs so
// no real Supabase instance is needed.
//
// Test naming follows the ci.sh filter: "unit|integration".

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

// Set required env vars before importing the handler so requireEnv() doesn't throw.
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_ANON_KEY", "test-anon-key");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");

import { handleContext } from "./index.ts";

// ─── Fixtures ─────────────────────────────────────────────────────────────

const MOCK_USER_ID = "user-uuid-1234";

const MOCK_USER = {
  id: MOCK_USER_ID,
  email: "landlord@example.com",
  user_metadata: {},
};

const MOCK_LANDLORD = {
  name: "João Silva",
  whatsapp: "+5511999999999",
  payment_reminder_frequency: "weekly",
};

const MOCK_PROPERTIES = [
  {
    id: "prop-uuid-1",
    type: "apartment",
    name: "Apto 101",
    address: "Rua A, 1",
    building_id: "bldg-uuid-1",
    current_tenant_folder_id: "drive-folder-123",
  },
];

const MOCK_BUILDINGS = [
  { id: "bldg-uuid-1", name: "Edifício Central", address: "Rua A, 1" },
];

const MOCK_TEMPLATES = [{ id: "tmpl-uuid-1", name: "Contrato Residencial" }];

const MOCK_PTT = [
  { template_id: "tmpl-uuid-1", property_type: "apartment" },
];

const MOCK_PLACEHOLDERS = [
  {
    name: "nome do inquilino",
    required: true,
    format: "text",
    case: "título",
    default: null,
    derived_from: null,
    derived_formula: null,
  },
];

const MOCK_WITNESSES = [{ name: "Maria Oliveira", whatsapp: "+5511888888888" }];

const MOCK_CRON_ERRORS = [
  {
    id: "err-uuid-1",
    job_name: "payment_reminder",
    error: "Connection timeout",
    occurred_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  },
];

// ─── Fetch stub builder ──────────────────────────────────────────────────

/**
 * Build a fetch stub that intercepts Supabase Auth and PostgREST calls,
 * returning mock data. Each option overrides the default fixture.
 */
function buildMockFetch(opts: {
  authUser?: typeof MOCK_USER | null;
  landlord?: typeof MOCK_LANDLORD | null;
  ptt?: typeof MOCK_PTT;
  dbError?: boolean;
}) {
  // capture original so we don't call our own stub recursively
  const _originalFetch = globalThis.fetch;

  return async function mockFetch(
    input: string | URL | Request,
    _init?: RequestInit,
  ): Promise<Response> {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : (input as Request).url;

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

    // PostgREST: simulate a generic DB error for all table queries
    if (opts.dbError === true && url.includes("/rest/v1/")) {
      return new Response(
        JSON.stringify({ message: "connection refused", code: "PGRST000" }),
        { status: 500 },
      );
    }

    // PostgREST: landlords
    if (url.includes("/rest/v1/landlords")) {
      if (opts.landlord === null) {
        return new Response(JSON.stringify(null), { status: 200 });
      }
      return new Response(
        JSON.stringify(opts.landlord ?? MOCK_LANDLORD),
        { status: 200 },
      );
    }

    // PostgREST: properties
    if (url.includes("/rest/v1/properties")) {
      return new Response(JSON.stringify(MOCK_PROPERTIES), { status: 200 });
    }

    // PostgREST: buildings
    if (url.includes("/rest/v1/buildings")) {
      return new Response(JSON.stringify(MOCK_BUILDINGS), { status: 200 });
    }

    // PostgREST: templates
    if (url.includes("/rest/v1/templates")) {
      return new Response(JSON.stringify(MOCK_TEMPLATES), { status: 200 });
    }

    // PostgREST: property_type_templates
    if (url.includes("/rest/v1/property_type_templates")) {
      return new Response(JSON.stringify(opts.ptt ?? MOCK_PTT), {
        status: 200,
      });
    }

    // PostgREST: placeholders
    if (url.includes("/rest/v1/placeholders")) {
      return new Response(JSON.stringify(MOCK_PLACEHOLDERS), { status: 200 });
    }

    // PostgREST: witnesses
    if (url.includes("/rest/v1/witnesses")) {
      return new Response(JSON.stringify(MOCK_WITNESSES), { status: 200 });
    }

    // PostgREST: cron_errors
    if (url.includes("/rest/v1/cron_errors")) {
      return new Response(JSON.stringify(MOCK_CRON_ERRORS), { status: 200 });
    }

    // Fallthrough — should not happen in tests; fail loudly.
    throw new Error(`Unexpected fetch in test: ${url}`);
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeRequest(jwt?: string, method = "GET"): Request {
  const headers: Record<string, string> = {};
  if (jwt) headers["Authorization"] = `Bearer ${jwt}`;
  return new Request("http://localhost/context", { method, headers });
}

async function jsonBody(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

// ─── 401 — no JWT ─────────────────────────────────────────────────────────

Deno.test("integration: GET /context — 401 when no JWT provided", async () => {
  const res = await handleContext(makeRequest());
  assertEquals(res.status, 401);
  const body = await jsonBody(res);
  assertEquals((body.error as Record<string, string>).code, "UNAUTHORIZED");
});

// ─── 401 — invalid JWT ────────────────────────────────────────────────────

Deno.test("integration: GET /context — 401 when JWT is invalid", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ authUser: null }) as typeof fetch;
  try {
    const res = await handleContext(makeRequest("bad.jwt.token"));
    assertEquals(res.status, 401);
    const body = await jsonBody(res);
    assertEquals((body.error as Record<string, string>).code, "UNAUTHORIZED");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 200 — happy path with full data ─────────────────────────────────────

Deno.test("integration: GET /context — 200 returns full landlord context", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handleContext(makeRequest("valid.jwt.for.test"));
    assertEquals(res.status, 200);
    const body = await jsonBody(res);

    // landlord
    const landlord = body.landlord as Record<string, unknown>;
    assertEquals(landlord.name, MOCK_LANDLORD.name);
    assertEquals(landlord.whatsapp, MOCK_LANDLORD.whatsapp);

    // properties
    const properties = body.properties as unknown[];
    assertEquals(properties.length, 1);

    // buildings
    const buildings = body.buildings as unknown[];
    assertEquals(buildings.length, 1);

    // templates with property_types mapping
    const templates = body.templates as Array<Record<string, unknown>>;
    assertEquals(templates.length, 1);
    assertEquals(templates[0].id, "tmpl-uuid-1");
    assertEquals(templates[0].property_types, ["apartment"]);

    // placeholders
    const placeholders = body.placeholders as unknown[];
    assertEquals(placeholders.length, 1);

    // witnesses
    const witnesses = body.witnesses as unknown[];
    assertEquals(witnesses.length, 1);

    // account_config
    const config = body.account_config as Record<string, unknown>;
    assertEquals(config.payment_reminder_frequency, "weekly");

    // cron_errors from last 24h
    const cronErrors = body.cron_errors as unknown[];
    assertEquals(cronErrors.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 200 — account_config reflects actual payment_reminder_frequency ──────

Deno.test("integration: GET /context — account_config reflects daily frequency", async () => {
  const originalFetch = globalThis.fetch;
  const customLandlord = {
    ...MOCK_LANDLORD,
    payment_reminder_frequency: "daily",
  };
  globalThis.fetch = buildMockFetch({
    landlord: customLandlord,
  }) as typeof fetch;
  try {
    const res = await handleContext(makeRequest("valid.jwt.for.test"));
    assertEquals(res.status, 200);
    const body = await jsonBody(res);
    const config = body.account_config as Record<string, unknown>;
    assertEquals(config.payment_reminder_frequency, "daily");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 200 — empty arrays when no child data exists ─────────────────────────

Deno.test("integration: GET /context — returns empty arrays when no data exists", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : (input as Request).url;

    if (url.includes("/auth/v1/user")) {
      return new Response(JSON.stringify(MOCK_USER), { status: 200 });
    }
    if (url.includes("/rest/v1/landlords")) {
      return new Response(JSON.stringify(MOCK_LANDLORD), { status: 200 });
    }
    // All other tables return empty arrays.
    if (url.includes("/rest/v1/")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  }) as typeof fetch;

  try {
    const res = await handleContext(makeRequest("valid.jwt.for.test"));
    assertEquals(res.status, 200);
    const body = await jsonBody(res);
    assertEquals((body.properties as unknown[]).length, 0);
    assertEquals((body.buildings as unknown[]).length, 0);
    assertEquals((body.templates as unknown[]).length, 0);
    assertEquals((body.placeholders as unknown[]).length, 0);
    assertEquals((body.witnesses as unknown[]).length, 0);
    assertEquals((body.cron_errors as unknown[]).length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 404 — landlord row not found ────────────────────────────────────────

Deno.test("integration: GET /context — 404 when landlord row does not exist", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ landlord: null }) as typeof fetch;
  try {
    const res = await handleContext(makeRequest("valid.jwt.for.test"));
    assertEquals(res.status, 404);
    const body = await jsonBody(res);
    assertEquals(
      (body.error as Record<string, string>).code,
      "LANDLORD_NOT_FOUND",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── CORS headers on success ──────────────────────────────────────────────

Deno.test("integration: GET /context — success response includes CORS headers", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handleContext(makeRequest("valid.jwt.for.test"));
    assertEquals(res.headers.get("Access-Control-Allow-Origin") !== null, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── CORS headers on error ────────────────────────────────────────────────

Deno.test("integration: GET /context — error response includes CORS headers", async () => {
  const res = await handleContext(makeRequest());
  assertEquals(res.headers.get("Access-Control-Allow-Origin") !== null, true);
});

// ─── OPTIONS preflight ────────────────────────────────────────────────────

Deno.test("integration: GET /context — OPTIONS returns 200 with CORS headers", async () => {
  const res = await handleContext(makeRequest(undefined, "OPTIONS"));
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("Access-Control-Allow-Origin") !== null, true);
});

// ─── 405 — wrong HTTP method ──────────────────────────────────────────────

Deno.test("integration: GET /context — 405 when POST is used", async () => {
  const res = await handleContext(makeRequest(undefined, "POST"));
  assertEquals(res.status, 405);
  const body = await jsonBody(res);
  assertEquals(
    (body.error as Record<string, string>).code,
    "METHOD_NOT_ALLOWED",
  );
});

// ─── Template with multiple property types ────────────────────────────────

Deno.test("integration: GET /context — template mapped to multiple property types", async () => {
  const multiPtt = [
    { template_id: "tmpl-uuid-1", property_type: "apartment" },
    { template_id: "tmpl-uuid-1", property_type: "house" },
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ ptt: multiPtt }) as typeof fetch;
  try {
    const res = await handleContext(makeRequest("valid.jwt.for.test"));
    assertEquals(res.status, 200);
    const body = await jsonBody(res);
    const templates = body.templates as Array<Record<string, unknown>>;
    assertEquals(templates.length, 1);
    const types = templates[0].property_types as string[];
    assertEquals(types.length, 2);
    assertEquals(types.includes("apartment"), true);
    assertEquals(types.includes("house"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── Template with no property types ─────────────────────────────────────

Deno.test("integration: GET /context — template with no property type mapping returns empty array", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ ptt: [] }) as typeof fetch;
  try {
    const res = await handleContext(makeRequest("valid.jwt.for.test"));
    assertEquals(res.status, 200);
    const body = await jsonBody(res);
    const templates = body.templates as Array<Record<string, unknown>>;
    assertEquals(templates.length, 1);
    assertEquals((templates[0].property_types as unknown[]).length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
