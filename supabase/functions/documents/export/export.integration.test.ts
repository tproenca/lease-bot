// integration: documents/export
//
// Integration tests for exportAndMergePdfs against a real local Supabase
// instance. Drive HTTP calls and pdf-lib merging are stubbed so the tests do
// not depend on a real Google account or internet access.
//
// Requires `supabase start` to be running before execution.
// Run via: deno test --allow-all supabase/functions/ --filter "integration"
//
// Test naming follows the ci.sh filter: "unit|integration".

import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createClient } from "@supabase/supabase-js";

// Read Supabase connection details from environment (no hardcoded secrets).
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

// Required for the google.ts shared module.
Deno.env.set(
  "GOOGLE_CLIENT_ID",
  Deno.env.get("GOOGLE_CLIENT_ID") ?? "test-google-client-id",
);
Deno.env.set(
  "GOOGLE_CLIENT_SECRET",
  Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "test-google-client-secret",
);

import { exportAndMergePdfs } from "./index.ts";
import { PDFDocument } from "pdf-lib";

// ─── Shared Supabase admin client (service role) ──────────────────────────

const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ─── Test fixtures ────────────────────────────────────────────────────────

const MOCK_REFRESH_TOKEN = "integration-test-refresh-token";
const MOCK_ACCESS_TOKEN = "integration-test-access-token";

// Cache a real 1-page PDF created by pdf-lib so Drive stub returns valid bytes.
let _minimalPdfCache: Uint8Array | undefined;
async function minimalPdfBytes(): Promise<Uint8Array> {
  if (!_minimalPdfCache) {
    const doc = await PDFDocument.create();
    doc.addPage();
    _minimalPdfCache = await doc.save();
  }
  return _minimalPdfCache;
}

// ─── Landlord setup helpers ───────────────────────────────────────────────

/**
 * Create a test landlord row in the DB (using service role to bypass RLS) and
 * return the landlord id. The google_refresh_token is set to MOCK_REFRESH_TOKEN
 * so fetch stubs can match the exchange call.
 */
async function createTestLandlord(): Promise<string> {
  // Create a Supabase Auth user first.
  const { data: authData, error: authError } = await adminClient.auth.admin
    .createUser({
      email: `export-test-${crypto.randomUUID()}@example.com`,
      password: "TestPass123!",
      email_confirm: true,
    });
  if (authError || !authData.user) {
    throw new Error(
      `Failed to create auth user: ${authError?.message ?? "unknown"}`,
    );
  }
  const userId = authData.user.id;

  // Insert a landlord row with required fields.
  const { error: insertError } = await adminClient.from("landlords").insert({
    id: userId,
    email: authData.user.email,
    name: "Integration Test Landlord",
    whatsapp: "+5511999999999",
    google_refresh_token: MOCK_REFRESH_TOKEN,
    autentique_api_key: "test-autentique-key",
    root_folder_id: "root-folder-id",
    templates_folder_id: "templates-folder-id",
    payment_reminder_frequency: "weekly",
  });
  if (insertError) {
    throw new Error(`Failed to insert landlord: ${insertError.message}`);
  }
  return userId;
}

/** Clean up the landlord row and auth user created during a test. */
async function deleteTestLandlord(userId: string): Promise<void> {
  await adminClient.from("landlords").delete().eq("id", userId);
  await adminClient.auth.admin.deleteUser(userId);
}

// ─── Fetch stub ───────────────────────────────────────────────────────────

type IntegrationFetchOpts = {
  /** Map of fileId → whether the export should succeed. Default: success. */
  exportResults?: Record<string, boolean>;
  /** Force token exchange to fail. */
  tokenExchangeFail?: boolean;
};

function buildIntegrationFetch(opts: IntegrationFetchOpts = {}) {
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

    // Google token refresh.
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

    // Drive export stub.
    if (
      url.includes("googleapis.com/drive/v3/files/") &&
      url.includes("/export")
    ) {
      const match = url.match(/\/files\/([^/]+)\/export/);
      const fileId = match ? decodeURIComponent(match[1]) : "__unknown__";
      const shouldSucceed = exportResults[fileId] !== false;
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
      `Unexpected fetch in integration test: ${
        (init as RequestInit | undefined)?.method ?? "GET"
      } ${url}`,
    );
  };
}

// ─── Helper: run with stubbed fetch ──────────────────────────────────────

async function runWithStubs(
  docs: { fileId: string; label: string }[],
  fetchOpts: IntegrationFetchOpts = {},
) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildIntegrationFetch(fetchOpts) as typeof fetch;
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
// integration: success path — two docs merged
// ═══════════════════════════════════════════════════════════════════════════

