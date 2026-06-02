// unit: POST /documents/generate
//
// Unit tests cover the pure helper functions (applyCase, substituteTokens)
// and the handler via globalThis.fetch stubs (no real Supabase instance needed).
// Real integration tests (against a live local Supabase DB) live in
// generate.integration.test.ts and require `supabase start`.
//
// Test names follow the "unit:" / "integration:" prefix convention.

import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

// Set required env vars before importing the handler so requireEnv() doesn't throw.
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_ANON_KEY", "test-anon-key");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
Deno.env.set("GOOGLE_CLIENT_ID", "test-google-client-id");
Deno.env.set("GOOGLE_CLIENT_SECRET", "test-google-client-secret");

import {
  applyCase,
  handleGenerateDocuments,
  substituteTokens,
} from "./index.ts";

// ═══════════════════════════════════════════════════════════════════════════
// unit: applyCase
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: applyCase — null case returns value unchanged", () => {
  assertEquals(applyCase("hello world", null), "hello world");
});

Deno.test("unit: applyCase — undefined case returns value unchanged", () => {
  assertEquals(applyCase("hello world", undefined), "hello world");
});

Deno.test("unit: applyCase — maiúsculas converts to UPPERCASE", () => {
  assertEquals(applyCase("joão silva", "maiúsculas"), "JOÃO SILVA");
});

Deno.test("unit: applyCase — minúsculas converts to lowercase", () => {
  assertEquals(applyCase("JOÃO SILVA", "minúsculas"), "joão silva");
});

Deno.test("unit: applyCase — título capitalises first letter of each word", () => {
  assertEquals(applyCase("rua das flores", "título"), "Rua Das Flores");
});

Deno.test("unit: applyCase — título handles already-mixed case", () => {
  assertEquals(applyCase("RUA DAS flores", "título"), "Rua Das Flores");
});

Deno.test("unit: applyCase — frase capitalises first letter of string only", () => {
  assertEquals(applyCase("rua das flores", "frase"), "Rua das flores");
});

Deno.test("unit: applyCase — frase lowercases rest of string", () => {
  assertEquals(applyCase("RUA DAS FLORES", "frase"), "Rua das flores");
});

Deno.test("unit: applyCase — unknown case value returns value unchanged", () => {
  assertEquals(applyCase("hello", "unknown-transform"), "hello");
});

Deno.test("unit: applyCase — empty string with maiúsculas returns empty string", () => {
  assertEquals(applyCase("", "maiúsculas"), "");
});

// ═══════════════════════════════════════════════════════════════════════════
// unit: substituteTokens
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: substituteTokens — replaces single token", () => {
  const result = substituteTokens(
    "Olá {{nome}}!",
    new Map([["nome", "João"]]),
  );
  assertEquals(result, "Olá João!");
});

Deno.test("unit: substituteTokens — replaces multiple tokens", () => {
  const result = substituteTokens(
    "{{nome}}, CPF {{cpf}}",
    new Map([["nome", "João"], ["cpf", "123.456.789-00"]]),
  );
  assertEquals(result, "João, CPF 123.456.789-00");
});

Deno.test("unit: substituteTokens — replaces same token multiple times", () => {
  const result = substituteTokens(
    "{{nome}} e {{nome}}",
    new Map([["nome", "João"]]),
  );
  assertEquals(result, "João e João");
});

Deno.test("unit: substituteTokens — leaves unknown tokens unchanged", () => {
  const result = substituteTokens(
    "{{nome}} e {{desconhecido}}",
    new Map([["nome", "João"]]),
  );
  assertEquals(result, "João e {{desconhecido}}");
});

Deno.test("unit: substituteTokens — handles token with spaces in name", () => {
  const result = substituteTokens(
    "Imóvel: {{nome do imóvel}}",
    new Map([["nome do imóvel", "Apt 101"]]),
  );
  assertEquals(result, "Imóvel: Apt 101");
});

Deno.test("unit: substituteTokens — handles empty value replacement", () => {
  const result = substituteTokens(
    "{{nome}} {{sobrenome}}",
    new Map([["nome", "João"], ["sobrenome", ""]]),
  );
  assertEquals(result, "João ");
});

