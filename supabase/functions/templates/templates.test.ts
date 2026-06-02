// unit: POST /templates + DELETE /templates/:id
//
// Tests call handleTemplates() directly. Network calls to Supabase Auth
// and PostgREST are intercepted via globalThis.fetch stubs.
// No real Supabase instance is needed.
//
// Test names follow the "unit:" / "integration:" prefix convention.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

// Set required env vars before importing the handler so requireEnv() doesn't throw.
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_ANON_KEY", "test-anon-key");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
Deno.env.set("GOOGLE_CLIENT_ID", "test-google-client-id");
Deno.env.set("GOOGLE_CLIENT_SECRET", "test-google-client-secret");

import { handleTemplates } from "./index.ts";

// ─── Fixtures ─────────────────────────────────────────────────────────────

const MOCK_USER = {
  id: "user-uuid-landlord",
  email: "landlord@example.com",
  user_metadata: {},
};

const MOCK_TEMPLATE_ID = "template-uuid-1";

const VALID_BODY = {
  drive_file_id: "drive-file-id-1",
  name: "Contrato de Locação",
  use_case: "initial",
  placeholder_names: ["nome do inquilino", "cpf do inquilino"],
  property_types: ["apartment", "house"],
};

// ─── Fetch stub builder ──────────────────────────────────────────────────