Deno.test(
  "integration: export — two docs merged into one PDF with correct page count",
  async () => {
    const landlordId = await createTestLandlord();
    try {
      // Verify the landlord row exists in the real DB.
      const { data: row, error } = await adminClient
        .from("landlords")
        .select("google_refresh_token")
        .eq("id", landlordId)
        .maybeSingle();
      assertEquals(error, null);
      assertEquals(
        (row as { google_refresh_token: string } | null)?.google_refresh_token,
        MOCK_REFRESH_TOKEN,
      );

      const result = await runWithStubs([
        { fileId: "doc-a-id", label: "Contrato" },
        { fileId: "doc-b-id", label: "Adendo" },
      ]);
      assertEquals(result.ok, true);
      if (result.ok) {
        // Two 1-page PDFs → 2 total pages.
        assertEquals(result.pageCount, 2);
        assertEquals(result.pdf instanceof Uint8Array, true);
        assertEquals(result.pdf.length > 0, true);
      }
    } finally {
      await deleteTestLandlord(landlordId);
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// integration: single doc success
// ═══════════════════════════════════════════════════════════════════════════

Deno.test(
  "integration: export — single doc returns ok:true with 1 page",
  async () => {
    const landlordId = await createTestLandlord();
    try {
      const result = await runWithStubs([
        { fileId: "single-doc-id", label: "Contrato" },
      ]);
      assertEquals(result.ok, true);
      if (result.ok) {
        assertEquals(result.pageCount, 1);
        const header = new TextDecoder().decode(result.pdf.slice(0, 4));
        assertEquals(header, "%PDF");
      }
    } finally {
      await deleteTestLandlord(landlordId);
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// integration: Drive export failure → structured error returned
// ═══════════════════════════════════════════════════════════════════════════

Deno.test(
  "integration: export — Drive failure returns ok:false with drive URL",
  async () => {
    const landlordId = await createTestLandlord();
    try {
      const failingFileId = "failing-doc-id";
      const result = await runWithStubs(
        [{ fileId: failingFileId, label: "Contrato" }],
        { exportResults: { [failingFileId]: false } },
      );
      assertEquals(result.ok, false);
      if (!result.ok) {
        assertStringIncludes(result.failedUrl, failingFileId);
        assertStringIncludes(result.driveUrl, "docs.google.com/document/d/");
        assertStringIncludes(result.driveUrl, failingFileId);
        assertStringIncludes(result.error, "drive_export_pdf_failed_500");
      }
    } finally {
      await deleteTestLandlord(landlordId);
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// integration: token exchange failure propagates
// ═══════════════════════════════════════════════════════════════════════════

Deno.test(
  "integration: export — Google token refresh failure throws",
  async () => {
    const landlordId = await createTestLandlord();
    let threw = false;
    try {
      await runWithStubs(
        [{ fileId: "any-doc-id", label: "Contrato" }],
        { tokenExchangeFail: true },
      );
    } catch {
      threw = true;
    } finally {
      await deleteTestLandlord(landlordId);
    }
    assertEquals(threw, true);
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// integration: empty docs list
// ═══════════════════════════════════════════════════════════════════════════

Deno.test(
  "integration: export — empty docs list returns ok:true with 0 pages",
  async () => {
    const landlordId = await createTestLandlord();
    try {
      const result = await runWithStubs([]);
      assertEquals(result.ok, true);
      if (result.ok) {
        assertEquals(result.pageCount, 0);
      }
    } finally {
      await deleteTestLandlord(landlordId);
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// integration: first failure stops at first doc (second not fetched)
// ═══════════════════════════════════════════════════════════════════════════

Deno.test(
  "integration: export — stops at first failure, does not attempt remaining docs",
  async () => {
    const landlordId = await createTestLandlord();
    let secondDocFetched = false;
    const originalFetch = globalThis.fetch;

    const base = buildIntegrationFetch({
      exportResults: { "first-doc-id": false, "second-doc-id": true },
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
      if (url.includes("second-doc-id")) secondDocFetched = true;
      return base(input, init);
    } as typeof fetch;

    try {
      const result = await exportAndMergePdfs({
        refreshToken: MOCK_REFRESH_TOKEN,
        docs: [
          { fileId: "first-doc-id", label: "Contrato" },
          { fileId: "second-doc-id", label: "Adendo" },
        ],
      });
      assertEquals(result.ok, false);
      assertEquals(secondDocFetched, false);
    } finally {
      globalThis.fetch = originalFetch;
      await deleteTestLandlord(landlordId);
    }
  },
);

// Suppress "unused import" — adminClient is used for landlord lifecycle helpers above.
void adminClient;
void SUPABASE_ANON_KEY;
