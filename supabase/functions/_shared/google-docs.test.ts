// unit: _shared/google.ts — createPlaceholderGuide, createSampleContract,
//                            upsertPlaceholderList, buildPlaceholderListContent
//
// Two test layers:
//   1. Pure unit tests for buildPlaceholderListContent — no mocks, no network.
//   2. Mock-fetch tests for the three exported doc functions — verify Drive
//      lookup behaviour (find vs create) and that Docs batchUpdate is called.

import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.env.set("GOOGLE_CLIENT_ID", "test-client-id");
Deno.env.set("GOOGLE_CLIENT_SECRET", "test-client-secret");

import {
  buildPlaceholderListContent,
  createPlaceholderGuide,
  createSampleContract,
  formatFormulaForDisplay,
  upsertPlaceholderList,
} from "./google.ts";

// ═══════════════════════════════════════════════════════════════════════════
// buildPlaceholderListContent — pure unit tests (no mocks)
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: buildPlaceholderListContent — empty list returns just template header", () => {
  const md = buildPlaceholderListContent([]);
  // No table data rows — only the template header lines
  assertEquals(md.includes("{{"), false);
});

Deno.test("unit: buildPlaceholderListContent — wraps name in {{double braces}}", () => {
  const md = buildPlaceholderListContent([
    { name: "cpf_inquilino", required: true, format: "cpf" },
  ]);
  assertStringIncludes(md, "{{cpf_inquilino}}");
});

Deno.test("unit: buildPlaceholderListContent — required=true renders 'sim'", () => {
  const md = buildPlaceholderListContent([
    { name: "nome", required: true, format: "text" },
  ]);
  assertStringIncludes(md, "sim");
});

Deno.test("unit: buildPlaceholderListContent — required=false renders 'não'", () => {
  const md = buildPlaceholderListContent([
    { name: "obs", required: false, format: "text" },
  ]);
  assertStringIncludes(md, "não");
});

Deno.test("unit: buildPlaceholderListContent — null optional fields render as em-dash or Perguntado", () => {
  const md = buildPlaceholderListContent([{
    name: "nome",
    required: true,
    format: "text",
    case: null,
    default: null,
    derived_formula: null,
  }]);
  // case and default render as "—"; derived_formula null renders as "Perguntado"
  assertStringIncludes(md, "Perguntado");
  const dashes = (md.match(/—/g) ?? []).length;
  assertEquals(dashes >= 2, true);
});

Deno.test("unit: buildPlaceholderListContent — provided optional fields are included", () => {
  const md = buildPlaceholderListContent([{
    name: "data_fim",
    required: false,
    format: "date",
    case: "minúsculas",
    default: "hoje",
    derived_formula: "end_date(data_inicio, duracao_meses)",
  }]);
  assertStringIncludes(md, "minúsculas");
  assertStringIncludes(md, "hoje");
  assertStringIncludes(md, "end_date(data_inicio, duracao_meses)");
});

Deno.test("unit: buildPlaceholderListContent — column order is Nome|Formato|Transformação|Padrão|Notas|Obrigatório", () => {
  const md = buildPlaceholderListContent([{
    name: "data_fim",
    required: true,
    format: "date",
    case: "minúsculas",
    default: "hoje",
    derived_formula: "data_inicio + prazo_meses",
  }]);
  // Find the data row and verify column order
  const dataRow = md.split("\n").find((l) => l.includes("{{data_fim}}"))!;
  const cols = dataRow.split("|").map((c) => c.trim()).filter(Boolean);
  // Expected: {{data_fim}} | date | minúsculas | hoje | data_inicio + prazo_meses | sim
  assertEquals(cols[0], "{{data_fim}}");
  assertEquals(cols[1], "date");
  assertEquals(cols[2], "minúsculas");
  assertEquals(cols[3], "hoje");
  assertEquals(cols[4], "data_inicio + prazo_meses");
  assertEquals(cols[5], "sim");
});

Deno.test("unit: buildPlaceholderListContent — derived_formula shown in Notas; em-dash when absent", () => {
  const md = buildPlaceholderListContent([
    {
      name: "aluguel",
      required: true,
      format: "currency",
      derived_formula: null,
    },
    {
      name: "data_fim",
      required: false,
      format: "date",
      derived_formula: "data_inicio + prazo_meses",
    },
  ]);
  // aluguel row: Notas should be —
  const aluguelRow = md.split("\n").find((l) => l.includes("{{aluguel}}"))!;
  assertStringIncludes(aluguelRow, "—");
  // data_fim row: Notas should show the formula
  const dataFimRow = md.split("\n").find((l) => l.includes("{{data_fim}}"))!;
  assertStringIncludes(dataFimRow, "data_inicio + prazo_meses");
});

