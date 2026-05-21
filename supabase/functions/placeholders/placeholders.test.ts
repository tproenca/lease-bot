// integration: POST /placeholders + DELETE /placeholders/:name
//
// Tests call handlePlaceholders() directly. Network calls to Supabase Auth,
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

import { handlePlaceholders } from "./index.ts";

// ─── Fixtures ─────────────────────────────────────────────────────────────

const MOCK_USER = {
  id: "user-uuid-landlord",
  email: "landlord@example.com",
  user_metadata: {},
};

const MOCK_PLACEHOLDER_ID = "placeholder-uuid-1";

const VALID_BODY = {
  name: "nome do inquilino",
  required: true,
  format: "text",
};

const MOCK_LANDLORD = {
  google_refresh_token: "mock-refresh-token",
  templates_folder_id: "templates-folder-id",
};

// ─── Fetch stub builder ──────────────────────────────────────────────────

type MockFetchOpts = {
  authUser?: typeof MOCK_USER | null;
  placeholderInsert?: { id: string } | null;
  dbInsertFail?: boolean;
  duplicateName?: boolean;
  dbDeleteFail?: boolean;
  landlord?: typeof MOCK_LANDLORD | null;
  googleTokenFail?: boolean;
};

function buildMockFetch(opts: MockFetchOpts) {
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

    // PostgREST: placeholders
    if (url.includes("/rest/v1/placeholders")) {
      if (method === "POST") {
        if (opts.duplicateName) {
          return new Response(
            JSON.stringify({ message: "unique violation", code: "23505" }),
            { status: 409 },
          );
        }
        if (opts.dbInsertFail || opts.placeholderInsert === null) {
          return new Response(
            JSON.stringify({ message: "db error", code: "PGRST000" }),
            { status: 500 },
          );
        }
        return new Response(
          JSON.stringify([
            opts.placeholderInsert ?? { id: MOCK_PLACEHOLDER_ID },
          ]),
          { status: 201 },
        );
      }
      if (method === "GET") {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (method === "DELETE") {
        if (opts.dbDeleteFail) {
          return new Response(
            JSON.stringify({ message: "db error", code: "PGRST000" }),
            { status: 500 },
          );
        }
        return new Response(JSON.stringify([]), { status: 200 });
      }
    }

    // PostgREST: landlords (for Guia regeneration)
    if (url.includes("/rest/v1/landlords")) {
      if (opts.landlord === null) {
        return new Response(JSON.stringify(null), { status: 200 });
      }
      return new Response(
        JSON.stringify(opts.landlord ?? MOCK_LANDLORD),
        { status: 200 },
      );
    }

    // Google token endpoint (for Guia regeneration)
    if (url.includes("oauth2.googleapis.com/token")) {
      if (opts.googleTokenFail) {
        return new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
        });
      }
      return new Response(
        JSON.stringify({ access_token: "mock-access-token", expires_in: 3600 }),
        { status: 200 },
      );
    }

    // Google Drive — list files (for upsertPlaceholderList)
    if (
      url.includes("www.googleapis.com/drive/v3/files") &&
      method === "GET"
    ) {
      return new Response(JSON.stringify({ files: [] }), { status: 200 });
    }

    // Google Drive — create (multipart upload for Guia)
    if (
      url.includes("www.googleapis.com/upload/drive/v3/files") &&
      method === "POST"
    ) {
      return new Response(JSON.stringify({ id: "guia-file-id" }), {
        status: 200,
      });
    }

    // Google Drive — update (PATCH for Guia)
    if (
      url.includes("www.googleapis.com/upload/drive/v3/files") &&
      method === "PATCH"
    ) {
      return new Response(JSON.stringify({ id: "guia-file-id" }), {
        status: 200,
      });
    }

    throw new Error(`Unexpected fetch in test: ${method} ${url}`);
  };
}

// ─── Request helpers ──────────────────────────────────────────────────────

function makePostRequest(body?: unknown, jwt?: string): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (jwt) headers["Authorization"] = `Bearer ${jwt}`;
  // Body is always an array; wrap a single object if needed.
  const payload = body === undefined
    ? undefined
    : Array.isArray(body) ? body : [body];
  return new Request("http://localhost/placeholders", {
    method: "POST",
    headers,
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
  });
}

function makeDeleteRequest(name: string, jwt?: string): Request {
  const headers: Record<string, string> = {};
  if (jwt) headers["Authorization"] = `Bearer ${jwt}`;
  return new Request(
    `http://localhost/placeholders/${encodeURIComponent(name)}`,
    { method: "DELETE", headers },
  );
}

async function jsonBody(res: Response): Promise<unknown> {
  return await res.json();
}

