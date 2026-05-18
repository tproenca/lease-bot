// integration: POST /tenants + GET /tenants/:id + PATCH /tenants/:id
//
// Tests call handleTenants() directly. Network calls to Supabase Auth,
// PostgREST, and Google APIs are intercepted via globalThis.fetch stubs.
// No real Supabase instance or Google account is needed.
//
// Test naming follows the ci.sh filter: "unit|integration".

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

// Set required env vars before importing the handler so requireEnv() doesn't throw.
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_ANON_KEY", "test-anon-key");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
Deno.env.set("GOOGLE_CLIENT_ID", "test-google-client-id");
Deno.env.set("GOOGLE_CLIENT_SECRET", "test-google-client-secret");

import { handleTenants } from "./index.ts";

// ─── Fixtures ─────────────────────────────────────────────────────────────

const MOCK_USER_ID = "user-uuid-landlord";

const MOCK_USER = {
  id: MOCK_USER_ID,
  email: "landlord@example.com",
  user_metadata: {},
};

const MOCK_LANDLORD = {
  google_refresh_token: "mock-refresh-token",
  root_folder_id: "root-drive-folder-id",
};

const MOCK_PROPERTY_ID = "prop-uuid-1";
const MOCK_PROPERTY_DRIVE_FOLDER = "prop-drive-folder-1";
const MOCK_PREV_TENANT_FOLDER = "prev-tenant-drive-folder";

const MOCK_PROPERTY = {
  id: MOCK_PROPERTY_ID,
  type: "house",
  building_id: null,
  drive_folder_id: MOCK_PROPERTY_DRIVE_FOLDER,
  current_tenant_folder_id: null,
};

const MOCK_PROPERTY_WITH_PREV_TENANT = {
  ...MOCK_PROPERTY,
  current_tenant_folder_id: MOCK_PREV_TENANT_FOLDER,
};

const MOCK_PROPERTY_APARTMENT = {
  id: "prop-uuid-apt",
  type: "apartment",
  building_id: "bldg-uuid-1",
  drive_folder_id: "apt-prop-drive-folder",
  current_tenant_folder_id: null,
};

const NEW_TENANT_FOLDER_ID = "new-tenant-drive-folder";

const MOCK_TENANT_INSERT = {
  id: "tenant-uuid-new",
  drive_folder_id: NEW_TENANT_FOLDER_ID,
};

const MOCK_TENANT_FULL = {
  id: "tenant-uuid-1",
  name: "João Silva",
  cpf: "123.456.789-00",
  whatsapp: "+5511999990000",
  property_id: MOCK_PROPERTY_ID,
  drive_folder_id: "tenant-drive-folder-1",
  created_at: "2026-01-01T00:00:00.000Z",
};

const MOCK_ACCESS_TOKEN = "mock-access-token";

// ─── Fetch stub builder ──────────────────────────────────────────────────

type MockFetchOpts = {
  authUser?: typeof MOCK_USER | null;
  landlord?: typeof MOCK_LANDLORD | null;
  property?: Record<string, unknown> | null;
  tenantInsert?: typeof MOCK_TENANT_INSERT | null;
  tenantFull?: typeof MOCK_TENANT_FULL | null;
  tenantExisting?: { id: string } | null;
  googleTokenFail?: boolean;
  driveFolderFail?: boolean;
  driveStarFail?: boolean;
  dbInsertFail?: boolean;
  dbUpdateFail?: boolean;
};

