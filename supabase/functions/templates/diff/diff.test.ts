// integration: GET /templates/diff
//
// Tests call handleTemplatesDiff() directly. Network calls to Supabase Auth,
// PostgREST, and Google APIs are intercepted via globalThis.fetch stubs —
// no real Supabase instance or Google account is needed.
//
// Unit tests for extractPlaceholders() and extractWitnessNames() run in
// isolation without any stubs.
//
// Test names follow the "unit:" / "integration:" prefix convention.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

// Set required env vars before importing handlers so requireEnv() doesn't throw.
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_ANON_KEY", "test-anon-key");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
Deno.env.set("GOOGLE_CLIENT_ID", "test-google-client-id");
Deno.env.set("GOOGLE_CLIENT_SECRET", "test-google-client-secret");

import {
  extractPlaceholders,
  extractWitnessNames,
  handleTemplatesDiff,
} from "./index.ts";

// ─── Unit: extractPlaceholders ────────────────────────────────────────────

Deno.test("unit: extractPlaceholders — returns empty array for text with no tokens", () => {
  assertEquals(extractPlaceholders("No placeholders here."), []);
});

Deno.test("unit: extractPlaceholders — extracts single token", () => {
  assertEquals(extractPlaceholders("Hello {{nome do inquilino}}"), [
    "nome do inquilino",
  ]);
});

Deno.test("unit: extractPlaceholders — extracts multiple distinct tokens sorted", () => {
  const text = "{{cpf}} and {{nome}} and {{cpf}} again";
  assertEquals(extractPlaceholders(text), ["cpf", "nome"]);
});

Deno.test("unit: extractPlaceholders — trims whitespace inside braces", () => {
  assertEquals(extractPlaceholders("{{ valor do aluguel }}"), [
    "valor do aluguel",
  ]);
});

Deno.test("unit: extractPlaceholders — ignores empty token", () => {
  assertEquals(extractPlaceholders("{{}}"), []);
});

// ─── Unit: extractWitnessNames ────────────────────────────────────────────

Deno.test("unit: extractWitnessNames — returns empty array when no underscore lines", () => {
  assertEquals(extractWitnessNames("No signature block here."), []);
});

Deno.test("unit: extractWitnessNames — detects name after underscore line", () => {
  const text = "Assinatura:\n_____\nMaria Oliveira\nOutro texto";
  assertEquals(extractWitnessNames(text), ["Maria Oliveira"]);
});

Deno.test("unit: extractWitnessNames — detects multiple witnesses", () => {
  const text = [
    "Testemunha 1:",
    "_________",
    "João Silva",
    "",
    "Testemunha 2:",
    "____________",
    "Ana Costa",
  ].join("\n");
  const result = extractWitnessNames(text);
  assertEquals(result.includes("João Silva"), true);
  assertEquals(result.includes("Ana Costa"), true);
  assertEquals(result.length, 2);
});

Deno.test("unit: extractWitnessNames — skips placeholder token as witness name", () => {
  const text = "_____\n{{nome da testemunha}}\n_____\nCarlos Mendes";
  assertEquals(extractWitnessNames(text), ["Carlos Mendes"]);
});

Deno.test("unit: extractWitnessNames — ignores underscore line shorter than 5 chars", () => {
  const text = "____\nShort line name";
  assertEquals(extractWitnessNames(text), []);
});

Deno.test("unit: extractWitnessNames — skips blank lines between underscore and name", () => {
  const text = "_____\n\n\nMaria Fernanda";
  assertEquals(extractWitnessNames(text), ["Maria Fernanda"]);
});

// ─── Fixtures ─────────────────────────────────────────────────────────────

const MOCK_USER = {
  id: "user-uuid-1234",
  email: "landlord@example.com",
  user_metadata: {},
};

const MOCK_LANDLORD = {
  google_refresh_token: "mock-refresh-token",
  templates_folder_id: "templates-folder-drive-id",
};

const MODIFIED_TIME_CACHED = "2024-01-01T10:00:00.000Z";
const MODIFIED_TIME_CURRENT = "2024-01-01T10:00:00.000Z"; // same → fast path

const MOCK_TEMPLATES = [
  {
    id: "tmpl-uuid-1",
    name: "Contrato Residencial",
    drive_file_id: "drive-file-id-1",
    drive_last_modified_at: MODIFIED_TIME_CACHED,
    placeholder_names: ["nome do inquilino", "cpf"],
  },
];

