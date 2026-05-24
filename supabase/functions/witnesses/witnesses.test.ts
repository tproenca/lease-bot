// unit: POST /witnesses
//
// Tests call handleWitnesses() directly. Network calls to Supabase Auth
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

import { handleWitnesses } from "./index.ts";

// ─── Fixtures ─────────────────────────────────────────────────────────────

const MOCK_USER = {
  id: "user-uuid-landlord",
  email: "landlord@example.com",
  user_metadata: {},
};

const MOCK_WITNESS_ID = "witness-uuid-1";

const VALID_BODY = {
  name: "Maria Testemunha",
  whatsapp: "+5511999990000",
};

// ─── Fetch stub builder ──────────────────────────────────────────────────

type MockFetchOpts = {
  authUser?: typeof MOCK_USER | null;
  witnessInsert?: { id: string } | null;
  dbInsertFail?: boolean;
  duplicateName?: boolean;
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

    // PostgREST: witnesses
    if (url.includes("/rest/v1/witnesses")) {
      if (method === "POST") {
        if (opts.duplicateName) {
          return new Response(
            JSON.stringify({ message: "unique violation", code: "23505" }),
            { status: 409 },
          );
        }
        if (opts.dbInsertFail || opts.witnessInsert === null) {
          return new Response(
            JSON.stringify({ message: "db error", code: "PGRST000" }),
            { status: 500 },
          );
        }
        return new Response(
          JSON.stringify(opts.witnessInsert ?? { id: MOCK_WITNESS_ID }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
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
  return new Request("http://localhost/witnesses", {
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

Deno.test("unit: witnesses OPTIONS — returns 200 with CORS headers", async () => {
  const res = await handleWitnesses(
    new Request("http://localhost/witnesses", { method: "OPTIONS" }),
  );
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("Access-Control-Allow-Origin") !== null, true);
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /witnesses
// ═══════════════════════════════════════════════════════════════════════════

// ─── 401 — no JWT ─────────────────────────────────────────────────────────

Deno.test("unit: POST /witnesses — 401 when no JWT provided", async () => {
  const res = await handleWitnesses(makePostRequest(VALID_BODY));
  assertEquals(res.status, 401);
  const body = await jsonBody(res) as Record<string, unknown>;
  assertEquals((body.error as Record<string, string>).code, "UNAUTHORIZED");
});

// ─── 401 — invalid JWT ────────────────────────────────────────────────────

Deno.test("unit: POST /witnesses — 401 when JWT is invalid", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ authUser: null }) as typeof fetch;
  try {
    const res = await handleWitnesses(makePostRequest(VALID_BODY, "bad.jwt"));
    assertEquals(res.status, 401);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals((body.error as Record<string, string>).code, "UNAUTHORIZED");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 400 — missing name ───────────────────────────────────────────────────

Deno.test("unit: POST /witnesses — 400 when name is missing", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const { name: _omit, ...bodyWithout } = VALID_BODY;
    const res = await handleWitnesses(
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

// ─── 400 — missing whatsapp ───────────────────────────────────────────────

Deno.test("unit: POST /witnesses — 400 when whatsapp is missing", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const { whatsapp: _omit, ...bodyWithout } = VALID_BODY;
    const res = await handleWitnesses(
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

// ─── 409 — duplicate name ─────────────────────────────────────────────────

Deno.test("unit: POST /witnesses — 409 when name already exists", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ duplicateName: true }) as typeof fetch;
  try {
    const res = await handleWitnesses(makePostRequest(VALID_BODY, "valid.jwt"));
    assertEquals(res.status, 409);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals(
      (body.error as Record<string, string>).code,
      "DUPLICATE_WITNESS",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 201 — happy path ────────────────────────────────────────────────────

Deno.test("unit: POST /witnesses — 201 creates witness and returns id", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handleWitnesses(
      makePostRequest(VALID_BODY, "valid.jwt"),
    );
    assertEquals(res.status, 201);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals(typeof body.id, "string");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── CORS headers on success ──────────────────────────────────────────────

Deno.test("unit: POST /witnesses — success response includes CORS headers", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handleWitnesses(
      makePostRequest(VALID_BODY, "valid.jwt"),
    );
    assertEquals(res.headers.get("Access-Control-Allow-Origin") !== null, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 405 — wrong method ───────────────────────────────────────────────────

Deno.test("unit: witnesses — 405 when GET is used on /witnesses", async () => {
  const res = await handleWitnesses(
    new Request("http://localhost/witnesses", { method: "GET" }),
  );
  assertEquals(res.status, 405);
  const body = await jsonBody(res) as Record<string, unknown>;
  assertEquals(
    (body.error as Record<string, string>).code,
    "METHOD_NOT_ALLOWED",
  );
});
