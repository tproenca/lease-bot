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

Deno.test("unit: buildPlaceholderListContent — null optional fields render as em-dash", () => {
  const md = buildPlaceholderListContent([{
    name: "nome",
    required: true,
    format: "text",
    case: null,
    default: null,
    derived_from: null,
  }]);
  const dashes = (md.match(/—/g) ?? []).length;
  assertEquals(dashes >= 3, true);
});

Deno.test("unit: buildPlaceholderListContent — provided optional fields are included", () => {
  const md = buildPlaceholderListContent([{
    name: "data_fim",
    required: false,
    format: "date",
    case: "minúsculas",
    default: "hoje",
    derived_from: "data_inicio",
  }]);
  assertStringIncludes(md, "minúsculas");
  assertStringIncludes(md, "hoje");
  assertStringIncludes(md, "data_inicio");
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
