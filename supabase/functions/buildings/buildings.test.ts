// integration: POST /buildings
//
// Tests call handleBuildings() directly. Network calls to Supabase Auth,
// PostgREST, and the Google APIs are intercepted via globalThis.fetch stubs.
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

import { handleBuildings } from "./index.ts";

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

const MOCK_BUILDING_INSERT = {
  id: "bldg-uuid-new",
  drive_folder_id: "bldg-drive-folder-new",
};

const MOCK_ACCESS_TOKEN = "mock-access-token";

// ─── Fetch stub builder ──────────────────────────────────────────────────

function buildMockFetch(opts: {
  authUser?: typeof MOCK_USER | null;
  landlord?: typeof MOCK_LANDLORD | null;
  googleTokenFail?: boolean;
  driveFolderFail?: boolean;
  dbInsertFail?: boolean;
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

    // PostgREST: landlords (service client — no auth bearer, uses service key)
    if (url.includes("/rest/v1/landlords")) {
      if (opts.landlord === null) {
        return new Response(JSON.stringify(null), { status: 200 });
      }
      return new Response(
        JSON.stringify(opts.landlord ?? MOCK_LANDLORD),
        { status: 200 },
      );
    }

    // PostgREST: buildings INSERT (user client)
    // PostgREST returns an array when Prefer: return=representation is set.
    // The Supabase JS .single() unwraps the first element.
    if (url.includes("/rest/v1/buildings")) {
      if (opts.dbInsertFail) {
        return new Response(
          JSON.stringify({ message: "db error", code: "PGRST000" }),
          { status: 500 },
        );
      }
      return new Response(
        JSON.stringify([MOCK_BUILDING_INSERT]),
        { status: 201 },
      );
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

    // Google Drive folder search (findDriveFolderByName)
    if (url.includes("www.googleapis.com/drive/v3/files") && !init?.method) {
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
      url.includes("www.googleapis.com/drive/v3/files") &&
      (init as RequestInit | undefined)?.method === "POST"
    ) {
      if (opts.driveFolderFail) {
        return new Response(JSON.stringify({ error: "quota exceeded" }), {
          status: 403,
        });
      }
      return new Response(
        JSON.stringify({ id: MOCK_BUILDING_INSERT.drive_folder_id }),
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
  return new Request("http://localhost/buildings", {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function jsonBody(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

// ─── 401 — no JWT ─────────────────────────────────────────────────────────

Deno.test("integration: POST /buildings — 401 when no JWT provided", async () => {
  const res = await handleBuildings(
    makeRequest({ name: "Edifício A", address: "Rua A, 1" }),
  );
  assertEquals(res.status, 401);
  const body = await jsonBody(res);
  assertEquals((body.error as Record<string, string>).code, "UNAUTHORIZED");
});

// ─── 401 — invalid JWT ────────────────────────────────────────────────────

Deno.test("integration: POST /buildings — 401 when JWT is invalid", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ authUser: null }) as typeof fetch;
  try {
    const res = await handleBuildings(
      makeRequest({ name: "Edifício A", address: "Rua A, 1" }, "bad.jwt"),
    );
    assertEquals(res.status, 401);
    const body = await jsonBody(res);
    assertEquals((body.error as Record<string, string>).code, "UNAUTHORIZED");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 400 — missing name ───────────────────────────────────────────────────

Deno.test("integration: POST /buildings — 400 when name is missing", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handleBuildings(
      makeRequest({ address: "Rua A, 1" }, "valid.jwt"),
    );
    assertEquals(res.status, 400);
    const body = await jsonBody(res);
    assertEquals((body.error as Record<string, string>).code, "MISSING_NAME");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 400 — missing address ────────────────────────────────────────────────

Deno.test("integration: POST /buildings — 400 when address is missing", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handleBuildings(
      makeRequest({ name: "Edifício A" }, "valid.jwt"),
    );
    assertEquals(res.status, 400);
    const body = await jsonBody(res);
    assertEquals(
      (body.error as Record<string, string>).code,
      "MISSING_ADDRESS",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 400 — empty name ─────────────────────────────────────────────────────

Deno.test("integration: POST /buildings — 400 when name is empty string", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handleBuildings(
      makeRequest({ name: "  ", address: "Rua A, 1" }, "valid.jwt"),
    );
    assertEquals(res.status, 400);
    const body = await jsonBody(res);
    assertEquals((body.error as Record<string, string>).code, "MISSING_NAME");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 404 — landlord not found ─────────────────────────────────────────────

Deno.test("integration: POST /buildings — 404 when landlord row does not exist", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ landlord: null }) as typeof fetch;
  try {
    const res = await handleBuildings(
      makeRequest({ name: "Edifício A", address: "Rua A, 1" }, "valid.jwt"),
    );
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

// ─── 502 — Google auth failure ────────────────────────────────────────────

Deno.test("integration: POST /buildings — 502 when Google token refresh fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ googleTokenFail: true }) as typeof fetch;
  try {
    const res = await handleBuildings(
      makeRequest({ name: "Edifício A", address: "Rua A, 1" }, "valid.jwt"),
    );
    assertEquals(res.status, 502);
    const body = await jsonBody(res);
    assertEquals(
      (body.error as Record<string, string>).code,
      "GOOGLE_AUTH_FAILED",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 502 — Drive folder creation failure ─────────────────────────────────

Deno.test("integration: POST /buildings — 502 when Drive folder creation fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ driveFolderFail: true }) as typeof fetch;
  try {
    const res = await handleBuildings(
      makeRequest({ name: "Edifício A", address: "Rua A, 1" }, "valid.jwt"),
    );
    assertEquals(res.status, 502);
    const body = await jsonBody(res);
    assertEquals(
      (body.error as Record<string, string>).code,
      "DRIVE_CREATE_FOLDER_FAILED",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 201 — happy path ─────────────────────────────────────────────────────

Deno.test("integration: POST /buildings — 201 creates building and returns id + drive_folder_id", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handleBuildings(
      makeRequest({ name: "Edifício A", address: "Rua A, 1" }, "valid.jwt"),
    );
    assertEquals(res.status, 201);
    const body = await jsonBody(res);
    assertEquals(typeof body.id, "string");
    assertEquals(typeof body.drive_folder_id, "string");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── CORS headers on success ──────────────────────────────────────────────

Deno.test("integration: POST /buildings — success response includes CORS headers", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handleBuildings(
      makeRequest({ name: "Edifício A", address: "Rua A, 1" }, "valid.jwt"),
    );
    assertEquals(res.headers.get("Access-Control-Allow-Origin") !== null, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── CORS headers on error ────────────────────────────────────────────────

Deno.test("integration: POST /buildings — error response includes CORS headers", async () => {
  const res = await handleBuildings(
    makeRequest({ name: "Edifício A", address: "Rua A, 1" }),
  );
  assertEquals(res.headers.get("Access-Control-Allow-Origin") !== null, true);
});

// ─── OPTIONS preflight ────────────────────────────────────────────────────

Deno.test("integration: POST /buildings — OPTIONS returns 200 with CORS headers", async () => {
  const res = await handleBuildings(
    makeRequest(undefined, undefined, "OPTIONS"),
  );
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("Access-Control-Allow-Origin") !== null, true);
});

// ─── 405 — wrong method ───────────────────────────────────────────────────

Deno.test("integration: POST /buildings — 405 when GET is used", async () => {
  const res = await handleBuildings(makeRequest(undefined, undefined, "GET"));
  assertEquals(res.status, 405);
  const body = await jsonBody(res);
  assertEquals(
    (body.error as Record<string, string>).code,
    "METHOD_NOT_ALLOWED",
  );
});

// ─── idempotent folder reuse ──────────────────────────────────────────────

Deno.test("integration: POST /buildings — reuses existing Drive folder when name already exists", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({
    existingDriveFolder: "already-existing-folder-id",
  }) as typeof fetch;
  try {
    const res = await handleBuildings(
      makeRequest({ name: "Edifício A", address: "Rua A, 1" }, "valid.jwt"),
    );
    assertEquals(res.status, 201);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