function buildMockFetch(opts: MockFetchOpts) {
  // Track PATCH calls to Drive to detect star/unstar
  const drivePatchedFileIds: string[] = [];

  const mockFetch = async function (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    const url =
      typeof input === "string"
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
      if (method === "GET") {
        if (opts.property === null) {
          return new Response(JSON.stringify(null), { status: 200 });
        }
        return new Response(
          JSON.stringify(opts.property ?? MOCK_PROPERTY),
          { status: 200 },
        );
      }
      if (method === "PATCH") {
        if (opts.dbUpdateFail) {
          return new Response(
            JSON.stringify({ message: "db error", code: "PGRST000" }),
            { status: 500 },
          );
        }
        return new Response(JSON.stringify([]), { status: 200 });
      }
    }

    // PostgREST: tenants
    if (url.includes("/rest/v1/tenants")) {
      if (method === "POST") {
        if (opts.dbInsertFail) {
          return new Response(
            JSON.stringify({ message: "db error", code: "PGRST000" }),
            { status: 500 },
          );
        }
        if (opts.tenantInsert === null) {
          return new Response(JSON.stringify(null), { status: 500 });
        }
        return new Response(
          JSON.stringify([opts.tenantInsert ?? MOCK_TENANT_INSERT]),
          { status: 201 },
        );
      }
      if (method === "GET") {
        if (opts.tenantFull === null || opts.tenantExisting === null) {
          return new Response(JSON.stringify(null), { status: 200 });
        }
        // If tenantFull is provided, it's a full select; if tenantExisting, it's a check
        const data = opts.tenantFull ?? opts.tenantExisting ?? MOCK_TENANT_FULL;
        return new Response(JSON.stringify(data), { status: 200 });
      }
      if (method === "PATCH") {
        if (opts.dbUpdateFail) {
          return new Response(
            JSON.stringify({ message: "db error", code: "PGRST000" }),
            { status: 500 },
          );
        }
        return new Response(JSON.stringify([]), { status: 200 });
      }
    }

    // Google token endpoint
    if (url.includes("oauth2.googleapis.com/token")) {
      if (opts.googleTokenFail) {
        return new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
        });
      }
      return new Response(
        JSON.stringify({ access_token: MOCK_ACCESS_TOKEN, expires_in: 3600 }),
        { status: 200 },
      );
    }

    // Google Drive folder search (findDriveFolderByName — GET)
    if (url.includes("www.googleapis.com/drive/v3/files") && method === "GET") {
      return new Response(JSON.stringify({ files: [] }), { status: 200 });
    }

    // Google Drive folder creation (POST)
    if (
      url.includes("www.googleapis.com/drive/v3/files") && method === "POST"
    ) {
      if (opts.driveFolderFail) {
        return new Response(JSON.stringify({ error: "quota exceeded" }), {
          status: 403,
        });
      }
      return new Response(
        JSON.stringify({ id: NEW_TENANT_FOLDER_ID }),
        { status: 200 },
      );
    }

    // Google Drive PATCH (star / unstar)
    if (
      url.includes("www.googleapis.com/drive/v3/files") && method === "PATCH"
    ) {
      // Extract file ID from URL path
      const match = url.match(/\/files\/([^?]+)/);
      if (match) drivePatchedFileIds.push(match[1]);

      if (opts.driveStarFail) {
        return new Response(JSON.stringify({ error: "forbidden" }), {
          status: 403,
        });
      }
      return new Response(JSON.stringify({ id: "some-id" }), { status: 200 });
    }

    throw new Error(`Unexpected fetch in test: ${method} ${url}`);
  };

  // Expose the list so tests can inspect which files were starred/unstarred.
  (mockFetch as unknown as Record<string, unknown>)["patchedFileIds"] =
    drivePatchedFileIds;

  return mockFetch;
}

// ─── Request helpers ──────────────────────────────────────────────────────

