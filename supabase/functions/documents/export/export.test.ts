// unit: documents/export
//
// Unit tests for exportAndMergePdfs. All external calls (Drive API, pdf-lib)
// are mocked via globalThis.fetch stubs and module-level injection.
//
// Test naming follows the ci.sh filter: "unit|integration".

import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

// Set required env vars before importing so requireEnv() doesn't throw.
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_ANON_KEY", "test-anon-key");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
Deno.env.set("GOOGLE_CLIENT_ID", "test-google-client-id");
Deno.env.set("GOOGLE_CLIENT_SECRET", "test-google-client-secret");

import { exportAndMergePdfs } from "./index.ts";
import { PDFDocument } from "pdf-lib";

// ─── Fixtures ─────────────────────────────────────────────────────────────

const MOCK_REFRESH_TOKEN = "mock-refresh-token";
const MOCK_ACCESS_TOKEN = "mock-access-token";

const DOC_A: { fileId: string; label: string } = {
  fileId: "file-id-doc-a",
  label: "Contrato de Locação",
};
const DOC_B: { fileId: string; label: string } = {
  fileId: "file-id-doc-b",
  label: "Adendo",
};

// Cache the real minimal 1-page PDF bytes created by pdf-lib so each test
// that needs a valid PDF payload doesn't have to await the creation.
let _minimalPdfCache: Uint8Array | undefined;
async function minimalPdfBytes(): Promise<Uint8Array> {
  if (!_minimalPdfCache) {
    const doc = await PDFDocument.create();
    doc.addPage();
    _minimalPdfCache = await doc.save();
  }
  return _minimalPdfCache;
}

// ─── Fetch stub builder ───────────────────────────────────────────────────

type MockFetchOpts = {
  /** Force the token exchange to return a 400 error. */
  tokenExchangeFail?: boolean;
  /**
   * Map of fileId → behaviour:
   *   true  → return a valid minimal PDF
   *   false → return a 500 error
   * Files not present in the map default to returning a valid PDF.
   */
  exportResults?: Record<string, boolean>;
};

function buildMockFetch(opts: MockFetchOpts) {
  const exportResults = opts.exportResults ?? {};

  return async function (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : (input as Request).url;

    // Google token refresh endpoint.
    if (url.includes("oauth2.googleapis.com/token")) {
      if (opts.tokenExchangeFail) {
        return new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
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

    // Drive export endpoint — pattern: /drive/v3/files/{fileId}/export
    if (
      url.includes("googleapis.com/drive/v3/files/") &&
      url.includes("/export")
    ) {
      // Extract the fileId from the URL path.
      const match = url.match(/\/files\/([^/]+)\/export/);
      const fileId = match ? decodeURIComponent(match[1]) : "__unknown__";
      const shouldSucceed = exportResults[fileId] !== false; // default: success
      if (!shouldSucceed) {
        return new Response(JSON.stringify({ error: "server_error" }), {
          status: 500,
        });
      }
      const pdfBytes = await minimalPdfBytes();
      return new Response(pdfBytes.buffer as ArrayBuffer, {
        status: 200,
        headers: { "Content-Type": "application/pdf" },
      });
    }

    throw new Error(
      `Unexpected fetch in unit test: ${
        (init as RequestInit | undefined)?.method ?? "GET"
      } ${url}`,
    );
  };
}

// ─── Helper ───────────────────────────────────────────────────────────────

async function run(
  docs: { fileId: string; label: string }[],
  fetchOpts: MockFetchOpts = {},
) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch(fetchOpts) as typeof fetch;
  try {
    return await exportAndMergePdfs({
      refreshToken: MOCK_REFRESH_TOKEN,
      docs,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// unit: token refresh failures
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: export — throws when Google token refresh fails", async () => {
  let threw = false;
  try {
    await run([DOC_A], { tokenExchangeFail: true });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

// ═══════════════════════════════════════════════════════════════════════════
// unit: Drive export failures → ExportFailure shape
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: export — returns ok:false when single doc export fails", async () => {
  const result = await run([DOC_A], {
    exportResults: { [DOC_A.fileId]: false },
  });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.failedUrl, DOC_A.fileId);
    assertStringIncludes(result.driveUrl, DOC_A.fileId);
    assertStringIncludes(result.error, "drive_export_pdf_failed_500");
  }
});

Deno.test("unit: export — failedUrl contains the Drive export URL", async () => {
  const result = await run([DOC_A], {
    exportResults: { [DOC_A.fileId]: false },
  });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.failedUrl, "googleapis.com/drive/v3/files");
    assertStringIncludes(result.failedUrl, DOC_A.fileId);
    assertStringIncludes(result.failedUrl, "mimeType");
  }
});