Deno.test("unit: substituteTokens — handles content with no tokens", () => {
  const result = substituteTokens(
    "Nenhum placeholder aqui.",
    new Map([["nome", "João"]]),
  );
  assertEquals(result, "Nenhum placeholder aqui.");
});

Deno.test("unit: substituteTokens — trims whitespace inside token braces", () => {
  const result = substituteTokens(
    "{{ nome }}",
    new Map([["nome", "João"]]),
  );
  assertEquals(result, "João");
});

// ═══════════════════════════════════════════════════════════════════════════
// unit: POST /documents/generate (handler tests — Supabase + Drive stubbed)
// ═══════════════════════════════════════════════════════════════════════════

// ─── Fixtures ────────────────────────────────────────────────────────────

const MOCK_USER = {
  id: "user-uuid-landlord",
  email: "landlord@example.com",
  user_metadata: {},
};

const MOCK_LANDLORD = {
  google_refresh_token: "mock-refresh-token",
};

const MOCK_PROPERTY_ID = "prop-uuid-1";
const MOCK_TENANT_ID = "tenant-uuid-1";
const MOCK_TEMPLATE_ID = "template-uuid-1";
const MOCK_DRIVE_FILE_ID = "drive-template-file-id";
const MOCK_TENANT_FOLDER_ID = "tenant-drive-folder-id";
const MOCK_NEW_FILE_ID = "new-doc-drive-file-id";

const MOCK_PROPERTY = {
  id: MOCK_PROPERTY_ID,
  type: "apartment",
  drive_folder_id: "prop-drive-folder-id",
};

const MOCK_TENANT = {
  id: MOCK_TENANT_ID,
  drive_folder_id: MOCK_TENANT_FOLDER_ID,
  property_id: MOCK_PROPERTY_ID,
};

const MOCK_PLACEHOLDER_DEFS = [
  { name: "nome do inquilino", required: true, case: "título" },
  { name: "cpf do inquilino", required: true, case: null },
  { name: "endereço", required: false, case: null },
];

const MOCK_MAPPINGS = [{ template_id: MOCK_TEMPLATE_ID }];

const MOCK_TEMPLATES = [
  {
    id: MOCK_TEMPLATE_ID,
    name: "Contrato de Locação",
    drive_file_id: MOCK_DRIVE_FILE_ID,
  },
];

const MOCK_ACCESS_TOKEN = "mock-google-access-token";

// ─── Fetch stub builder ──────────────────────────────────────────────────