Deno.test("unit: buildPlaceholderListContent — no blank line between header and data rows (header bug fix)", () => {
  const md = buildPlaceholderListContent([
    { name: "aluguel", required: true, format: "currency" },
    { name: "cpf", required: true, format: "cpf" },
  ]);
  const lines = md.split("\n");
  // Find the separator row (|---...)
  const sepIdx = lines.findIndex((l) => l.startsWith("|---"));
  // The line immediately after the separator must be a data row, not blank
  assertEquals(sepIdx >= 0, true, "separator row must exist");
  const lineAfterSep = lines[sepIdx + 1];
  assertEquals(
    lineAfterSep.startsWith("|"),
    true,
    "line after separator must be a data row, not blank",
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// formatFormulaForDisplay — pure unit tests
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: formatFormulaForDisplay — null renders as 'Perguntado'", () => {
  assertEquals(formatFormulaForDisplay(null), "Perguntado");
});

Deno.test("unit: formatFormulaForDisplay — undefined renders as 'Perguntado'", () => {
  assertEquals(formatFormulaForDisplay(undefined), "Perguntado");
});

Deno.test("unit: formatFormulaForDisplay — empty string renders as 'Perguntado'", () => {
  assertEquals(formatFormulaForDisplay(""), "Perguntado");
});

Deno.test("unit: formatFormulaForDisplay — bare context path renders as-is", () => {
  assertEquals(formatFormulaForDisplay("tenant.name"), "tenant.name");
});

Deno.test("unit: formatFormulaForDisplay — bare sibling placeholder name renders as-is", () => {
  assertEquals(formatFormulaForDisplay("data_inicio"), "data_inicio");
});

Deno.test("unit: formatFormulaForDisplay — function call renders as-is", () => {
  assertEquals(
    formatFormulaForDisplay("cpf_format(tenant.cpf)"),
    "cpf_format(tenant.cpf)",
  );
});

Deno.test("unit: formatFormulaForDisplay — multi-arg function call renders as-is", () => {
  assertEquals(
    formatFormulaForDisplay("end_date(data_inicio, duracao_meses)"),
    "end_date(data_inicio, duracao_meses)",
  );
});

Deno.test("unit: buildPlaceholderListContent — sorts placeholders alphabetically", () => {
  const md = buildPlaceholderListContent([
    { name: "valor_aluguel", required: true, format: "currency" },
    { name: "data_inicio", required: true, format: "date" },
    { name: "nome_inquilino", required: true, format: "text" },
  ]);
  const idxData = md.indexOf("data_inicio");
  const idxNome = md.indexOf("nome_inquilino");
  const idxValor = md.indexOf("valor_aluguel");
  assertEquals(idxData < idxNome, true);
  assertEquals(idxNome < idxValor, true);
});

Deno.test("unit: buildPlaceholderListContent — multiple placeholders produce multiple rows", () => {
  const md = buildPlaceholderListContent([
    { name: "nome", required: true, format: "text" },
    { name: "cpf", required: true, format: "cpf" },
  ]);
  const rowCount = (md.match(/\| \{\{/g) ?? []).length;
  assertEquals(rowCount, 2);
});

// ═══════════════════════════════════════════════════════════════════════════
// Mock-fetch helpers
// ═══════════════════════════════════════════════════════════════════════════

// Minimal Docs API response — endIndex ≤ 2 so applyDocStyle skips the delete step.
const EMPTY_DOC = {
  body: {
    content: [{
      startIndex: 0,
      endIndex: 1,
      paragraph: { elements: [{ startIndex: 0, endIndex: 1 }] },
    }],
  },
};

type MockOpts = {
  existingDocName?: string;
  existingDocId?: string;
  newDocId?: string;
  onBatchUpdate?: () => void;
};

function buildMockFetch(opts: MockOpts = {}) {
  const existingDocId = opts.existingDocId ?? "existing-doc-id";
  const newDocId = opts.newDocId ?? "new-doc-id";

  return async function mockFetch(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : (input as Request).url;
    const method = (init?.method ?? "GET").toUpperCase();

    // Drive — list files
    if (url.includes("www.googleapis.com/drive/v3/files") && method === "GET") {
      const files = opts.existingDocName
        ? [{
          id: existingDocId,
          name: opts.existingDocName,
          modifiedTime: "2024-01-01T00:00:00Z",
        }]
        : [];
      return new Response(JSON.stringify({ files }), { status: 200 });
    }

    // Drive — create doc
    if (
      url.includes("www.googleapis.com/drive/v3/files") && method === "POST"
    ) {
      return new Response(JSON.stringify({ id: newDocId }), { status: 200 });
    }

    // Docs — get document
    if (url.includes("docs.googleapis.com/v1/documents") && method === "GET") {
      return new Response(JSON.stringify(EMPTY_DOC), { status: 200 });
    }

    // Docs — batchUpdate
    if (
      url.includes("docs.googleapis.com") && url.includes(":batchUpdate") &&
      method === "POST"
    ) {
      opts.onBatchUpdate?.();
      // Consume body to avoid resource leak in tests
      await (init?.body as BodyInit as Blob)?.text?.();
      return new Response(JSON.stringify({}), { status: 200 });
    }

    throw new Error(`Unexpected fetch in test: ${method} ${url}`);
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// createPlaceholderGuide
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: createPlaceholderGuide — creates doc when absent, returns new ID", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ newDocId: "guia-new" }) as typeof fetch;
  try {
    const id = await createPlaceholderGuide({
      accessToken: "tok",
      templatesFolderId: "folder",
    });
    assertEquals(id, "guia-new");
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("unit: createPlaceholderGuide — reuses existing doc ID when found", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = buildMockFetch({
    existingDocName: "Guia de Placeholders",
    existingDocId: "guia-existing",
  }) as typeof fetch;
  try {
    const id = await createPlaceholderGuide({
      accessToken: "tok",
      templatesFolderId: "folder",
    });
    assertEquals(id, "guia-existing");
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("unit: createPlaceholderGuide — always calls Docs batchUpdate to apply style", async () => {
  const original = globalThis.fetch;
  let batchUpdateCalled = false;
  globalThis.fetch = buildMockFetch({
    onBatchUpdate: () => {
      batchUpdateCalled = true;
    },
  }) as typeof fetch;
  try {
    await createPlaceholderGuide({
      accessToken: "tok",
      templatesFolderId: "folder",
    });
    assertEquals(batchUpdateCalled, true);
  } finally {
    globalThis.fetch = original;
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// createSampleContract
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: createSampleContract — creates doc when absent, returns new ID", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = buildMockFetch({
    newDocId: "contract-new",
  }) as typeof fetch;
  try {
    const id = await createSampleContract({
      accessToken: "tok",
      templatesFolderId: "folder",
    });
    assertEquals(id, "contract-new");
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("unit: createSampleContract — reuses existing doc with correct name", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = buildMockFetch({
    existingDocName: "Contrato de Locação Residencial (Exemplo)",
    existingDocId: "contract-existing",
  }) as typeof fetch;
  try {
    const id = await createSampleContract({
      accessToken: "tok",
      templatesFolderId: "folder",
    });
    assertEquals(id, "contract-existing");
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("unit: createSampleContract — always calls Docs batchUpdate to apply style", async () => {
  const original = globalThis.fetch;
  let batchUpdateCalled = false;
  globalThis.fetch = buildMockFetch({
    onBatchUpdate: () => {
      batchUpdateCalled = true;
    },
  }) as typeof fetch;
  try {
    await createSampleContract({
      accessToken: "tok",
      templatesFolderId: "folder",
    });
    assertEquals(batchUpdateCalled, true);
  } finally {
    globalThis.fetch = original;
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// upsertPlaceholderList
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: upsertPlaceholderList — returns doc ID", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ newDocId: "lista-new" }) as typeof fetch;
  try {
    const id = await upsertPlaceholderList({
      accessToken: "tok",
      templatesFolderId: "folder",
      placeholders: [],
    });
    assertEquals(id, "lista-new");
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("unit: upsertPlaceholderList — always calls Docs batchUpdate even with empty list", async () => {
  const original = globalThis.fetch;
  let batchUpdateCalled = false;
  globalThis.fetch = buildMockFetch({
    onBatchUpdate: () => {
      batchUpdateCalled = true;
    },
  }) as typeof fetch;
  try {
    await upsertPlaceholderList({
      accessToken: "tok",
      templatesFolderId: "folder",
      placeholders: [],
    });
    assertEquals(batchUpdateCalled, true);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("unit: upsertPlaceholderList — reuses existing Lista doc", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = buildMockFetch({
    existingDocName: "Lista de Placeholders",
    existingDocId: "lista-existing",
  }) as typeof fetch;
  try {
    const id = await upsertPlaceholderList({
      accessToken: "tok",
      templatesFolderId: "folder",
      placeholders: [],
    });
    assertEquals(id, "lista-existing");
  } finally {
    globalThis.fetch = original;
  }
});
