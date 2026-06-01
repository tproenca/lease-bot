// unit: GET /templates/diff
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
    last_modified_at: MODIFIED_TIME_CACHED,
    placeholder_names: ["nome do inquilino", "cpf"],
  },
];

const MOCK_TEMPLATES_CHANGED = [
  {
    id: "tmpl-uuid-1",
    name: "Contrato Residencial",
    drive_file_id: "drive-file-id-1",
    last_modified_at: "2024-01-01T09:00:00.000Z", // older than Drive
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

// Template that is in DB but no longer in Drive (removed).
const MOCK_TEMPLATES_WITH_REMOVED = [
  {
    id: "tmpl-uuid-1",
    name: "Contrato Residencial",
    drive_file_id: "drive-file-id-1",
    last_modified_at: MODIFIED_TIME_CACHED,
    placeholder_names: ["nome do inquilino", "cpf"],
  },
  {
    id: "tmpl-uuid-removed",
    name: "Contrato Comercial",
    drive_file_id: "drive-file-id-deleted",
    last_modified_at: MODIFIED_TIME_CACHED,
    placeholder_names: [],
  },
];

// property_type_templates rows for the removed template.
const MOCK_PT_ROWS_FOR_REMOVED = [
  { template_id: "tmpl-uuid-removed", property_type: "apartment" },
  { template_id: "tmpl-uuid-removed", property_type: "house" },
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
  googleTokenServerError?: boolean;
  driveListFail?: boolean;
  driveExportFail?: boolean;
  dbUpdateFail?: boolean;
  propertyTypeTemplates?: Array<{ template_id: string; property_type: string }>;
  configuredPlaceholders?: Array<{ name: string }>;
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

    // PostgREST: property_type_templates
    if (url.includes("/rest/v1/property_type_templates")) {
      return new Response(
        JSON.stringify(opts.propertyTypeTemplates ?? []),
        { status: 200 },
      );
    }

    // PostgREST: placeholders
    if (url.includes("/rest/v1/placeholders")) {
      return new Response(
        JSON.stringify(opts.configuredPlaceholders ?? []),
        { status: 200 },
      );
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
      if (opts.googleTokenServerError) {
        return new Response(
          JSON.stringify({ error: "server_error" }),
          { status: 500 },
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

Deno.test("unit: GET /templates/diff — 401 when no JWT provided", async () => {
  const res = await handleTemplatesDiff(makeRequest());
  assertEquals(res.status, 401);
  const body = await jsonBody(res);
  assertEquals((body.error as Record<string, string>).code, "UNAUTHORIZED");
});

// ─── 401 — invalid JWT ────────────────────────────────────────────────────

Deno.test("unit: GET /templates/diff — 401 when JWT is invalid", async () => {
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

Deno.test("unit: GET /templates/diff — 405 when POST is used", async () => {
  const res = await handleTemplatesDiff(makeRequest(undefined, "POST"));
  assertEquals(res.status, 405);
  const body = await jsonBody(res);
  assertEquals(
    (body.error as Record<string, string>).code,
    "METHOD_NOT_ALLOWED",
  );
});

// ─── OPTIONS preflight ────────────────────────────────────────────────────

Deno.test("unit: GET /templates/diff — OPTIONS returns 200 with CORS headers", async () => {
  const res = await handleTemplatesDiff(makeRequest(undefined, "OPTIONS"));
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("Access-Control-Allow-Origin") !== null, true);
});

// ─── CORS headers on success ──────────────────────────────────────────────

Deno.test("unit: GET /templates/diff — success response includes CORS headers", async () => {
  const originalFetch = globalThis.fetch;
  // All placeholders already configured so the fast path fires cleanly.
  globalThis.fetch = buildMockFetch({
    configuredPlaceholders: [
      { name: "nome do inquilino" },
      { name: "cpf" },
    ],
  }) as typeof fetch;
  try {
    const res = await handleTemplatesDiff(makeRequest("valid.jwt"));
    assertEquals(res.headers.get("Access-Control-Allow-Origin") !== null, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── CORS headers on error ────────────────────────────────────────────────

Deno.test("unit: GET /templates/diff — error response includes CORS headers", async () => {
  const res = await handleTemplatesDiff(makeRequest());
  assertEquals(res.headers.get("Access-Control-Allow-Origin") !== null, true);
});

// ─── Fast path: no changes ────────────────────────────────────────────────

Deno.test("unit: GET /templates/diff — 200 with empty diff when no templates changed (fast path)", async () => {
  const originalFetch = globalThis.fetch;
  // MOCK_TEMPLATES has last_modified_at === MODIFIED_TIME_CACHED === MODIFIED_TIME_CURRENT
  // MOCK_DRIVE_FILES returns the same modifiedTime → no change → fast path.
  // All placeholder_names from MOCK_TEMPLATES are already configured → no unconfigured.
  globalThis.fetch = buildMockFetch({
    configuredPlaceholders: [
      { name: "nome do inquilino" },
      { name: "cpf" },
    ],
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

// ─── Fast path: Drive not hit when times match ────────────────────────────

Deno.test("unit: GET /templates/diff — fast path does not export Drive file content", async () => {
  let exportCalled = false;
  const originalFetch = globalThis.fetch;
  // All placeholder_names from MOCK_TEMPLATES already configured → fast path fires.
  const mockFetch = buildMockFetch({
    configuredPlaceholders: [
      { name: "nome do inquilino" },
      { name: "cpf" },
    ],
  });
  globalThis.fetch =
    (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.href
        : (input as Request).url;

      if (url.includes("/export")) {
        exportCalled = true;
        return new Response("", { status: 200 });
      }
      return mockFetch(input as string, init);
    }) as typeof fetch;

  try {
    await handleTemplatesDiff(makeRequest("valid.jwt"));
    assertEquals(exportCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── Slow path: changed template ─────────────────────────────────────────

Deno.test("unit: GET /templates/diff — 200 with placeholder diff when template changed (slow path)", async () => {
  const originalFetch = globalThis.fetch;
  // MOCK_TEMPLATES_CHANGED has last_modified_at older than Drive's modifiedTime.
  // "nome do inquilino" and "cpf" were previously configured (they were in the old
  // placeholder_names cache). Mark them as configured so the unconfigured-placeholder
  // check does not re-surface them — only the Drive-content diff drives the result.
  globalThis.fetch = buildMockFetch({
    templates: MOCK_TEMPLATES_CHANGED,
    // MOCK_CHANGED_DOC_TEXT has: nome do inquilino, valor do aluguel, data de início
    // Old: nome do inquilino, cpf  →  added: valor do aluguel, data de início; removed: cpf
    configuredPlaceholders: [
      { name: "nome do inquilino" },
      { name: "cpf" },
    ],
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

Deno.test("unit: GET /templates/diff — witnesses detected from signature blocks", async () => {
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

Deno.test("unit: GET /templates/diff — Guia de Placeholders is never included in diff", async () => {
  const originalFetch = globalThis.fetch;
  const templatesWithGuia = [
    ...MOCK_TEMPLATES_CHANGED,
    {
      id: "tmpl-guia",
      name: "Guia de Placeholders",
      drive_file_id: "drive-guia-id",
      last_modified_at: "2020-01-01T00:00:00.000Z", // old time → would trigger slow path
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

// ─── Lista de Placeholders exclusion ─────────────────────────────────────

Deno.test("unit: GET /templates/diff — Lista de Placeholders is never included in diff", async () => {
  const originalFetch = globalThis.fetch;
  const templatesWithLista = [
    ...MOCK_TEMPLATES_CHANGED,
    {
      id: "tmpl-lista",
      name: "Lista de Placeholders",
      drive_file_id: "drive-lista-id",
      last_modified_at: "2020-01-01T00:00:00.000Z", // old time → would trigger slow path
      placeholder_names: [],
    },
  ];
  const driveFilesWithLista = [
    ...MOCK_DRIVE_FILES,
    {
      id: "drive-lista-id",
      name: "Lista de Placeholders",
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
        templates: templatesWithLista,
        driveFiles: driveFilesWithLista,
      })(input as string, init);
    }) as typeof fetch;

  try {
    const res = await handleTemplatesDiff(makeRequest("valid.jwt"));
    assertEquals(res.status, 200);
    const body = await jsonBody(res);
    const templates = body.templates as {
      added: Array<{ name: string }>;
      removed: unknown[];
    };
    // Lista de Placeholders must not appear in templates.added
    const listaInAdded = templates.added.some(
      (t) => t.name === "Lista de Placeholders",
    );
    assertEquals(
      listaInAdded,
      false,
      "Lista de Placeholders must not appear in templates.added",
    );
    // Export should only be called for the non-Lista changed template, not for Lista
    assertEquals(exportCallCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 404 — landlord not found ─────────────────────────────────────────────

Deno.test("unit: GET /templates/diff — 404 when landlord row does not exist", async () => {
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

// ─── 401 — Google reauth required (invalid_grant) ─────────────────────────

Deno.test("unit: GET /templates/diff — 401 when Google token refresh returns invalid_grant", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ googleTokenFail: true }) as typeof fetch;
  try {
    const res = await handleTemplatesDiff(makeRequest("valid.jwt"));
    assertEquals(res.status, 401);
    const body = await jsonBody(res);
    assertEquals(
      (body.error as Record<string, string>).code,
      "GOOGLE_REAUTH_REQUIRED",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 502 — Google auth failure (non-invalid_grant) ────────────────────────

Deno.test("unit: GET /templates/diff — 502 when Google token refresh fails with server error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({
    googleTokenServerError: true,
  }) as typeof fetch;
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

Deno.test("unit: GET /templates/diff — 502 when Drive file listing fails", async () => {
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

Deno.test("unit: GET /templates/diff — 502 when Drive file export fails", async () => {
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

Deno.test("unit: GET /templates/diff — 200 with all-empty arrays when landlord has no templates", async () => {
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

// ─── Removed templates: new shape { name, property_types } ───────────────

Deno.test("unit: GET /templates/diff — removed.templates is Array<{ name, property_types }>", async () => {
  const originalFetch = globalThis.fetch;
  // MOCK_TEMPLATES_WITH_REMOVED has drive-file-id-deleted which is absent from MOCK_DRIVE_FILES
  globalThis.fetch = buildMockFetch({
    templates: MOCK_TEMPLATES_WITH_REMOVED,
    driveFiles: MOCK_DRIVE_FILES,
    propertyTypeTemplates: MOCK_PT_ROWS_FOR_REMOVED,
  }) as typeof fetch;
  try {
    const res = await handleTemplatesDiff(makeRequest("valid.jwt"));
    assertEquals(res.status, 200);
    const body = await jsonBody(res);
    const templates = body.templates as {
      added: Array<
        { name: string; drive_file_id: string; last_modified_at: string }
      >;
      removed: Array<{ name: string; property_types: string[] }>;
    };
    assertEquals(templates.removed.length, 1);
    const removed = templates.removed[0];
    assertEquals(removed.name, "Contrato Comercial");
    assertEquals(removed.property_types.includes("apartment"), true);
    assertEquals(removed.property_types.includes("house"), true);
    assertEquals(removed.property_types.length, 2);
    assertEquals(templates.added.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("unit: GET /templates/diff — removed.templates has empty property_types when none configured", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({
    templates: MOCK_TEMPLATES_WITH_REMOVED,
    driveFiles: MOCK_DRIVE_FILES,
    propertyTypeTemplates: [], // no rows for this template
  }) as typeof fetch;
  try {
    const res = await handleTemplatesDiff(makeRequest("valid.jwt"));
    assertEquals(res.status, 200);
    const body = await jsonBody(res);
    const templates = body.templates as {
      added: Array<
        { name: string; drive_file_id: string; last_modified_at: string }
      >;
      removed: Array<{ name: string; property_types: string[] }>;
    };
    assertEquals(templates.removed.length, 1);
    assertEquals(templates.removed[0].name, "Contrato Comercial");
    assertEquals(templates.removed[0].property_types.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── Added templates: placeholder extraction ──────────────────────────────

// Drive file that is new (not in DB) with placeholders and a witness block.
const MOCK_NEW_DRIVE_FILE = {
  id: "drive-file-id-new",
  name: "Contrato Comercial Novo",
  modifiedTime: "2024-06-01T00:00:00.000Z",
};

const MOCK_NEW_TEMPLATE_DOC_TEXT = [
  "Contrato Comercial",
  "Locatário: {{nome do locatário}}",
  "CNPJ: {{cnpj}}",
  "Valor: {{valor mensal}}",
  "Testemunhas:",
  "___________",
  "Pedro Alves",
].join("\n");

Deno.test("unit: GET /templates/diff — new template placeholders appear in placeholders.added", async () => {
  const originalFetch = globalThis.fetch;
  // DB has no templates; Drive returns one new file
  globalThis.fetch = buildMockFetch({
    templates: [],
    driveFiles: [MOCK_NEW_DRIVE_FILE],
    docText: MOCK_NEW_TEMPLATE_DOC_TEXT,
  }) as typeof fetch;
  try {
    const res = await handleTemplatesDiff(makeRequest("valid.jwt"));
    assertEquals(res.status, 200);
    const body = await jsonBody(res);
    const placeholders = body.placeholders as Record<string, string[]>;
    assertEquals(placeholders.added.includes("nome do locatário"), true);
    assertEquals(placeholders.added.includes("cnpj"), true);
    assertEquals(placeholders.added.includes("valor mensal"), true);
    assertEquals(placeholders.added.length, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("unit: GET /templates/diff — new template witnesses appear in witnesses.added", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({
    templates: [],
    driveFiles: [MOCK_NEW_DRIVE_FILE],
    docText: MOCK_NEW_TEMPLATE_DOC_TEXT,
  }) as typeof fetch;
  try {
    const res = await handleTemplatesDiff(makeRequest("valid.jwt"));
    assertEquals(res.status, 200);
    const body = await jsonBody(res);
    const witnesses = body.witnesses as Record<string, string[]>;
    assertEquals(witnesses.added.includes("Pedro Alves"), true);
    assertEquals(witnesses.added.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("unit: GET /templates/diff — templates.added returns { name, drive_file_id, last_modified_at } for new Drive files", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({
    templates: [],
    driveFiles: [MOCK_NEW_DRIVE_FILE],
    docText: MOCK_NEW_TEMPLATE_DOC_TEXT,
  }) as typeof fetch;
  try {
    const res = await handleTemplatesDiff(makeRequest("valid.jwt"));
    assertEquals(res.status, 200);
    const body = await jsonBody(res);
    const templates = body.templates as {
      added: Array<
        { name: string; drive_file_id: string; last_modified_at: string }
      >;
      removed: unknown[];
    };
    assertEquals(templates.added.length, 1);
    const added = templates.added[0];
    assertEquals(added.name, "Contrato Comercial Novo");
    assertEquals(added.drive_file_id, MOCK_NEW_DRIVE_FILE.id);
    assertEquals(added.last_modified_at, MOCK_NEW_DRIVE_FILE.modifiedTime);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("unit: GET /templates/diff — 502 when Drive export fails for new template", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({
    templates: [],
    driveFiles: [MOCK_NEW_DRIVE_FILE],
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

Deno.test("unit: GET /templates/diff — placeholders.removed is empty when only new templates exist", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({
    templates: [],
    driveFiles: [MOCK_NEW_DRIVE_FILE],
    docText: MOCK_NEW_TEMPLATE_DOC_TEXT,
  }) as typeof fetch;
  try {
    const res = await handleTemplatesDiff(makeRequest("valid.jwt"));
    assertEquals(res.status, 200);
    const body = await jsonBody(res);
    const placeholders = body.placeholders as Record<string, string[]>;
    // No existing placeholders to remove when template is new
    assertEquals(placeholders.removed.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── Integration: full diff → POST /templates → next diff round-trip ─────
//
// Simulates the full Flow 2 chain at the unit level using fetch stubs:
//   1. First diff detects a new Drive file → templates.added contains { name, drive_file_id, last_modified_at }
//   2. GPT calls POST /templates with drive_file_id + last_modified_at from step 1
//   3. Second diff runs with the template now in DB (modifiedTime unchanged) → empty diff
//
// This verifies that using the real Drive modifiedTime prevents false "Alterado" diffs.

import { handleTemplates } from "../index.ts";

const INTEGRATION_NEW_DRIVE_FILE = {
  id: "drive-file-id-integration",
  name: "Contrato Integração",
  modifiedTime: "2024-09-01T12:00:00.000Z",
};

const INTEGRATION_TEMPLATE_DOC_TEXT = "Contrato\nLocatário: {{nome}}";

Deno.test("integration: diff → POST /templates → next diff returns empty (no false Alterado)", async () => {
  // ── Step 1: First diff — DB is empty, Drive has one new file ──────────────
  const originalFetch = globalThis.fetch;

  const firstDiffFetch = buildMockFetch({
    templates: [],
    driveFiles: [INTEGRATION_NEW_DRIVE_FILE],
    docText: INTEGRATION_TEMPLATE_DOC_TEXT,
  });
  globalThis.fetch = firstDiffFetch as typeof fetch;

  let firstDiffResult: Record<string, unknown>;
  try {
    const res = await handleTemplatesDiff(makeRequest("valid.jwt"));
    assertEquals(res.status, 200, "First diff should return 200");
    firstDiffResult = await jsonBody(res);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const addedTemplates =
    (firstDiffResult.templates as Record<string, unknown[]>).added;
  assertEquals(
    addedTemplates.length,
    1,
    "First diff should detect one new template",
  );

  const addedEntry = addedTemplates[0] as {
    name: string;
    drive_file_id: string;
    last_modified_at: string;
  };
  assertEquals(addedEntry.name, INTEGRATION_NEW_DRIVE_FILE.name);
  assertEquals(addedEntry.drive_file_id, INTEGRATION_NEW_DRIVE_FILE.id);
  assertEquals(
    addedEntry.last_modified_at,
    INTEGRATION_NEW_DRIVE_FILE.modifiedTime,
  );

  // ── Step 2: POST /templates using values from templates.added ─────────────
  // GPT passes drive_file_id and last_modified_at received from the diff response.
  let capturedInsertBody: Record<string, unknown> = {};

  const postTemplateFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : (input as Request).url;
    const method = (init?.method ?? "GET").toUpperCase();

    if (url.includes("/auth/v1/user")) {
      return new Response(JSON.stringify(MOCK_USER), { status: 200 });
    }
    if (url.includes("/rest/v1/templates") && method === "POST") {
      capturedInsertBody = JSON.parse(init?.body as string ?? "{}");
      return new Response(
        JSON.stringify({ id: "new-template-uuid" }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.includes("/rest/v1/property_type_templates") && method === "POST") {
      return new Response(JSON.stringify([]), { status: 201 });
    }
    throw new Error(`Unexpected fetch in POST step: ${url}`);
  };

  globalThis.fetch = postTemplateFetch as typeof fetch;
  try {
    const postReq = new Request("http://localhost/templates", {
      method: "POST",
      headers: {
        "Authorization": "Bearer valid.jwt",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        drive_file_id: addedEntry.drive_file_id,
        name: addedEntry.name,
        last_modified_at: addedEntry.last_modified_at,
        placeholder_names: ["nome"],
        property_types: ["apartment"],
      }),
    });
    const postRes = await handleTemplates(postReq);
    assertEquals(postRes.status, 201, "POST /templates should return 201");
  } finally {
    globalThis.fetch = originalFetch;
  }

  // Verify the stored last_modified_at is the real Drive modifiedTime (not new Date()).
  assertEquals(
    capturedInsertBody.last_modified_at,
    INTEGRATION_NEW_DRIVE_FILE.modifiedTime,
    "POST /templates must store the Drive modifiedTime, not new Date()",
  );

  // ── Step 3: Second diff — DB now has the template with correct last_modified_at ─
  // Drive returns the same file with the same modifiedTime → fast path → empty diff.
  const registeredTemplate = {
    id: "new-template-uuid",
    name: INTEGRATION_NEW_DRIVE_FILE.name,
    drive_file_id: INTEGRATION_NEW_DRIVE_FILE.id,
    last_modified_at: capturedInsertBody.last_modified_at as string,
    placeholder_names: ["nome"],
  };

  // The template's placeholder "nome" is already configured → fast path fires.
  const secondDiffFetch = buildMockFetch({
    templates: [registeredTemplate],
    driveFiles: [INTEGRATION_NEW_DRIVE_FILE], // same modifiedTime as stored
    configuredPlaceholders: [{ name: "nome" }],
  });
  globalThis.fetch = secondDiffFetch as typeof fetch;

  try {
    const res = await handleTemplatesDiff(makeRequest("valid.jwt"));
    assertEquals(res.status, 200, "Second diff should return 200");
    const body = await jsonBody(res);
    const templates = body.templates as Record<string, unknown[]>;
    const placeholders = body.placeholders as Record<string, unknown[]>;
    assertEquals(
      templates.added.length,
      0,
      "Second diff must have empty templates.added — no false Alterado",
    );
    assertEquals(
      templates.removed.length,
      0,
      "Second diff must have empty templates.removed",
    );
    assertEquals(
      placeholders.added.length,
      0,
      "Second diff must have empty placeholders.added",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── Resume scenario: unconfigured placeholders reported when no Drive change ─

Deno.test("unit: GET /templates/diff — reports unconfigured placeholders when session interrupted after template save", async () => {
  // Simulates the resume scenario:
  //   - templates table has placeholder_names populated (session saved the template)
  //   - placeholders table is empty (session interrupted before POST /placeholders)
  //   - Drive modifiedTime matches last_modified_at (no Drive change detected)
  //
  // Expected: placeholders.added contains the unconfigured names so GPT triggers Flow 2.
  const originalFetch = globalThis.fetch;
  const RESUME_TEMPLATE = {
    id: "tmpl-uuid-resume",
    name: "Contrato Residencial",
    drive_file_id: "drive-file-id-1",
    last_modified_at: MODIFIED_TIME_CACHED, // matches Drive → no Drive change
    placeholder_names: ["cpf_inquilino", "nome_locador"],
  };
  const RESUME_DRIVE_FILES = [
    {
      id: "drive-file-id-1",
      name: "Contrato Residencial",
      modifiedTime: MODIFIED_TIME_CACHED, // same as last_modified_at → no Drive diff
    },
  ];
  globalThis.fetch = buildMockFetch({
    templates: [RESUME_TEMPLATE],
    driveFiles: RESUME_DRIVE_FILES,
    configuredPlaceholders: [], // placeholders table is empty — interrupted session
  }) as typeof fetch;
  try {
    const res = await handleTemplatesDiff(makeRequest("valid.jwt"));
    assertEquals(res.status, 200);
    const body = await jsonBody(res);
    const placeholders = body.placeholders as Record<string, string[]>;
    // Both names must appear in added so the GPT runs placeholder config (Flow 2).
    assertEquals(placeholders.added.includes("cpf_inquilino"), true);
    assertEquals(placeholders.added.includes("nome_locador"), true);
    assertEquals(placeholders.added.length, 2);
    assertEquals(placeholders.removed.length, 0);
    // No template-level changes.
    const templates = body.templates as Record<string, unknown[]>;
    assertEquals(templates.added.length, 0);
    assertEquals(templates.removed.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("unit: GET /templates/diff — fast path fires when all placeholders are configured", async () => {
  // When every name in templates.placeholder_names exists in the placeholders table,
  // unconfiguredPlaceholders is empty and the fast path (all-empty response) fires.
  const originalFetch = globalThis.fetch;
  const CONFIGURED_TEMPLATE = {
    id: "tmpl-uuid-configured",
    name: "Contrato Residencial",
    drive_file_id: "drive-file-id-1",
    last_modified_at: MODIFIED_TIME_CACHED,
    placeholder_names: ["cpf_inquilino", "nome_locador"],
  };
  const CONFIGURED_DRIVE_FILES = [
    {
      id: "drive-file-id-1",
      name: "Contrato Residencial",
      modifiedTime: MODIFIED_TIME_CACHED,
    },
  ];
  globalThis.fetch = buildMockFetch({
    templates: [CONFIGURED_TEMPLATE],
    driveFiles: CONFIGURED_DRIVE_FILES,
    // All placeholder_names already exist in the placeholders table.
    configuredPlaceholders: [
      { name: "cpf_inquilino" },
      { name: "nome_locador" },
    ],
  }) as typeof fetch;
  try {
    const res = await handleTemplatesDiff(makeRequest("valid.jwt"));
    assertEquals(res.status, 200);
    const body = await jsonBody(res);
    const placeholders = body.placeholders as Record<string, unknown[]>;
    assertEquals(
      placeholders.added.length,
      0,
      "placeholders.added must be empty when all placeholders are configured",
    );
    assertEquals(placeholders.removed.length, 0);
    const templates = body.templates as Record<string, unknown[]>;
    assertEquals(templates.added.length, 0);
    assertEquals(templates.removed.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("unit: GET /templates/diff — deduplicates placeholder names appearing in both changed template and unconfigured list", async () => {
  // A placeholder that appears in a changed template AND is also unconfigured
  // should only appear once in placeholders.added.
  const originalFetch = globalThis.fetch;
  // Template has "nome" configured but "cpf" missing; the Drive file changed
  // and the new content contains both "nome" and "cpf".
  const CHANGED_TEMPLATE = {
    id: "tmpl-uuid-dedup",
    name: "Contrato",
    drive_file_id: "drive-file-id-dedup",
    last_modified_at: "2024-01-01T09:00:00.000Z", // older than Drive → changed
    placeholder_names: ["nome"], // old cache only had "nome"
  };
  const DEDUP_DRIVE_FILES = [
    {
      id: "drive-file-id-dedup",
      name: "Contrato",
      modifiedTime: MODIFIED_TIME_CURRENT, // newer than last_modified_at
    },
  ];
  // New document adds "cpf" alongside "nome".
  const DEDUP_DOC_TEXT = "{{nome}} {{cpf}}";
  globalThis.fetch = buildMockFetch({
    templates: [CHANGED_TEMPLATE],
    driveFiles: DEDUP_DRIVE_FILES,
    docText: DEDUP_DOC_TEXT,
    // "cpf" is also absent from the placeholders table → unconfigured
    configuredPlaceholders: [{ name: "nome" }],
  }) as typeof fetch;
  try {
    const res = await handleTemplatesDiff(makeRequest("valid.jwt"));
    assertEquals(res.status, 200);
    const body = await jsonBody(res);
    const placeholders = body.placeholders as Record<string, string[]>;
    // "cpf" appears via both the changed-template diff and the unconfigured check;
    // it must appear exactly once.
    const cpfCount = placeholders.added.filter((n: string) => n === "cpf")
      .length;
    assertEquals(
      cpfCount,
      1,
      "cpf must appear exactly once in placeholders.added",
    );
    assertEquals(placeholders.added.includes("cpf"), true);
    // "nome" is in both old and new → not in added; it IS configured too.
    assertEquals(placeholders.added.includes("nome"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