function makePostRequest(body?: unknown, jwt?: string): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (jwt) headers["Authorization"] = `Bearer ${jwt}`;
  return new Request("http://localhost/tenants", {
    method: "POST",
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function makeGetRequest(tenantId: string, jwt?: string): Request {
  const headers: Record<string, string> = {};
  if (jwt) headers["Authorization"] = `Bearer ${jwt}`;
  return new Request(`http://localhost/tenants/${tenantId}`, {
    method: "GET",
    headers,
  });
}

function makePatchRequest(
  tenantId: string,
  body?: unknown,
  jwt?: string,
): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (jwt) headers["Authorization"] = `Bearer ${jwt}`;
  return new Request(`http://localhost/tenants/${tenantId}`, {
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

Deno.test("integration: tenants OPTIONS — returns 200 with CORS headers", async () => {
  const res = await handleTenants(
    new Request("http://localhost/tenants", { method: "OPTIONS" }),
  );
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("Access-Control-Allow-Origin") !== null, true);
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /tenants
// ═══════════════════════════════════════════════════════════════════════════

// ─── 401 — no JWT ─────────────────────────────────────────────────────────

Deno.test("integration: POST /tenants — 401 when no JWT provided", async () => {
  const res = await handleTenants(
    makePostRequest({ property_id: "p", name: "João", cpf: "123.456.789-00" }),
  );
  assertEquals(res.status, 401);
  const body = await jsonBody(res) as Record<string, unknown>;
  assertEquals((body.error as Record<string, string>).code, "UNAUTHORIZED");
});

// ─── 401 — invalid JWT ────────────────────────────────────────────────────

Deno.test("integration: POST /tenants — 401 when JWT is invalid", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ authUser: null }) as typeof fetch;
  try {
    const res = await handleTenants(
      makePostRequest(
        { property_id: "p", name: "João", cpf: "123.456.789-00" },
        "bad.jwt",
      ),
    );
    assertEquals(res.status, 401);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 400 — missing property_id ────────────────────────────────────────────

Deno.test("integration: POST /tenants — 400 when property_id is missing", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handleTenants(
      makePostRequest({ name: "João", cpf: "123.456.789-00" }, "valid.jwt"),
    );
    assertEquals(res.status, 400);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals(
      (body.error as Record<string, string>).code,
      "MISSING_PROPERTY_ID",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 400 — missing name ───────────────────────────────────────────────────

Deno.test("integration: POST /tenants — 400 when name is missing", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handleTenants(
      makePostRequest(
        { property_id: MOCK_PROPERTY_ID, cpf: "123.456.789-00" },
        "valid.jwt",
      ),
    );
    assertEquals(res.status, 400);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals((body.error as Record<string, string>).code, "MISSING_NAME");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 400 — invalid CPF ────────────────────────────────────────────────────

Deno.test("integration: POST /tenants — 400 when CPF format is invalid", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handleTenants(
      makePostRequest(
        {
          property_id: MOCK_PROPERTY_ID,
          name: "João",
          cpf: "12345678900",
        },
        "valid.jwt",
      ),
    );
    assertEquals(res.status, 400);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals((body.error as Record<string, string>).code, "INVALID_CPF");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 400 — invalid whatsapp ───────────────────────────────────────────────

Deno.test("integration: POST /tenants — 400 when whatsapp format is invalid", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handleTenants(
      makePostRequest(
        {
          property_id: MOCK_PROPERTY_ID,
          name: "João",
          cpf: "123.456.789-00",
          whatsapp: "not-a-phone",
        },
        "valid.jwt",
      ),
    );
    assertEquals(res.status, 400);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals(
      (body.error as Record<string, string>).code,
      "INVALID_WHATSAPP",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 404 — landlord not found ─────────────────────────────────────────────

Deno.test("integration: POST /tenants — 404 when landlord row does not exist", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ landlord: null }) as typeof fetch;
  try {
    const res = await handleTenants(
      makePostRequest(
        { property_id: MOCK_PROPERTY_ID, name: "João", cpf: "123.456.789-00" },
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

// ─── 404 — property not found ─────────────────────────────────────────────

Deno.test("integration: POST /tenants — 404 when property not found or belongs to another landlord", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ property: null }) as typeof fetch;
  try {
    const res = await handleTenants(
      makePostRequest(
        {
          property_id: "nonexistent-prop",
          name: "João",
          cpf: "123.456.789-00",
        },
        "valid.jwt",
      ),
    );
    assertEquals(res.status, 404);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals(
      (body.error as Record<string, string>).code,
      "PROPERTY_NOT_FOUND",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 502 — Google token refresh failure ──────────────────────────────────

Deno.test("integration: POST /tenants — 502 when Google token refresh fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ googleTokenFail: true }) as typeof fetch;
  try {
    const res = await handleTenants(
      makePostRequest(
        { property_id: MOCK_PROPERTY_ID, name: "João", cpf: "123.456.789-00" },
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

Deno.test("integration: POST /tenants — 502 when Drive folder creation fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ driveFolderFail: true }) as typeof fetch;
  try {
    const res = await handleTenants(
      makePostRequest(
        { property_id: MOCK_PROPERTY_ID, name: "João", cpf: "123.456.789-00" },
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

// ─── 502 — Drive star failure ─────────────────────────────────────────────

Deno.test("integration: POST /tenants — 502 when Drive star fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ driveStarFail: true }) as typeof fetch;
  try {
    const res = await handleTenants(
      makePostRequest(
        { property_id: MOCK_PROPERTY_ID, name: "João", cpf: "123.456.789-00" },
        "valid.jwt",
      ),
    );
    assertEquals(res.status, 502);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals(
      (body.error as Record<string, string>).code,
      "DRIVE_STAR_FAILED",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 500 — DB insert failure ──────────────────────────────────────────────

Deno.test("integration: POST /tenants — 500 when DB insert fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ dbInsertFail: true }) as typeof fetch;
  try {
    const res = await handleTenants(
      makePostRequest(
        { property_id: MOCK_PROPERTY_ID, name: "João", cpf: "123.456.789-00" },
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

// ─── 201 — happy path (house, no previous tenant) ────────────────────────

Deno.test("integration: POST /tenants — 201 creates tenant folder and row for house property", async () => {
  const originalFetch = globalThis.fetch;
  const mockFetch = buildMockFetch({});
  globalThis.fetch = mockFetch as typeof fetch;
  try {
    const res = await handleTenants(
      makePostRequest(
        {
          property_id: MOCK_PROPERTY_ID,
          name: "Maria Souza",
          cpf: "123.456.789-00",
          whatsapp: "+5511987654321",
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

// ─── 201 — happy path (apartment) ────────────────────────────────────────

Deno.test("integration: POST /tenants — 201 creates tenant folder inside apartment property folder", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ property: MOCK_PROPERTY_APARTMENT }) as typeof fetch;
  try {
    const res = await handleTenants(
      makePostRequest(
        {
          property_id: MOCK_PROPERTY_APARTMENT.id,
          name: "Carlos Lima",
          cpf: "123.456.789-00",
        },
        "valid.jwt",
      ),
    );
    assertEquals(res.status, 201);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals(typeof body.id, "string");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 201 — happy path (replacing tenant: previous folder unstarred) ───────

Deno.test("integration: POST /tenants — 201 unstars previous tenant folder when replacing tenant", async () => {
  const originalFetch = globalThis.fetch;
  const mockFetch = buildMockFetch({
    property: MOCK_PROPERTY_WITH_PREV_TENANT,
  });
  globalThis.fetch = mockFetch as typeof fetch;
  try {
    const res = await handleTenants(
      makePostRequest(
        {
          property_id: MOCK_PROPERTY_ID,
          name: "Ana Lima",
          cpf: "123.456.789-00",
        },
        "valid.jwt",
      ),
    );
    assertEquals(res.status, 201);
    // Verify that the previous tenant folder was unstarred (PATCHed)
    const patchedIds = (
      mockFetch as unknown as Record<string, string[]>
    )["patchedFileIds"];
    // Should include at least two PATCH calls: star new + unstar old
    assertEquals(patchedIds.includes(MOCK_PREV_TENANT_FOLDER), true);
    assertEquals(patchedIds.includes(NEW_TENANT_FOLDER_ID), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 201 — whatsapp optional (absent) ────────────────────────────────────

Deno.test("integration: POST /tenants — 201 succeeds without whatsapp field", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handleTenants(
      makePostRequest(
        { property_id: MOCK_PROPERTY_ID, name: "Pedro Costa", cpf: "111.222.333-44" },
        "valid.jwt",
      ),
    );
    assertEquals(res.status, 201);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── CORS headers ─────────────────────────────────────────────────────────

Deno.test("integration: POST /tenants — success response includes CORS headers", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handleTenants(
      makePostRequest(
        { property_id: MOCK_PROPERTY_ID, name: "João", cpf: "123.456.789-00" },
        "valid.jwt",
      ),
    );
    assertEquals(res.headers.get("Access-Control-Allow-Origin") !== null, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /tenants/:id
// ═══════════════════════════════════════════════════════════════════════════

// ─── 401 — no JWT ─────────────────────────────────────────────────────────

Deno.test("integration: GET /tenants/:id — 401 when no JWT provided", async () => {
  const res = await handleTenants(makeGetRequest("tenant-uuid-1"));
  assertEquals(res.status, 401);
  const body = await jsonBody(res) as Record<string, unknown>;
  assertEquals((body.error as Record<string, string>).code, "UNAUTHORIZED");
});

// ─── 404 — tenant not found ───────────────────────────────────────────────

Deno.test("integration: GET /tenants/:id — 404 when tenant not found or belongs to another landlord", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ tenantFull: null }) as typeof fetch;
  try {
    const res = await handleTenants(
      makeGetRequest("nonexistent-tenant", "valid.jwt"),
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

// ─── 200 — happy path ─────────────────────────────────────────────────────

Deno.test("integration: GET /tenants/:id — 200 returns tenant data", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ tenantFull: MOCK_TENANT_FULL }) as typeof fetch;
  try {
    const res = await handleTenants(
      makeGetRequest(MOCK_TENANT_FULL.id, "valid.jwt"),
    );
    assertEquals(res.status, 200);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals(body.id, MOCK_TENANT_FULL.id);
    assertEquals(body.name, MOCK_TENANT_FULL.name);
    assertEquals(body.cpf, MOCK_TENANT_FULL.cpf);
    assertEquals(body.whatsapp, MOCK_TENANT_FULL.whatsapp);
    assertEquals(body.property_id, MOCK_TENANT_FULL.property_id);
    assertEquals(body.drive_folder_id, MOCK_TENANT_FULL.drive_folder_id);
    assertEquals(body.created_at, MOCK_TENANT_FULL.created_at);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── CORS headers ─────────────────────────────────────────────────────────

Deno.test("integration: GET /tenants/:id — response includes CORS headers", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ tenantFull: MOCK_TENANT_FULL }) as typeof fetch;
  try {
    const res = await handleTenants(
      makeGetRequest(MOCK_TENANT_FULL.id, "valid.jwt"),
    );
    assertEquals(res.headers.get("Access-Control-Allow-Origin") !== null, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// PATCH /tenants/:id
// ═══════════════════════════════════════════════════════════════════════════

// ─── 401 — no JWT ─────────────────────────────────────────────────────────

Deno.test("integration: PATCH /tenants/:id — 401 when no JWT provided", async () => {
  const res = await handleTenants(
    makePatchRequest("tenant-uuid-1", { whatsapp: "+5511999990000" }),
  );
  assertEquals(res.status, 401);
  const body = await jsonBody(res) as Record<string, unknown>;
  assertEquals((body.error as Record<string, string>).code, "UNAUTHORIZED");
});

// ─── 400 — no updatable field ─────────────────────────────────────────────

Deno.test("integration: PATCH /tenants/:id — 400 when no updatable field provided", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handleTenants(
      makePatchRequest("tenant-uuid-1", {}, "valid.jwt"),
    );
    assertEquals(res.status, 400);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals(
      (body.error as Record<string, string>).code,
      "MISSING_FIELDS",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 400 — invalid whatsapp ───────────────────────────────────────────────

Deno.test("integration: PATCH /tenants/:id — 400 when whatsapp format is invalid", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handleTenants(
      makePatchRequest(
        "tenant-uuid-1",
        { whatsapp: "not-a-phone" },
        "valid.jwt",
      ),
    );
    assertEquals(res.status, 400);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals(
      (body.error as Record<string, string>).code,
      "INVALID_WHATSAPP",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 404 — tenant not found ───────────────────────────────────────────────

Deno.test("integration: PATCH /tenants/:id — 404 when tenant not found or belongs to another landlord", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ tenantExisting: null, tenantFull: null }) as typeof fetch;
  try {
    const res = await handleTenants(
      makePatchRequest(
        "nonexistent-tenant",
        { whatsapp: "+5511999990000" },
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

// ─── 200 — happy path ─────────────────────────────────────────────────────

Deno.test("integration: PATCH /tenants/:id — 200 updates whatsapp successfully", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({
    tenantExisting: { id: MOCK_TENANT_FULL.id },
    tenantFull: MOCK_TENANT_FULL,
  }) as typeof fetch;
  try {
    const res = await handleTenants(
      makePatchRequest(
        MOCK_TENANT_FULL.id,
        { whatsapp: "+5511888880000" },
        "valid.jwt",
      ),
    );
    assertEquals(res.status, 200);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals(body.id, MOCK_TENANT_FULL.id);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 200 — set whatsapp to null ───────────────────────────────────────────

Deno.test("integration: PATCH /tenants/:id — 200 clears whatsapp when null sent", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({
    tenantExisting: { id: MOCK_TENANT_FULL.id },
    tenantFull: MOCK_TENANT_FULL,
  }) as typeof fetch;
  try {
    const res = await handleTenants(
      makePatchRequest(
        MOCK_TENANT_FULL.id,
        { whatsapp: null },
        "valid.jwt",
      ),
    );
    assertEquals(res.status, 200);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals(body.id, MOCK_TENANT_FULL.id);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── CORS headers ─────────────────────────────────────────────────────────

Deno.test("integration: PATCH /tenants/:id — success response includes CORS headers", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({
    tenantExisting: { id: MOCK_TENANT_FULL.id },
    tenantFull: MOCK_TENANT_FULL,
  }) as typeof fetch;
  try {
    const res = await handleTenants(
      makePatchRequest(
        MOCK_TENANT_FULL.id,
        { whatsapp: "+5511888880000" },
        "valid.jwt",
      ),
    );
    assertEquals(res.headers.get("Access-Control-Allow-Origin") !== null, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 405 — wrong method on /tenants (no id) ──────────────────────────────

Deno.test("integration: tenants — 405 when DELETE is used on /tenants", async () => {
  const res = await handleTenants(
    new Request("http://localhost/tenants", { method: "DELETE" }),
  );
  assertEquals(res.status, 405);
  const body = await jsonBody(res) as Record<string, unknown>;
  assertEquals(
    (body.error as Record<string, string>).code,
    "METHOD_NOT_ALLOWED",
  );
});