type MockFetchOpts = {
  authUser?: typeof MOCK_USER | null;
  landlord?: typeof MOCK_LANDLORD | null;
  property?: typeof MOCK_PROPERTY | null;
  tenant?: typeof MOCK_TENANT | null;
  placeholderDefs?: typeof MOCK_PLACEHOLDER_DEFS | null;
  mappings?: typeof MOCK_MAPPINGS | null;
  templates?: typeof MOCK_TEMPLATES | null;
  // Google token exchange
  tokenExchangeFail?: boolean;
  tokenServerError?: boolean;
  // Drive search for existing file (null = not found, string = found id)
  existingFileId?: string | null;
  driveSearchFail?: boolean;
  // Drive copy
  copiedFileId?: string;
  driveCopyFail?: boolean;
  // Drive export (template content)
  templateContent?: string;
  driveExportFail?: boolean;
  // Drive update (write substituted content)
  driveUpdateFail?: boolean;
  // Drive delete old file
  driveDeleteFail?: boolean;
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

    // Google token refresh
    if (url.includes("oauth2.googleapis.com/token")) {
      if (opts.tokenExchangeFail) {
        return new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
        });
      }
      if (opts.tokenServerError) {
        return new Response(JSON.stringify({ error: "server_error" }), {
          status: 500,
        });
      }
      return new Response(
        JSON.stringify({
          access_token: MOCK_ACCESS_TOKEN,
          expires_in: 3600,
          token_type: "Bearer",
          scope: "",
        }),
        { status: 200 },
      );
    }

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
      return new Response(JSON.stringify(opts.landlord ?? MOCK_LANDLORD), {
        status: 200,
      });
    }

    // PostgREST: properties
    if (url.includes("/rest/v1/properties")) {
      if (opts.property === null) {
        return new Response(JSON.stringify(null), { status: 200 });
      }
      return new Response(JSON.stringify(opts.property ?? MOCK_PROPERTY), {
        status: 200,
      });
    }

    // PostgREST: tenants
    if (url.includes("/rest/v1/tenants")) {
      if (opts.tenant === null) {
        return new Response(JSON.stringify(null), { status: 200 });
      }
      return new Response(JSON.stringify(opts.tenant ?? MOCK_TENANT), {
        status: 200,
      });
    }

    // PostgREST: placeholders
    if (url.includes("/rest/v1/placeholders")) {
      if (opts.placeholderDefs === null) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response(
        JSON.stringify(opts.placeholderDefs ?? MOCK_PLACEHOLDER_DEFS),
        { status: 200 },
      );
    }

    // PostgREST: property_type_templates
    if (url.includes("/rest/v1/property_type_templates")) {
      if (opts.mappings === null) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response(JSON.stringify(opts.mappings ?? MOCK_MAPPINGS), {
        status: 200,
      });
    }

    // PostgREST: templates
    if (url.includes("/rest/v1/templates")) {
      if (opts.templates === null) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response(JSON.stringify(opts.templates ?? MOCK_TEMPLATES), {
        status: 200,
      });
    }

    // Drive: search for existing file by name in tenant folder
    // The URL will contain "in+parents" or "in%20parents" depending on encoding.
    if (
      url.includes("googleapis.com/drive/v3/files") &&
      method === "GET" &&
      (url.includes("in+parents") || url.includes("in%20parents") ||
        url.includes("parents")) &&
      url.includes("trashed")
    ) {
      if (opts.driveSearchFail) {
        return new Response(JSON.stringify({ error: "server_error" }), {
          status: 500,
        });
      }
      if (opts.existingFileId) {
        return new Response(
          JSON.stringify({ files: [{ id: opts.existingFileId }] }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ files: [] }), { status: 200 });
    }

    // Drive: copy file
    if (url.includes("/copy") && method === "POST") {
      if (opts.driveCopyFail) {
        return new Response(JSON.stringify({ error: "server_error" }), {
          status: 500,
        });
      }
      return new Response(
        JSON.stringify({ id: opts.copiedFileId ?? MOCK_NEW_FILE_ID }),
        { status: 200 },
      );
    }

    // Drive: export file as text
    if (url.includes("/export") && method === "GET") {
      if (opts.driveExportFail) {
        return new Response("error", { status: 500 });
      }
      return new Response(
        opts.templateContent ??
          "Contrato entre {{nome do inquilino}}, CPF {{cpf do inquilino}}.",
        { status: 200 },
      );
    }

    // Drive: upload/update content (media upload)
    if (url.includes("upload/drive/v3/files") && method === "PATCH") {
      if (opts.driveUpdateFail) {
        return new Response(JSON.stringify({ error: "server_error" }), {
          status: 500,
        });
      }
      return new Response(JSON.stringify({ id: MOCK_NEW_FILE_ID }), {
        status: 200,
      });
    }

    // Drive: delete existing file
    if (
      url.includes("googleapis.com/drive/v3/files/") &&
      method === "DELETE"
    ) {
      if (opts.driveDeleteFail) {
        return new Response(JSON.stringify({ error: "server_error" }), {
          status: 500,
        });
      }
      return new Response(null, { status: 204 });
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
  return new Request("http://localhost/documents/generate", {
    method: "POST",
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function jsonBody(res: Response): Promise<unknown> {
  return await res.json();
}

const VALID_BODY = {
  property_id: MOCK_PROPERTY_ID,
  tenant_id: MOCK_TENANT_ID,
  placeholders: {
    "nome do inquilino": "João Silva",
    "cpf do inquilino": "123.456.789-00",
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// OPTIONS / CORS
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: generate OPTIONS — returns 200 with CORS headers", async () => {
  const res = await handleGenerateDocuments(
    new Request("http://localhost/documents/generate", { method: "OPTIONS" }),
  );
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("Access-Control-Allow-Origin") !== null, true);
});

// ─── 405 — wrong method ─────────────────────────────────────────────────

Deno.test("unit: generate GET — 405 method not allowed", async () => {
  const res = await handleGenerateDocuments(
    new Request("http://localhost/documents/generate", { method: "GET" }),
  );
  assertEquals(res.status, 405);
});

// ═══════════════════════════════════════════════════════════════════════════
// Auth failures
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: generate — 401 when no JWT provided", async () => {
  const res = await handleGenerateDocuments(makePostRequest(VALID_BODY));
  assertEquals(res.status, 401);
  const body = await jsonBody(res) as Record<string, unknown>;
  assertEquals((body.error as Record<string, string>).code, "UNAUTHORIZED");
});

