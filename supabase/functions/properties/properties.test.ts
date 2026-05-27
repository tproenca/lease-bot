// unit: GET /properties + POST /properties
//
// Tests call handleProperties() directly. Network calls to Supabase Auth,
// PostgREST, and Google APIs are intercepted via globalThis.fetch stubs.
// No real Supabase instance or Google account is needed.
//
// Test names follow the "unit:" / "integration:" prefix convention.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

// Set required env vars before importing the handler so requireEnv() doesn't throw.
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_ANON_KEY", "test-anon-key");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
Deno.env.set("GOOGLE_CLIENT_ID", "test-google-client-id");
Deno.env.set("GOOGLE_CLIENT_SECRET", "test-google-client-secret");

import { handleProperties } from "./index.ts";

// ─── Fixtures ─────────────────────────────────────────────────────────────

const MOCK_USER_ID = "user-uuid-1234";

const MOCK_USER = {
  id: MOCK_USER_ID,
  email: "landlord@example.com",
  user_metadata: {},
};

const MOCK_LANDLORD = {
  google_refresh_token: "mock-refresh-token",
  root_folder_id: "root-drive-folder-id",
};

const MOCK_BUILDING = {
  id: "bldg-uuid-1",
  drive_folder_id: "bldg-drive-folder-id",
};

const MOCK_PROPERTY_INSERT = {
  id: "prop-uuid-new",
  drive_folder_id: "prop-drive-folder-new",
};

const MOCK_PROPERTIES_LIST = [
  {
    id: "prop-uuid-1",
    type: "apartment",
    name: "Apto 101",
    address: "Rua A, 1",
    building_id: "bldg-uuid-1",
    current_tenant_folder_id: null,
  },
  {
    id: "prop-uuid-2",
    type: "house",
    name: "Casa da Praia",
    address: "Av. Mar, 10",
    building_id: null,
    current_tenant_folder_id: null,
  },
];

const MOCK_ACCESS_TOKEN = "mock-access-token";

// ─── Fetch stub builder ──────────────────────────────────────────────────

function buildMockFetch(opts: {
  authUser?: typeof MOCK_USER | null;
  landlord?: typeof MOCK_LANDLORD | null;
  building?: typeof MOCK_BUILDING | null;
  googleTokenFail?: boolean;
  googleTokenServerError?: boolean;
  driveFolderFail?: boolean;
  dbInsertFail?: boolean;
  propertiesList?: typeof MOCK_PROPERTIES_LIST;
  existingDriveFolder?: string | null;
}) {
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

    // PostgREST: landlords (service client)
    if (url.includes("/rest/v1/landlords")) {
      if (opts.landlord === null) {
        return new Response(JSON.stringify(null), { status: 200 });
      }
      return new Response(
        JSON.stringify(opts.landlord ?? MOCK_LANDLORD),
        { status: 200 },
      );
    }

    // PostgREST: buildings (user client — RLS applies)
    // .maybeSingle() expects either null or an object (single item query).
    if (url.includes("/rest/v1/buildings")) {
      if (opts.building === null) {
        return new Response(JSON.stringify(null), { status: 200 });
      }
      return new Response(
        JSON.stringify(opts.building ?? MOCK_BUILDING),
        { status: 200 },
      );
    }

    // PostgREST: properties
    // .single() sends Accept: application/vnd.pgrst.object+json, so PostgREST
    // returns a single JSON object (not an array). The mock must match.
    if (url.includes("/rest/v1/properties")) {
      if (opts.dbInsertFail && method === "POST") {
        return new Response(
          JSON.stringify({ message: "db error", code: "PGRST000" }),
          { status: 500 },
        );
      }
      if (method === "POST") {
        return new Response(
          JSON.stringify(MOCK_PROPERTY_INSERT),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }
      // GET — return list
      return new Response(
        JSON.stringify(opts.propertiesList ?? MOCK_PROPERTIES_LIST),
        { status: 200 },
      );
    }

    // Google token endpoint
    if (url.includes("oauth2.googleapis.com/token")) {
      if (opts.googleTokenFail) {
        return new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
        });
      }
      if (opts.googleTokenServerError) {
        return new Response(JSON.stringify({ error: "server_error" }), {
          status: 500,
        });
      }
      return new Response(
        JSON.stringify({ access_token: MOCK_ACCESS_TOKEN, expires_in: 3600 }),
        { status: 200 },
      );
    }

    // Google Drive folder search (findDriveFolderByName)
    if (url.includes("www.googleapis.com/drive/v3/files") && method === "GET") {
      const existingId = opts.existingDriveFolder ?? null;
      if (existingId) {
        return new Response(
          JSON.stringify({ files: [{ id: existingId, name: "existing" }] }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ files: [] }), { status: 200 });
    }

    // Google Drive folder creation
    if (
      url.includes("www.googleapis.com/drive/v3/files") && method === "POST"
    ) {
      if (opts.driveFolderFail) {
        return new Response(JSON.stringify({ error: "quota exceeded" }), {
          status: 403,
        });
      }
      return new Response(
        JSON.stringify({ id: MOCK_PROPERTY_INSERT.drive_folder_id }),
        { status: 200 },
      );
    }

    throw new Error(`Unexpected fetch in test: ${url}`);
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeRequest(
  body?: unknown,
  jwt?: string,
  method = "POST",
): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (jwt) headers["Authorization"] = `Bearer ${jwt}`;
  return new Request("http://localhost/properties", {
    method,
    headers,
    body: body !== undefined && method !== "GET"
      ? JSON.stringify(body)
      : undefined,
  });
}

