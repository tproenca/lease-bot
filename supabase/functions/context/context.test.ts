// unit: GET /context
// unit: GET /context/health/cron
//
// Tests call handleContext() and handleHealthCron() directly, following the
// same pattern as supabase/functions/setup/complete/complete.test.ts. Network
// calls to Supabase Auth and PostgREST are intercepted via globalThis.fetch
// stubs so no real Supabase instance is needed.
//
// Test names follow the "unit:" / "integration:" prefix convention.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

// Set required env vars before importing the handler so requireEnv() doesn't throw.
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_ANON_KEY", "test-anon-key");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");

import { handleContext, handleHealthCron } from "./index.ts";

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
    options: null,
  },
];

const MOCK_PLACEHOLDERS_WITH_OPTIONS = [
  {
    name: "estado_civil",
    required: true,
    format: "text",
    case: null,
    default: null,
    derived_from: null,
    derived_formula: null,
    options: ["solteiro", "casado", "viúvo"],
  },
];

const MOCK_WITNESSES = [{ name: "Maria Oliveira", whatsapp: "+5511888888888" }];

const MOCK_TENANTS = [
  {
    id: "tenant-uuid-1",
    property_id: "prop-uuid-1",
    name: "Carlos Souza",
    cpf: "123.456.789-00",
    whatsapp: "+5511977777777",
    drive_folder_id: "drive-folder-123",
  },
];

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
  placeholders?:
    | typeof MOCK_PLACEHOLDERS
    | typeof MOCK_PLACEHOLDERS_WITH_OPTIONS;
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
      return new Response(
        JSON.stringify(opts.placeholders ?? MOCK_PLACEHOLDERS),
        { status: 200 },
      );
    }

    // PostgREST: witnesses
    if (url.includes("/rest/v1/witnesses")) {
      return new Response(JSON.stringify(MOCK_WITNESSES), { status: 200 });
    }

    // PostgREST: tenants — the handler now uses .in("drive_folder_id", [...])
    // so the URL will contain "drive_folder_id=in.(...)". Return MOCK_TENANTS
    // when a non-empty filter is present; return [] when the caller passes an
    // empty list (edge-case guarded in the handler itself, so this path is
    // only reached if the guard is somehow bypassed).
    if (url.includes("/rest/v1/tenants")) {
      return new Response(JSON.stringify(MOCK_TENANTS), { status: 200 });
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

Deno.test("unit: GET /context — 401 when no JWT provided", async () => {
  const res = await handleContext(makeRequest());
  assertEquals(res.status, 401);
  const body = await jsonBody(res);
  assertEquals((body.error as Record<string, string>).code, "UNAUTHORIZED");
});

// ─── 401 — invalid JWT ────────────────────────────────────────────────────

Deno.test("unit: GET /context — 401 when JWT is invalid", async () => {
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

Deno.test("unit: GET /context — 200 returns full landlord context", async () => {
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
    const properties = body.properties as Array<Record<string, unknown>>;
    assertEquals(properties.length, 1);
    // apartment gets display_name composed from building name
    assertEquals(properties[0].display_name, "Edifício Central - Apto 101");

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

    // tenants
    const tenants = body.tenants as Array<Record<string, unknown>>;
    assertEquals(tenants.length, 1);
    assertEquals(tenants[0].id, MOCK_TENANTS[0].id);
    assertEquals(tenants[0].property_id, MOCK_TENANTS[0].property_id);
    assertEquals(tenants[0].name, MOCK_TENANTS[0].name);

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

Deno.test("unit: GET /context — account_config reflects daily frequency", async () => {
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

Deno.test("unit: GET /context — returns empty arrays when no data exists", async () => {
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
    assertEquals((body.tenants as unknown[]).length, 0);
    assertEquals((body.cron_errors as unknown[]).length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 404 — landlord row not found ────────────────────────────────────────

Deno.test("unit: GET /context — 404 when landlord row does not exist", async () => {
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

Deno.test("unit: GET /context — success response includes CORS headers", async () => {
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

Deno.test("unit: GET /context — error response includes CORS headers", async () => {
  const res = await handleContext(makeRequest());
  assertEquals(res.headers.get("Access-Control-Allow-Origin") !== null, true);
});

// ─── OPTIONS preflight ────────────────────────────────────────────────────

Deno.test("unit: GET /context — OPTIONS returns 200 with CORS headers", async () => {
  const res = await handleContext(makeRequest(undefined, "OPTIONS"));
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("Access-Control-Allow-Origin") !== null, true);
});

// ─── 405 — wrong HTTP method ──────────────────────────────────────────────

Deno.test("unit: GET /context — 405 when POST is used", async () => {
  const res = await handleContext(makeRequest(undefined, "POST"));
  assertEquals(res.status, 405);
  const body = await jsonBody(res);
  assertEquals(
    (body.error as Record<string, string>).code,
    "METHOD_NOT_ALLOWED",
  );
});

// ─── Template with multiple property types ────────────────────────────────

Deno.test("unit: GET /context — template mapped to multiple property types", async () => {
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

Deno.test("unit: GET /context — template with no property type mapping returns empty array", async () => {
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

// ─── Placeholder with options field ──────────────────────────────────────

Deno.test("unit: GET /context — placeholders include options field when present", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({
    placeholders: MOCK_PLACEHOLDERS_WITH_OPTIONS,
  }) as typeof fetch;
  try {
    const res = await handleContext(makeRequest("valid.jwt.for.test"));
    assertEquals(res.status, 200);
    const body = await jsonBody(res);
    const placeholders = body.placeholders as Array<Record<string, unknown>>;
    assertEquals(placeholders.length, 1);
    assertEquals(placeholders[0].name, "estado_civil");
    assertEquals(Array.isArray(placeholders[0].options), true);
    assertEquals((placeholders[0].options as string[]).length, 3);
    assertEquals((placeholders[0].options as string[])[0], "solteiro");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── Placeholder with null options field ────────────────────────────────

Deno.test("unit: GET /context — placeholders include null options when not set", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handleContext(makeRequest("valid.jwt.for.test"));
    assertEquals(res.status, 200);
    const body = await jsonBody(res);
    const placeholders = body.placeholders as Array<Record<string, unknown>>;
    assertEquals(placeholders.length, 1);
    assertEquals(placeholders[0].options, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /context/health/cron — unit tests
// ═══════════════════════════════════════════════════════════════════════════

const SERVICE_ROLE_KEY = "test-service-role-key";

function makeHealthRequest(bearer?: string, method = "GET"): Request {
  const headers: Record<string, string> = {};
  if (bearer) headers["Authorization"] = `Bearer ${bearer}`;
  return new Request("http://localhost/context/health/cron", {
    method,
    headers,
  });
}

// ─── 401 — no bearer ─────────────────────────────────────────────────────

Deno.test("unit: GET /context/health/cron — 401 when no Authorization header", async () => {
  const res = await handleHealthCron(makeHealthRequest());
  assertEquals(res.status, 401);
  const body = await jsonBody(res);
  assertEquals((body.error as Record<string, string>).code, "UNAUTHORIZED");
});

// ─── 401 — wrong bearer ──────────────────────────────────────────────────

Deno.test("unit: GET /context/health/cron — 401 when bearer is not the service-role key", async () => {
  const res = await handleHealthCron(makeHealthRequest("wrong-key"));
  assertEquals(res.status, 401);
  const body = await jsonBody(res);
  assertEquals((body.error as Record<string, string>).code, "UNAUTHORIZED");
});

// ─── 200 — no cron errors in the last 25 hours ───────────────────────────

Deno.test("unit: GET /context/health/cron — 200 when no cron_errors rows", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : (input as Request).url;
    if (url.includes("/rest/v1/cron_errors")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    throw new Error(`Unexpected fetch in health test: ${url}`);
  }) as typeof fetch;

  try {
    const res = await handleHealthCron(makeHealthRequest(SERVICE_ROLE_KEY));
    assertEquals(res.status, 200);
    const body = await jsonBody(res);
    assertEquals(body.status, "ok");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 503 — cron errors present ───────────────────────────────────────────

Deno.test("unit: GET /context/health/cron — 503 when cron_errors rows exist", async () => {
  const MOCK_ERROR_ROW = {
    job_name: "send_payment_reminders",
    error: "Connection timeout",
    occurred_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : (input as Request).url;
    if (url.includes("/rest/v1/cron_errors")) {
      return new Response(JSON.stringify([MOCK_ERROR_ROW]), { status: 200 });
    }
    throw new Error(`Unexpected fetch in health test: ${url}`);
  }) as typeof fetch;

  try {
    const res = await handleHealthCron(makeHealthRequest(SERVICE_ROLE_KEY));
    assertEquals(res.status, 503);
    const body = await jsonBody(res);
    assertEquals(body.status, "error");
    const errors = body.errors as Array<Record<string, unknown>>;
    assertEquals(errors.length, 1);
    assertEquals(errors[0].job_name, "send_payment_reminders");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 405 — wrong HTTP method ──────────────────────────────────────────────

Deno.test("unit: GET /context/health/cron — 405 when POST is used", async () => {
  const res = await handleHealthCron(
    makeHealthRequest(SERVICE_ROLE_KEY, "POST"),
  );
  assertEquals(res.status, 405);
  const body = await jsonBody(res);
  assertEquals(
    (body.error as Record<string, string>).code,
    "METHOD_NOT_ALLOWED",
  );
});

// ─── OPTIONS preflight ────────────────────────────────────────────────────

Deno.test("unit: GET /context/health/cron — OPTIONS returns 200 with CORS headers", async () => {
  const res = await handleHealthCron(makeHealthRequest(undefined, "OPTIONS"));
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("Access-Control-Allow-Origin") !== null, true);
});

// ─── DB error fallback ────────────────────────────────────────────────────

Deno.test("unit: GET /context/health/cron — 500 when DB query fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : (input as Request).url;
    if (url.includes("/rest/v1/cron_errors")) {
      return new Response(
        JSON.stringify({ message: "connection refused", code: "PGRST000" }),
        { status: 500 },
      );
    }
    throw new Error(`Unexpected fetch in health test: ${url}`);
  }) as typeof fetch;

  try {
    const res = await handleHealthCron(makeHealthRequest(SERVICE_ROLE_KEY));
    assertEquals(res.status, 500);
    const body = await jsonBody(res);
    assertEquals((body.error as Record<string, string>).code, "DB_ERROR");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── Tenants in context response ─────────────────────────────────────────

Deno.test("unit: GET /context — returns tenants array with expected fields", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handleContext(makeRequest("valid.jwt.for.test"));
    assertEquals(res.status, 200);
    const body = await jsonBody(res);
    const tenants = body.tenants as Array<Record<string, unknown>>;
    assertEquals(tenants.length, 1);
    assertEquals(tenants[0].id, MOCK_TENANTS[0].id);
    assertEquals(tenants[0].property_id, MOCK_TENANTS[0].property_id);
    assertEquals(tenants[0].name, MOCK_TENANTS[0].name);
    assertEquals(tenants[0].cpf, MOCK_TENANTS[0].cpf);
    assertEquals(tenants[0].whatsapp, MOCK_TENANTS[0].whatsapp);
    assertEquals(tenants[0].drive_folder_id, MOCK_TENANTS[0].drive_folder_id);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── Active tenants filter ────────────────────────────────────────────────

Deno.test(
  "unit: GET /context — inactive tenant (drive_folder_id not matching any property) is excluded",
  async () => {
    // This tenant's drive_folder_id does NOT match MOCK_PROPERTIES[0].current_tenant_folder_id.
    const inactiveTenant = {
      id: "tenant-uuid-inactive",
      property_id: "prop-uuid-1",
      name: "Inactive Tenant",
      cpf: "000.000.000-00",
      whatsapp: "+5511000000000",
      drive_folder_id: "drive-folder-OLD",
    };

    const originalFetch = globalThis.fetch;
    // Override only the tenants stub so we can simulate PostgREST filtering:
    // return the inactive tenant when no filter is applied but return [] when
    // the drive_folder_id filter does not include "drive-folder-OLD".
    globalThis.fetch =
      (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string"
          ? input
          : input instanceof URL
          ? input.href
          : (input as Request).url;

        if (url.includes("/rest/v1/tenants")) {
          // The handler filters by drive_folder_id=in.(<activeFolderIds>).
          // MOCK_PROPERTIES[0].current_tenant_folder_id = "drive-folder-123".
          // "drive-folder-OLD" is not in that set, so PostgREST would return [].
          // We simulate that by checking whether the URL contains the active id.
          const hasActiveFilter = url.includes("drive-folder-123");
          return new Response(
            JSON.stringify(hasActiveFilter ? [] : [inactiveTenant]),
            { status: 200 },
          );
        }

        // All other URLs delegate to the standard mock.
        const base = buildMockFetch({});
        return base(input, init);
      }) as typeof fetch;

    try {
      const res = await handleContext(makeRequest("valid.jwt.for.test"));
      assertEquals(res.status, 200);
      const body = await jsonBody(res);
      const tenants = body.tenants as Array<Record<string, unknown>>;
      // The inactive tenant must not appear in the response.
      assertEquals(tenants.length, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

Deno.test("unit: GET /context — house property has no display_name", async () => {
  const originalFetch = globalThis.fetch;
  const houseProperty = [{
    id: "prop-uuid-2",
    type: "house",
    name: "Casa Verde",
    address: "Rua B, 10",
    building_id: null,
    current_tenant_folder_id: null,
  }];
  globalThis.fetch = buildMockFetch({});
  // Override the properties stub to return a house
  const inner = globalThis.fetch;
  const innerFetch = inner;
  globalThis.fetch =
    (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.href
        : (input as Request).url;
      if (url.includes("/rest/v1/properties")) {
        return new Response(JSON.stringify(houseProperty), { status: 200 });
      }
      return innerFetch(input, init);
    }) as typeof fetch;

  try {
    const req = new Request("http://localhost/functions/v1/context", {
      headers: { Authorization: "Bearer valid-jwt" },
    });
    const res = await handleContext(req);
    assertEquals(res.status, 200);
    const body = await res.json() as Record<string, unknown>;
    const properties = body.properties as Array<Record<string, unknown>>;
    assertEquals(properties.length, 1);
    assertEquals(properties[0].name, "Casa Verde");
    assertEquals(properties[0].display_name, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