Deno.test("unit: export — driveUrl is a Google Docs edit URL", async () => {
  const result = await run([DOC_A], {
    exportResults: { [DOC_A.fileId]: false },
  });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.driveUrl, "docs.google.com/document/d/");
    assertStringIncludes(result.driveUrl, DOC_A.fileId);
  }
});

Deno.test("unit: export — returns ok:false on first failure, does not export remaining docs", async () => {
  // DOC_A fails, DOC_B should never be fetched.
  let docBFetched = false;
  const originalFetch = globalThis.fetch;

  const base = buildMockFetch({
    exportResults: { [DOC_A.fileId]: false, [DOC_B.fileId]: true },
  });

  globalThis.fetch = async function (
    input: string | URL | Request,
    init?: RequestInit,
  ) {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : (input as Request).url;
    if (url.includes(DOC_B.fileId)) docBFetched = true;
    return base(input, init);
  } as typeof fetch;

  try {
    const result = await exportAndMergePdfs({
      refreshToken: MOCK_REFRESH_TOKEN,
      docs: [DOC_A, DOC_B],
    });
    assertEquals(result.ok, false);
    assertEquals(docBFetched, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("unit: export — second doc failure returns ok:false with second doc info", async () => {
  const result = await run([DOC_A, DOC_B], {
    exportResults: { [DOC_A.fileId]: true, [DOC_B.fileId]: false },
  });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.failedUrl, DOC_B.fileId);
    assertStringIncludes(result.driveUrl, DOC_B.fileId);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// unit: happy path — ExportSuccess shape
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: export — single doc success returns ok:true with pdf bytes", async () => {
  const result = await run([DOC_A]);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.pdf instanceof Uint8Array, true);
    assertEquals(result.pdf.length > 0, true);
  }
});

Deno.test("unit: export — single doc success returns pageCount >= 1", async () => {
  const result = await run([DOC_A]);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.pageCount >= 1, true);
  }
});

Deno.test("unit: export — two docs merged pageCount equals sum of individual counts", async () => {
  // Each mock PDF has 1 page, so merged total should be 2.
  const result = await run([DOC_A, DOC_B]);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.pageCount, 2);
  }
});

Deno.test("unit: export — merged pdf bytes are a valid PDF (starts with %PDF header)", async () => {
  const result = await run([DOC_A, DOC_B]);
  assertEquals(result.ok, true);
  if (result.ok) {
    // All PDFs start with "%PDF".
    const header = new TextDecoder().decode(result.pdf.slice(0, 4));
    assertEquals(header, "%PDF");
  }
});

Deno.test("unit: export — empty docs list returns ok:true with 0 pages", async () => {
  const result = await run([]);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.pageCount, 0);
    assertEquals(result.pdf instanceof Uint8Array, true);
  }
});

Deno.test("unit: export — Drive Bearer token sent in Authorization header", async () => {
  let capturedAuthHeader: string | undefined;
  const originalFetch = globalThis.fetch;

  const base = buildMockFetch({});
  globalThis.fetch = async function (
    input: string | URL | Request,
    init?: RequestInit,
  ) {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : (input as Request).url;
    if (url.includes("googleapis.com/drive/v3/files")) {
      capturedAuthHeader =
        (init as RequestInit | undefined)?.headers instanceof Headers
          ? ((init as RequestInit).headers as Headers).get("Authorization") ??
            undefined
          : ((init as RequestInit | undefined)?.headers as
            | Record<string, string>
            | undefined)?.["Authorization"];
    }
    return base(input, init);
  } as typeof fetch;

  try {
    await exportAndMergePdfs({
      refreshToken: MOCK_REFRESH_TOKEN,
      docs: [DOC_A],
    });
    assertEquals(capturedAuthHeader, `Bearer ${MOCK_ACCESS_TOKEN}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("unit: export — exports mimeType=application/pdf", async () => {
  let capturedUrl: string | undefined;
  const originalFetch = globalThis.fetch;

  const base = buildMockFetch({});
  globalThis.fetch = async function (
    input: string | URL | Request,
    init?: RequestInit,
  ) {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : (input as Request).url;
    if (url.includes("/export")) capturedUrl = url;
    return base(input, init);
  } as typeof fetch;

  try {
    await exportAndMergePdfs({
      refreshToken: MOCK_REFRESH_TOKEN,
      docs: [DOC_A],
    });
    assertEquals(capturedUrl !== undefined, true);
    assertStringIncludes(capturedUrl ?? "", "mimeType=application%2Fpdf");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