type MockFetchOpts = {
  authUser?: typeof MOCK_USER | null;
  templateInsert?: { id: string } | null;
  templateExisting?: { id: string } | null;
  dbInsertFail?: boolean;
  mappingInsertFail?: boolean;
  mappingDeleteFail?: boolean;
  templateDeleteFail?: boolean;
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

    // PostgREST: templates
    if (url.includes("/rest/v1/templates")) {
      if (method === "POST") {
        if (opts.dbInsertFail || opts.templateInsert === null) {
          return new Response(
            JSON.stringify({ message: "db error", code: "PGRST000" }),
            { status: 500 },
          );
        }
        return new Response(
          JSON.stringify(opts.templateInsert ?? { id: MOCK_TEMPLATE_ID }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }
      if (method === "GET") {
        if (opts.templateExisting === null) {
          return new Response(JSON.stringify(null), { status: 200 });
        }
        return new Response(
          JSON.stringify(opts.templateExisting ?? { id: MOCK_TEMPLATE_ID }),
          { status: 200 },
        );
      }
      if (method === "DELETE") {
        if (opts.templateDeleteFail) {
          return new Response(
            JSON.stringify({ message: "db error", code: "PGRST000" }),
            { status: 500 },
          );
        }
        return new Response(JSON.stringify([]), { status: 200 });
      }
    }

    // PostgREST: property_type_templates
    if (url.includes("/rest/v1/property_type_templates")) {
      if (method === "POST") {
        if (opts.mappingInsertFail) {
          return new Response(
            JSON.stringify({ message: "db error", code: "PGRST000" }),
            { status: 500 },
          );
        }
        return new Response(JSON.stringify([]), { status: 201 });
      }
      if (method === "DELETE") {
        if (opts.mappingDeleteFail) {
          return new Response(
            JSON.stringify({ message: "db error", code: "PGRST000" }),
            { status: 500 },
          );
        }
        return new Response(JSON.stringify([]), { status: 200 });
      }
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
  return new Request("http://localhost/templates", {
    method: "POST",
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function makeDeleteRequest(id: string, jwt?: string): Request {
  const headers: Record<string, string> = {};
  if (jwt) headers["Authorization"] = `Bearer ${jwt}`;
  return new Request(`http://localhost/templates/${id}`, {
    method: "DELETE",
    headers,
  });
}

async function jsonBody(res: Response): Promise<unknown> {
  return await res.json();
}

// ═══════════════════════════════════════════════════════════════════════════
// OPTIONS / CORS
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: templates OPTIONS — returns 200 with CORS headers", async () => {
  const res = await handleTemplates(
    new Request("http://localhost/templates", { method: "OPTIONS" }),
  );
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("Access-Control-Allow-Origin") !== null, true);
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /templates
// ═══════════════════════════════════════════════════════════════════════════

// ─── 401 — no JWT ─────────────────────────────────────────────────────────

Deno.test("unit: POST /templates — 401 when no JWT provided", async () => {
  const res = await handleTemplates(makePostRequest(VALID_BODY));
  assertEquals(res.status, 401);
  const body = await jsonBody(res) as Record<string, unknown>;
  assertEquals((body.error as Record<string, string>).code, "UNAUTHORIZED");
});

// ─── 401 — invalid JWT ────────────────────────────────────────────────────

Deno.test("unit: POST /templates — 401 when JWT is invalid", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ authUser: null }) as typeof fetch;
  try {
    const res = await handleTemplates(makePostRequest(VALID_BODY, "bad.jwt"));
    assertEquals(res.status, 401);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals((body.error as Record<string, string>).code, "UNAUTHORIZED");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 400 — missing drive_file_id ─────────────────────────────────────────

Deno.test("unit: POST /templates — 400 when drive_file_id is missing", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const { drive_file_id: _omit, ...bodyWithout } = VALID_BODY;
    const res = await handleTemplates(
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

// ─── 400 — invalid property_type ─────────────────────────────────────────

Deno.test("unit: POST /templates — 400 when property_type is invalid", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handleTemplates(
      makePostRequest(
        { ...VALID_BODY, property_types: ["invalid_type"] },
        "valid.jwt",
      ),
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

// ─── 201 — happy path ────────────────────────────────────────────────────

Deno.test("unit: POST /templates — 201 creates template and returns id", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handleTemplates(makePostRequest(VALID_BODY, "valid.jwt"));
    assertEquals(res.status, 201);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals(typeof body.id, "string");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── CORS headers on success ──────────────────────────────────────────────

Deno.test("unit: POST /templates — success response includes CORS headers", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handleTemplates(makePostRequest(VALID_BODY, "valid.jwt"));
    assertEquals(res.headers.get("Access-Control-Allow-Origin") !== null, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// DELETE /templates/:id
// ═══════════════════════════════════════════════════════════════════════════

// ─── 401 — no JWT ─────────────────────────────────────────────────────────

Deno.test("unit: DELETE /templates/:id — 401 when no JWT provided", async () => {
  const res = await handleTemplates(makeDeleteRequest(MOCK_TEMPLATE_ID));
  assertEquals(res.status, 401);
  const body = await jsonBody(res) as Record<string, unknown>;
  assertEquals((body.error as Record<string, string>).code, "UNAUTHORIZED");
});

// ─── 401 — invalid JWT ────────────────────────────────────────────────────

Deno.test("unit: DELETE /templates/:id — 401 when JWT is invalid", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ authUser: null }) as typeof fetch;
  try {
    const res = await handleTemplates(
      makeDeleteRequest(MOCK_TEMPLATE_ID, "bad.jwt"),
    );
    assertEquals(res.status, 401);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals((body.error as Record<string, string>).code, "UNAUTHORIZED");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 404 — template not found ─────────────────────────────────────────────

Deno.test("unit: DELETE /templates/:id — 404 when template not found", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({
    templateExisting: null,
  }) as typeof fetch;
  try {
    const res = await handleTemplates(
      makeDeleteRequest("nonexistent-id", "valid.jwt"),
    );
    assertEquals(res.status, 404);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals(
      (body.error as Record<string, string>).code,
      "TEMPLATE_NOT_FOUND",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 204 — happy path ────────────────────────────────────────────────────

Deno.test("unit: DELETE /templates/:id — 204 when template deleted successfully", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handleTemplates(
      makeDeleteRequest(MOCK_TEMPLATE_ID, "valid.jwt"),
    );
    assertEquals(res.status, 204);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