Deno.test("unit: generate — 401 when JWT is invalid", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ authUser: null }) as typeof fetch;
  try {
    const res = await handleGenerateDocuments(
      makePostRequest(VALID_BODY, "bad.jwt"),
    );
    assertEquals(res.status, 401);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals((body.error as Record<string, string>).code, "UNAUTHORIZED");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Input validation
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: generate — 400 when property_id is missing", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const { property_id: _omit, ...bodyWithout } = VALID_BODY;
    const res = await handleGenerateDocuments(
      makePostRequest(bodyWithout, "valid.jwt"),
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

Deno.test("unit: generate — 400 when tenant_id is missing", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const { tenant_id: _omit, ...bodyWithout } = VALID_BODY;
    const res = await handleGenerateDocuments(
      makePostRequest(bodyWithout, "valid.jwt"),
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

Deno.test("unit: generate — 400 when placeholders field is missing", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handleGenerateDocuments(
      makePostRequest({
        property_id: MOCK_PROPERTY_ID,
        tenant_id: MOCK_TENANT_ID,
      }, "valid.jwt"),
    );
    assertEquals(res.status, 400);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals(
      (body.error as Record<string, string>).code,
      "INVALID_PLACEHOLDERS",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("unit: generate — 400 when placeholders field is an array", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handleGenerateDocuments(
      makePostRequest(
        {
          property_id: MOCK_PROPERTY_ID,
          tenant_id: MOCK_TENANT_ID,
          placeholders: [],
        },
        "valid.jwt",
      ),
    );
    assertEquals(res.status, 400);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals(
      (body.error as Record<string, string>).code,
      "INVALID_PLACEHOLDERS",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("unit: generate — 400 when unknown placeholder key sent", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handleGenerateDocuments(
      makePostRequest(
        {
          ...VALID_BODY,
          placeholders: {
            ...VALID_BODY.placeholders,
            "campo_inexistente": "valor",
          },
        },
        "valid.jwt",
      ),
    );
    assertEquals(res.status, 400);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals(
      (body.error as Record<string, string>).code,
      "UNKNOWN_PLACEHOLDER",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 422 — missing required placeholders
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: generate — 422 when required placeholder value is missing", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handleGenerateDocuments(
      makePostRequest(
        {
          property_id: MOCK_PROPERTY_ID,
          tenant_id: MOCK_TENANT_ID,
          // omit "cpf do inquilino" which is required
          placeholders: { "nome do inquilino": "João Silva" },
        },
        "valid.jwt",
      ),
    );
    assertEquals(res.status, 422);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals(
      (body.error as Record<string, string>).code,
      "MISSING_REQUIRED_PLACEHOLDERS",
    );
    assertStringIncludes(
      (body.error as Record<string, string>).message,
      "cpf do inquilino",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("unit: generate — 422 when required placeholder value is empty string", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handleGenerateDocuments(
      makePostRequest(
        {
          property_id: MOCK_PROPERTY_ID,
          tenant_id: MOCK_TENANT_ID,
          placeholders: {
            "nome do inquilino": "",
            "cpf do inquilino": "123.456.789-00",
          },
        },
        "valid.jwt",
      ),
    );
    assertEquals(res.status, 422);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals(
      (body.error as Record<string, string>).code,
      "MISSING_REQUIRED_PLACEHOLDERS",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 404 — resource not found
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: generate — 404 when landlord not found", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ landlord: null }) as typeof fetch;
  try {
    const res = await handleGenerateDocuments(
      makePostRequest(VALID_BODY, "valid.jwt"),
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

Deno.test("unit: generate — 404 when property not found", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ property: null }) as typeof fetch;
  try {
    const res = await handleGenerateDocuments(
      makePostRequest(VALID_BODY, "valid.jwt"),
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

Deno.test("unit: generate — 404 when tenant not found", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ tenant: null }) as typeof fetch;
  try {
    const res = await handleGenerateDocuments(
      makePostRequest(VALID_BODY, "valid.jwt"),
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

Deno.test("unit: generate — 404 when no templates mapped to property type", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ mappings: [] }) as typeof fetch;
  try {
    const res = await handleGenerateDocuments(
      makePostRequest(VALID_BODY, "valid.jwt"),
    );
    assertEquals(res.status, 404);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals(
      (body.error as Record<string, string>).code,
      "NO_TEMPLATES_FOUND",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 502 — Drive API failures
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: generate — 401 when Google token refresh returns invalid_grant", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({
    tokenExchangeFail: true,
  }) as typeof fetch;
  try {
    const res = await handleGenerateDocuments(
      makePostRequest(VALID_BODY, "valid.jwt"),
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

Deno.test("unit: generate — 502 when Google token refresh fails with server error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({
    tokenServerError: true,
  }) as typeof fetch;
  try {
    const res = await handleGenerateDocuments(
      makePostRequest(VALID_BODY, "valid.jwt"),
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

Deno.test("unit: generate — 502 when Drive copy fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ driveCopyFail: true }) as typeof fetch;
  try {
    const res = await handleGenerateDocuments(
      makePostRequest(VALID_BODY, "valid.jwt"),
    );
    assertEquals(res.status, 502);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals(
      (body.error as Record<string, string>).code,
      "DRIVE_COPY_FAILED",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("unit: generate — 502 when Drive export fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ driveExportFail: true }) as typeof fetch;
  try {
    const res = await handleGenerateDocuments(
      makePostRequest(VALID_BODY, "valid.jwt"),
    );
    assertEquals(res.status, 502);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals(
      (body.error as Record<string, string>).code,
      "DRIVE_EXPORT_FAILED",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("unit: generate — 502 when Drive update content fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ driveUpdateFail: true }) as typeof fetch;
  try {
    const res = await handleGenerateDocuments(
      makePostRequest(VALID_BODY, "valid.jwt"),
    );
    assertEquals(res.status, 502);
    const body = await jsonBody(res) as Record<string, unknown>;
    assertEquals(
      (body.error as Record<string, string>).code,
      "DRIVE_UPDATE_FAILED",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 200 — happy path
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: generate — 200 returns documents with Drive URLs", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({
    existingFileId: null,
    templateContent:
      "Contrato: {{nome do inquilino}}, CPF {{cpf do inquilino}}.",
  }) as typeof fetch;
  try {
    const res = await handleGenerateDocuments(
      makePostRequest(VALID_BODY, "valid.jwt"),
    );
    assertEquals(res.status, 200);
    const body = await jsonBody(res) as Record<string, unknown>;
    const documents = body.documents as Array<
      { template_name: string; drive_url: string }
    >;
    assertEquals(Array.isArray(documents), true);
    assertEquals(documents.length, 1);
    assertEquals(documents[0].template_name, "Contrato de Locação");
    assertStringIncludes(documents[0].drive_url, MOCK_NEW_FILE_ID);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("unit: generate — CORS headers on success response", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handleGenerateDocuments(
      makePostRequest(VALID_BODY, "valid.jwt"),
    );
    assertEquals(res.headers.get("Access-Control-Allow-Origin") !== null, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("unit: generate — Drive delete called when existing file found (regeneration)", async () => {
  const originalFetch = globalThis.fetch;
  let deleteCalledWithId: string | null = null;
  const existingFileId = "old-doc-drive-file-id";

  const mockFetch = buildMockFetch({ existingFileId }) as typeof fetch;
  globalThis.fetch = async function (
    input: string | URL | Request,
    init?: RequestInit,
  ) {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : (input as Request).url;
    const method = (init as RequestInit | undefined)?.method?.toUpperCase() ??
      "GET";
    if (
      url.includes("googleapis.com/drive/v3/files/") &&
      method === "DELETE"
    ) {
      deleteCalledWithId = url.split("/files/")[1].split("?")[0];
    }
    return mockFetch(input, init);
  } as typeof fetch;

  try {
    const res = await handleGenerateDocuments(
      makePostRequest(VALID_BODY, "valid.jwt"),
    );
    assertEquals(res.status, 200);
    assertEquals(deleteCalledWithId, existingFileId);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("unit: generate — succeeds even when delete of old file fails (best-effort)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({
    existingFileId: "old-file-id",
    driveDeleteFail: true,
  }) as typeof fetch;
  try {
    // Delete failure should be swallowed — the endpoint still returns 200.
    const res = await handleGenerateDocuments(
      makePostRequest(VALID_BODY, "valid.jwt"),
    );
    assertEquals(res.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("unit: generate — case transformation applied to title case placeholder", async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody: string | undefined;

  const base = buildMockFetch({
    templateContent: "Inquilino: {{nome do inquilino}}",
  }) as typeof fetch;

  globalThis.fetch = async function (
    input: string | URL | Request,
    init?: RequestInit,
  ) {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : (input as Request).url;
    const method = (init as RequestInit | undefined)?.method?.toUpperCase() ??
      "GET";
    if (url.includes("upload/drive/v3/files") && method === "PATCH") {
      capturedBody = (init as RequestInit | undefined)?.body as
        | string
        | undefined;
    }
    return base(input, init);
  } as typeof fetch;

  try {
    await handleGenerateDocuments(
      makePostRequest(
        {
          ...VALID_BODY,
          placeholders: {
            "nome do inquilino": "joão silva", // should become "João Silva" (título)
            "cpf do inquilino": "123.456.789-00",
          },
        },
        "valid.jwt",
      ),
    );
    // The substituted content should have title-case name
    assertEquals(capturedBody !== undefined, true);
    assertStringIncludes(capturedBody ?? "", "João Silva");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("unit: generate — optional placeholder absent from request is substituted with empty string", async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody: string | undefined;

  const base = buildMockFetch({
    templateContent: "Endereço: {{endereço}}",
  }) as typeof fetch;

  globalThis.fetch = async function (
    input: string | URL | Request,
    init?: RequestInit,
  ) {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : (input as Request).url;
    const method = (init as RequestInit | undefined)?.method?.toUpperCase() ??
      "GET";
    if (url.includes("upload/drive/v3/files") && method === "PATCH") {
      capturedBody = (init as RequestInit | undefined)?.body as
        | string
        | undefined;
    }
    return base(input, init);
  } as typeof fetch;

  try {
    // VALID_BODY does not include "endereço" (optional) — should be replaced with ""
    await handleGenerateDocuments(makePostRequest(VALID_BODY, "valid.jwt"));
    assertEquals(capturedBody !== undefined, true);
    assertStringIncludes(capturedBody ?? "", "Endereço: ");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("unit: generate — 400 when use_case is invalid", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({});
  try {
    const res = await handleGenerateDocuments(
      makePostRequest({ ...VALID_BODY, use_case: "invalid" }, "valid.jwt"),
    );
    assertEquals(res.status, 400);
    const body = await res.json() as Record<string, Record<string, string>>;
    assertEquals(body.error.code, "INVALID_USE_CASE");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("unit: generate — defaults use_case to initial when omitted", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({});
  try {
    // VALID_BODY has no use_case — should succeed (defaults to initial)
    const res = await handleGenerateDocuments(
      makePostRequest(VALID_BODY, "valid.jwt"),
    );
    assertEquals(res.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("unit: generate — 404 when no templates match use_case", async () => {
  const originalFetch = globalThis.fetch;
  // Return empty templates list to simulate no templates for this use_case
  globalThis.fetch = buildMockFetch({ templates: null });
  try {
    const res = await handleGenerateDocuments(
      makePostRequest({ ...VALID_BODY, use_case: "renewal" }, "valid.jwt"),
    );
    assertEquals(res.status, 404);
    const body = await res.json() as Record<string, Record<string, string>>;
    assertEquals(body.error.code, "NO_TEMPLATES_FOUND");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