async function jsonBody(res: Response): Promise<unknown> {
  return await res.json();
}

// ═══════════════════════════════════════════════════════════════════════════
// GET /properties
// ═══════════════════════════════════════════════════════════════════════════

// ─── 401 — no JWT ─────────────────────────────────────────────────────────

Deno.test("unit: GET /properties — 401 when no JWT provided", async () => {
  const res = await handleProperties(makeRequest(undefined, undefined, "GET"));
  assertEquals(res.status, 401);
  const body = await jsonBody(res) as Record<string, unknown>;
  assertEquals((body.error as Record<string, string>).code, "UNAUTHORIZED");
});

// ─── 200 — happy path ─────────────────────────────────────────────────────

Deno.test("unit: GET /properties — 200 returns all properties for landlord", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handleProperties(
      makeRequest(undefined, "valid.jwt", "GET"),
    );
    assertEquals(res.status, 200);
    const body = await jsonBody(res) as unknown[];
    assertEquals(body.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 200 — empty list ─────────────────────────────────────────────────────

Deno.test("unit: GET /properties — 200 returns empty array when no properties exist", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ propertiesList: [] }) as typeof fetch;
  try {
    const res = await handleProperties(
      makeRequest(undefined, "valid.jwt", "GET"),
    );
    assertEquals(res.status, 200);
    const body = await jsonBody(res) as unknown[];
    assertEquals(body.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── CORS on GET ──────────────────────────────────────────────────────────

Deno.test("unit: GET /properties — response includes CORS headers", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handleProperties(
      makeRequest(undefined, "valid.jwt", "GET"),
    );
    assertEquals(res.headers.get("Access-Control-Allow-Origin") !== null, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /properties
// ═══════════════════════════════════════════════════════════════════════════

// ─── 401 — no JWT ─────────────────────────────────────────────────────────

Deno.test("unit: POST /properties — 401 when no JWT provided", async () => {
  const res = await handleProperties(
    makeRequest({ type: "house", name: "Casa A", address: "Rua B, 2" }),
  );
  assertEquals(res.status, 401);
  const body = await jsonBody(res) as Record<string, unknown>;
  assertEquals((body.error as Record<string, string>).code, "UNAUTHORIZED");
});

// ─── 401 — invalid JWT ────────────────────────────────────────────────────

Deno.test("unit: POST /properties — 401 when JWT is invalid", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ authUser: null }) as typeof fetch;
  try {
    const res = await handleProperties(
      makeRequest(
        { type: "house", name: "Casa A", address: "Rua B, 2" },
        "bad.jwt",
      ),
    );
    assertEquals(res.status, 401);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 400 — missing type ───────────────────────────────────────────────────

Deno.test("unit: POST /properties — 400 when type is missing", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handleProperties(
      makeRequest({ name: "Casa A", address: "Rua B, 2" }, "valid.jwt"),
    );
    assertEquals(res.status, 400);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals((body.error as Record<string, string>).code, "MISSING_TYPE");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 400 — invalid type ───────────────────────────────────────────────────

Deno.test("unit: POST /properties — 400 when type is invalid value", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handleProperties(
      makeRequest(
        { type: "office", name: "Sala A", address: "Rua C, 3" },
        "valid.jwt",
      ),
    );
    assertEquals(res.status, 400);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals((body.error as Record<string, string>).code, "MISSING_TYPE");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 400 — missing name ───────────────────────────────────────────────────

Deno.test("unit: POST /properties — 400 when name is missing", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handleProperties(
      makeRequest({ type: "house", address: "Rua B, 2" }, "valid.jwt"),
    );
    assertEquals(res.status, 400);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals((body.error as Record<string, string>).code, "MISSING_NAME");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 400 — missing address ────────────────────────────────────────────────

Deno.test("unit: POST /properties — 400 when address is missing", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handleProperties(
      makeRequest({ type: "house", name: "Casa A" }, "valid.jwt"),
    );
    assertEquals(res.status, 400);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals(
      (body.error as Record<string, string>).code,
      "MISSING_ADDRESS",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 400 — apartment without building_id ─────────────────────────────────

Deno.test("unit: POST /properties — 400 when type=apartment and building_id is missing", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handleProperties(
      makeRequest(
        { type: "apartment", name: "Apto 101", address: "Rua A, 1" },
        "valid.jwt",
      ),
    );
    assertEquals(res.status, 400);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals(
      (body.error as Record<string, string>).code,
      "MISSING_BUILDING_ID",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 404 — landlord not found ─────────────────────────────────────────────

Deno.test("unit: POST /properties — 404 when landlord row does not exist", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ landlord: null }) as typeof fetch;
  try {
    const res = await handleProperties(
      makeRequest(
        { type: "house", name: "Casa A", address: "Rua B, 2" },
        "valid.jwt",
      ),
    );
    assertEquals(res.status, 404);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals(
      (body.error as Record<string, string>).code,
      "LANDLORD_NOT_FOUND",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 404 — building_id not found ─────────────────────────────────────────

Deno.test("unit: POST /properties — 404 when building_id not found or belongs to another landlord", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ building: null }) as typeof fetch;
  try {
    const res = await handleProperties(
      makeRequest(
        {
          type: "apartment",
          building_id: "nonexistent-bldg",
          name: "Apto 101",
          address: "Rua A, 1",
        },
        "valid.jwt",
      ),
    );
    assertEquals(res.status, 404);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals(
      (body.error as Record<string, string>).code,
      "BUILDING_NOT_FOUND",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 401 — Google reauth required (invalid_grant) ─────────────────────────

Deno.test("unit: POST /properties — 401 when Google token refresh returns invalid_grant", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ googleTokenFail: true }) as typeof fetch;
  try {
    const res = await handleProperties(
      makeRequest(
        { type: "house", name: "Casa A", address: "Rua B, 2" },
        "valid.jwt",
      ),
    );
    assertEquals(res.status, 401);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals(
      (body.error as Record<string, string>).code,
      "GOOGLE_REAUTH_REQUIRED",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 502 — Google auth failure (non-invalid_grant) ────────────────────────

Deno.test("unit: POST /properties — 502 when Google token refresh fails with server error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({
    googleTokenServerError: true,
  }) as typeof fetch;
  try {
    const res = await handleProperties(
      makeRequest(
        { type: "house", name: "Casa A", address: "Rua B, 2" },
        "valid.jwt",
      ),
    );
    assertEquals(res.status, 502);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals(
      (body.error as Record<string, string>).code,
      "GOOGLE_AUTH_FAILED",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 502 — Drive folder creation failure ─────────────────────────────────

Deno.test("unit: POST /properties — 502 when Drive folder creation fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ driveFolderFail: true }) as typeof fetch;
  try {
    const res = await handleProperties(
      makeRequest(
        { type: "commercial", name: "Loja A", address: "Av. Com., 5" },
        "valid.jwt",
      ),
    );
    assertEquals(res.status, 502);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals(
      (body.error as Record<string, string>).code,
      "DRIVE_CREATE_FOLDER_FAILED",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 201 — house happy path ────────────────────────────────────────────────

Deno.test("unit: POST /properties — 201 creates house property under root folder", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handleProperties(
      makeRequest(
        { type: "house", name: "Casa B", address: "Rua D, 4" },
        "valid.jwt",
      ),
    );
    assertEquals(res.status, 201);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals(typeof body.id, "string");
    assertEquals(typeof body.drive_folder_id, "string");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 201 — commercial happy path ─────────────────────────────────────────

Deno.test("unit: POST /properties — 201 creates commercial property under root folder", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handleProperties(
      makeRequest(
        { type: "commercial", name: "Loja Central", address: "Av. Com., 1" },
        "valid.jwt",
      ),
    );
    assertEquals(res.status, 201);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals(typeof body.id, "string");
    assertEquals(typeof body.drive_folder_id, "string");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 201 — apartment happy path ───────────────────────────────────────────

Deno.test("unit: POST /properties — 201 creates apartment inside building folder", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handleProperties(
      makeRequest(
        {
          type: "apartment",
          building_id: MOCK_BUILDING.id,
          name: "Apto 202",
          address: "Rua A, 1",
        },
        "valid.jwt",
      ),
    );
    assertEquals(res.status, 201);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals(typeof body.id, "string");
    assertEquals(typeof body.drive_folder_id, "string");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── CORS headers on success ──────────────────────────────────────────────

Deno.test("unit: POST /properties — success response includes CORS headers", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handleProperties(
      makeRequest(
        { type: "house", name: "Casa C", address: "Rua E, 5" },
        "valid.jwt",
      ),
    );
    assertEquals(res.headers.get("Access-Control-Allow-Origin") !== null, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── CORS headers on error ────────────────────────────────────────────────

Deno.test("unit: POST /properties — error response includes CORS headers", async () => {
  const res = await handleProperties(
    makeRequest({ type: "house", name: "Casa C", address: "Rua E, 5" }),
  );
  assertEquals(res.headers.get("Access-Control-Allow-Origin") !== null, true);
});

// ─── OPTIONS preflight ────────────────────────────────────────────────────

Deno.test("unit: POST /properties — OPTIONS returns 200 with CORS headers", async () => {
  const res = await handleProperties(
    makeRequest(undefined, undefined, "OPTIONS"),
  );
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("Access-Control-Allow-Origin") !== null, true);
});

// ─── 405 — wrong method ───────────────────────────────────────────────────

Deno.test("unit: POST /properties — 405 when DELETE is used", async () => {
  const res = await handleProperties(
    makeRequest(undefined, undefined, "DELETE"),
  );
  assertEquals(res.status, 405);
  const body = await jsonBody(res) as Record<string, unknown>;
  assertEquals(
    (body.error as Record<string, string>).code,
    "METHOD_NOT_ALLOWED",
  );
});