const MOCK_TEMPLATES_CHANGED = [
  {
    id: "tmpl-uuid-1",
    name: "Contrato Residencial",
    drive_file_id: "drive-file-id-1",
    drive_last_modified_at: "2024-01-01T09:00:00.000Z", // older than Drive
    placeholder_names: ["nome do inquilino", "cpf"],
  },
];

const MOCK_DRIVE_FILES = [
  {
    id: "drive-file-id-1",
    name: "Contrato Residencial",
    modifiedTime: MODIFIED_TIME_CURRENT,
  },
];

// Drive file content for changed template slow-path test.
const MOCK_CHANGED_DOC_TEXT = [
  "Contrato de Locação",
  "Locatário: {{nome do inquilino}}",
  "Valor: {{valor do aluguel}}",
  "Data: {{data de início}}",
  "Testemunhas:",
  "___________",
  "João da Silva",
  "___________",
  "Maria Oliveira",
].join("\n");

// ─── Fetch stub builder ──────────────────────────────────────────────────

function buildMockFetch(opts: {
  authUser?: typeof MOCK_USER | null;
  landlord?: typeof MOCK_LANDLORD | null;
  templates?: typeof MOCK_TEMPLATES | typeof MOCK_TEMPLATES_CHANGED;
  driveFiles?: typeof MOCK_DRIVE_FILES;
  docText?: string;
  googleTokenFail?: boolean;
  driveListFail?: boolean;
  driveExportFail?: boolean;
  dbUpdateFail?: boolean;
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

    // PostgREST: templates
    if (url.includes("/rest/v1/templates")) {
      if ((init as RequestInit | undefined)?.method === "PATCH") {
        // DB cache update
        if (opts.dbUpdateFail) {
          return new Response(
            JSON.stringify({ message: "db error", code: "PGRST000" }),
            { status: 500 },
          );
        }
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response(
        JSON.stringify(opts.templates ?? MOCK_TEMPLATES),
        { status: 200 },
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

    // Google token endpoint
    if (url.includes("oauth2.googleapis.com/token")) {
      if (opts.googleTokenFail) {
        return new Response(
          JSON.stringify({ error: "invalid_grant" }),
          { status: 400 },
        );
      }
      return new Response(
        JSON.stringify({ access_token: "mock-access-token", expires_in: 3600 }),
        { status: 200 },
      );
    }

    // Google Drive: list files (GET without /export in URL)
    if (
      url.includes("www.googleapis.com/drive/v3/files") &&
      !url.includes("/export")
    ) {
      if (opts.driveListFail) {
        return new Response(JSON.stringify({ error: "forbidden" }), {
          status: 403,
        });
      }
      return new Response(
        JSON.stringify({ files: opts.driveFiles ?? MOCK_DRIVE_FILES }),
        { status: 200 },
      );
    }

    // Google Drive: export file as text
    if (
      url.includes("www.googleapis.com/drive/v3/files") &&
      url.includes("/export")
    ) {
      if (opts.driveExportFail) {
        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
        });
      }
      return new Response(opts.docText ?? MOCK_CHANGED_DOC_TEXT, {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }

    throw new Error(`Unexpected fetch in test: ${url}`);
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeRequest(jwt?: string, method = "GET"): Request {
  const headers: Record<string, string> = {};
  if (jwt) headers["Authorization"] = `Bearer ${jwt}`;
  return new Request("http://localhost/templates/diff", { method, headers });
}

async function jsonBody(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

// ─── 401 — no JWT ─────────────────────────────────────────────────────────

Deno.test("integration: GET /templates/diff — 401 when no JWT provided", async () => {
  const res = await handleTemplatesDiff(makeRequest());
  assertEquals(res.status, 401);
  const body = await jsonBody(res);
  assertEquals((body.error as Record<string, string>).code, "UNAUTHORIZED");
});

// ─── 401 — invalid JWT ────────────────────────────────────────────────────

Deno.test("integration: GET /templates/diff — 401 when JWT is invalid", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ authUser: null }) as typeof fetch;
  try {
    const res = await handleTemplatesDiff(makeRequest("bad.jwt.token"));
    assertEquals(res.status, 401);
    const body = await jsonBody(res);
    assertEquals((body.error as Record<string, string>).code, "UNAUTHORIZED");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 405 — wrong method ───────────────────────────────────────────────────

Deno.test("integration: GET /templates/diff — 405 when POST is used", async () => {
  const res = await handleTemplatesDiff(makeRequest(undefined, "POST"));
  assertEquals(res.status, 405);
  const body = await jsonBody(res);
  assertEquals(
    (body.error as Record<string, string>).code,
    "METHOD_NOT_ALLOWED",
  );
});

// ─── OPTIONS preflight ────────────────────────────────────────────────────

Deno.test("integration: GET /templates/diff — OPTIONS returns 200 with CORS headers", async () => {
  const res = await handleTemplatesDiff(makeRequest(undefined, "OPTIONS"));
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("Access-Control-Allow-Origin") !== null, true);
});

// ─── CORS headers on success ──────────────────────────────────────────────

Deno.test("integration: GET /templates/diff — success response includes CORS headers", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handleTemplatesDiff(makeRequest("valid.jwt"));
    assertEquals(res.headers.get("Access-Control-Allow-Origin") !== null, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── CORS headers on error ────────────────────────────────────────────────

Deno.test("integration: GET /templates/diff — error response includes CORS headers", async () => {
  const res = await handleTemplatesDiff(makeRequest());
  assertEquals(res.headers.get("Access-Control-Allow-Origin") !== null, true);
});

// ─── Fast path: no changes ────────────────────────────────────────────────

Deno.test("integration: GET /templates/diff — 200 with empty diff when no templates changed (fast path)", async () => {
  const originalFetch = globalThis.fetch;
  // MOCK_TEMPLATES has drive_last_modified_at === MODIFIED_TIME_CACHED === MODIFIED_TIME_CURRENT
  // MOCK_DRIVE_FILES returns the same modifiedTime → no change → fast path
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const res = await handleTemplatesDiff(makeRequest("valid.jwt"));
    assertEquals(res.status, 200);
    const body = await jsonBody(res);
    const templates = body.templates as Record<string, unknown[]>;
    const placeholders = body.placeholders as Record<string, unknown[]>;
    const witnesses = body.witnesses as Record<string, unknown[]>;
    assertEquals(templates.added.length, 0);
    assertEquals(templates.removed.length, 0);
    assertEquals(placeholders.added.length, 0);
    assertEquals(placeholders.removed.length, 0);
    assertEquals(witnesses.added.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── Fast path: Drive not hit when times match ────────────────────────────

Deno.test("integration: GET /templates/diff — fast path does not export Drive file content", async () => {
  let exportCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : (input as Request).url;

    if (url.includes("/export")) {
      exportCalled = true;
      return new Response("", { status: 200 });
    }
    return buildMockFetch({})(input as string);
  }) as typeof fetch;

  try {
    await handleTemplatesDiff(makeRequest("valid.jwt"));
    assertEquals(exportCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── Slow path: changed template ─────────────────────────────────────────

Deno.test("integration: GET /templates/diff — 200 with placeholder diff when template changed (slow path)", async () => {
  const originalFetch = globalThis.fetch;
  // MOCK_TEMPLATES_CHANGED has drive_last_modified_at older than Drive's modifiedTime
  globalThis.fetch = buildMockFetch({
    templates: MOCK_TEMPLATES_CHANGED,
    // MOCK_CHANGED_DOC_TEXT has: nome do inquilino, valor do aluguel, data de início
    // Old: nome do inquilino, cpf  →  added: valor do aluguel, data de início; removed: cpf
  }) as typeof fetch;
  try {
    const res = await handleTemplatesDiff(makeRequest("valid.jwt"));
    assertEquals(res.status, 200);
    const body = await jsonBody(res);
    const placeholders = body.placeholders as Record<string, string[]>;
    assertEquals(placeholders.added.includes("valor do aluguel"), true);
    assertEquals(placeholders.added.includes("data de início"), true);
    assertEquals(placeholders.removed.includes("cpf"), true);
    // nome do inquilino is in both — should NOT appear in added or removed
    assertEquals(placeholders.added.includes("nome do inquilino"), false);
    assertEquals(placeholders.removed.includes("nome do inquilino"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── Slow path: witness detection ────────────────────────────────────────

Deno.test("integration: GET /templates/diff — witnesses detected from signature blocks", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({
    templates: MOCK_TEMPLATES_CHANGED,
    // MOCK_CHANGED_DOC_TEXT has two witnesses: João da Silva, Maria Oliveira
  }) as typeof fetch;
  try {
    const res = await handleTemplatesDiff(makeRequest("valid.jwt"));
    assertEquals(res.status, 200);
    const body = await jsonBody(res);
    const witnesses = body.witnesses as Record<string, string[]>;
    assertEquals(witnesses.added.includes("João da Silva"), true);
    assertEquals(witnesses.added.includes("Maria Oliveira"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── Guia de Placeholders exclusion ──────────────────────────────────────

Deno.test("integration: GET /templates/diff — Guia de Placeholders is never included in diff", async () => {
  const originalFetch = globalThis.fetch;
  const templatesWithGuia = [
    ...MOCK_TEMPLATES_CHANGED,
    {
      id: "tmpl-guia",
      name: "Guia de Placeholders",
      drive_file_id: "drive-guia-id",
      drive_last_modified_at: "2020-01-01T00:00:00.000Z", // old time → would trigger slow path
      placeholder_names: [],
    },
  ];
  const driveFilesWithGuia = [
    ...MOCK_DRIVE_FILES,
    {
      id: "drive-guia-id",
      name: "Guia de Placeholders",
      modifiedTime: "2024-06-01T00:00:00.000Z", // newer than cached
    },
  ];
  let exportCallCount = 0;
  globalThis.fetch =
    (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.href
        : (input as Request).url;

      if (url.includes("/export")) {
        exportCallCount++;
      }
      return buildMockFetch({
        templates: templatesWithGuia,
        driveFiles: driveFilesWithGuia,
      })(input as string, init);
    }) as typeof fetch;

  try {
    const res = await handleTemplatesDiff(makeRequest("valid.jwt"));
    assertEquals(res.status, 200);
    // Export should only be called for the non-Guia changed template, not for Guia
    assertEquals(exportCallCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 404 — landlord not found ─────────────────────────────────────────────

Deno.test("integration: GET /templates/diff — 404 when landlord row does not exist", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ landlord: null }) as typeof fetch;
  try {
    const res = await handleTemplatesDiff(makeRequest("valid.jwt"));
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

Deno.test("integration: GET /templates/diff — 502 when Google token refresh fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ googleTokenFail: true }) as typeof fetch;
  try {
    const res = await handleTemplatesDiff(makeRequest("valid.jwt"));
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

// ─── 502 — Drive list failure ─────────────────────────────────────────────

Deno.test("integration: GET /templates/diff — 502 when Drive file listing fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ driveListFail: true }) as typeof fetch;
  try {
    const res = await handleTemplatesDiff(makeRequest("valid.jwt"));
    assertEquals(res.status, 502);
    const body = await jsonBody(res);
    assertEquals(
      (body.error as Record<string, string>).code,
      "DRIVE_LIST_FAILED",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 502 — Drive export failure ──────────────────────────────────────────

Deno.test("integration: GET /templates/diff — 502 when Drive file export fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({
    templates: MOCK_TEMPLATES_CHANGED,
    driveExportFail: true,
  }) as typeof fetch;
  try {
    const res = await handleTemplatesDiff(makeRequest("valid.jwt"));
    assertEquals(res.status, 502);
    const body = await jsonBody(res);
    assertEquals(
      (body.error as Record<string, string>).code,
      "DRIVE_EXPORT_FAILED",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── No templates → all-empty diff ───────────────────────────────────────

Deno.test("integration: GET /templates/diff — 200 with all-empty arrays when landlord has no templates", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({
    templates: [],
    driveFiles: [],
  }) as typeof fetch;
  try {
    const res = await handleTemplatesDiff(makeRequest("valid.jwt"));
    assertEquals(res.status, 200);
    const body = await jsonBody(res);
    const templates = body.templates as Record<string, unknown[]>;
    const placeholders = body.placeholders as Record<string, unknown[]>;
    const witnesses = body.witnesses as Record<string, unknown[]>;
    assertEquals(templates.added.length, 0);
    assertEquals(templates.removed.length, 0);
    assertEquals(placeholders.added.length, 0);
    assertEquals(placeholders.removed.length, 0);
    assertEquals(witnesses.added.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