// ═══════════════════════════════════════════════════════════════════════════
// OPTIONS / CORS
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("integration: placeholders OPTIONS — returns 200 with CORS headers", async () => {
  const res = await handlePlaceholders(
    new Request("http://localhost/placeholders", { method: "OPTIONS" }),
  );
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("Access-Control-Allow-Origin") !== null, true);
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /placeholders
// ═══════════════════════════════════════════════════════════════════════════

// ─── 401 — no JWT ─────────────────────────────────────────────────────────

Deno.test("integration: POST /placeholders — 401 when no JWT provided", async () => {
  const res = await handlePlaceholders(makePostRequest(VALID_BODY));
  assertEquals(res.status, 401);
  const body = await jsonBody(res) as Record<string, unknown>;
  assertEquals((body.error as Record<string, string>).code, "UNAUTHORIZED");
});

// ─── 401 — invalid JWT ────────────────────────────────────────────────────

Deno.test("integration: POST /placeholders — 401 when JWT is invalid", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ authUser: null }) as typeof fetch;
  try {
    const res = await handlePlaceholders(
      makePostRequest(VALID_BODY, "bad.jwt"),
    );
    assertEquals(res.status, 401);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals((body.error as Record<string, string>).code, "UNAUTHORIZED");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 400 — invalid format ─────────────────────────────────────────────────

Deno.test("integration: POST /placeholders — 400 when format is invalid", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handlePlaceholders(
      makePostRequest(
        { ...VALID_BODY, format: "invalid_format" },
        "valid.jwt",
      ),
    );
    assertEquals(res.status, 400);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals((body.error as Record<string, string>).code, "INVALID_FORMAT");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 400 — missing name ───────────────────────────────────────────────────

Deno.test("integration: POST /placeholders — 400 when name is missing", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const { name: _omit, ...bodyWithout } = VALID_BODY;
    const res = await handlePlaceholders(
      makePostRequest(bodyWithout, "valid.jwt"),
    );
    assertEquals(res.status, 400);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals(
      (body.error as Record<string, string>).code,
      "INVALID_REQUEST",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 400 — empty array ───────────────────────────────────────────────────

Deno.test("integration: POST /placeholders — 400 when body is empty array", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handlePlaceholders(
      makePostRequest([], "valid.jwt"),
    );
    assertEquals(res.status, 400);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals(
      (body.error as Record<string, string>).code,
      "INVALID_REQUEST",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 409 — duplicate name ─────────────────────────────────────────────────

Deno.test("integration: POST /placeholders — 409 when name already exists", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ duplicateName: true }) as typeof fetch;
  try {
    const res = await handlePlaceholders(
      makePostRequest(VALID_BODY, "valid.jwt"),
    );
    assertEquals(res.status, 409);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals(
      (body.error as Record<string, string>).code,
      "DUPLICATE_PLACEHOLDER",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 201 — happy path ────────────────────────────────────────────────────

Deno.test("integration: POST /placeholders — 201 creates placeholders and returns ids", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handlePlaceholders(
      makePostRequest(VALID_BODY, "valid.jwt"),
    );
    assertEquals(res.status, 201);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals(Array.isArray(body.ids), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 201 — with optional fields ──────────────────────────────────────────

Deno.test("integration: POST /placeholders — 201 accepts optional fields", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handlePlaceholders(
      makePostRequest(
        {
          ...VALID_BODY,
          case: "maiúsculas",
          default: "valor padrão",
          derived_from: "outro placeholder",
          derived_formula: "fórmula de derivação",
        },
        "valid.jwt",
      ),
    );
    assertEquals(res.status, 201);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals(Array.isArray(body.ids), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// DELETE /placeholders/:name
// ═══════════════════════════════════════════════════════════════════════════

// ─── 401 — no JWT ─────────────────────────────────────────────────────────

Deno.test("integration: DELETE /placeholders/:name — 401 when no JWT provided", async () => {
  const res = await handlePlaceholders(makeDeleteRequest("nome do inquilino"));
  assertEquals(res.status, 401);
  const body = await jsonBody(res) as Record<string, unknown>;
  assertEquals((body.error as Record<string, string>).code, "UNAUTHORIZED");
});

// ─── 401 — invalid JWT ────────────────────────────────────────────────────

Deno.test("integration: DELETE /placeholders/:name — 401 when JWT is invalid", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ authUser: null }) as typeof fetch;
  try {
    const res = await handlePlaceholders(
      makeDeleteRequest("nome do inquilino", "bad.jwt"),
    );
    assertEquals(res.status, 401);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals((body.error as Record<string, string>).code, "UNAUTHORIZED");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 204 — happy path ────────────────────────────────────────────────────

Deno.test("integration: DELETE /placeholders/:name — 204 when placeholder exists", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handlePlaceholders(
      makeDeleteRequest("nome do inquilino", "valid.jwt"),
    );
    assertEquals(res.status, 204);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 204 — idempotent ────────────────────────────────────────────────────

Deno.test("integration: DELETE /placeholders/:name — 204 even when placeholder does not exist (idempotent)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handlePlaceholders(
      makeDeleteRequest("nonexistent", "valid.jwt"),
    );
    assertEquals(res.status, 204);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 204 — URL-encoded name ───────────────────────────────────────────────

Deno.test("integration: DELETE /placeholders/:name — 204 decodes URL-encoded name", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handlePlaceholders(
      makeDeleteRequest("nome do inquilino com espaços", "valid.jwt"),
    );
    assertEquals(res.status, 204);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
