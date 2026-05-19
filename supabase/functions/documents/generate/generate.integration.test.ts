// integration: POST /documents/generate — real local Supabase instance
//
// These tests call handleGenerateDocuments() against a real local Supabase DB
// (Auth + PostgREST + RLS). Google Drive calls are intercepted via a
// globalThis.fetch wrapper that passes Drive requests to a stub and forwards
// everything else to the real Supabase stack.
//
// Prerequisites: `supabase start` must be running.
// Test naming follows the ci.sh filter: "unit|integration".

import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createClient } from "@supabase/supabase-js";

// ─── Local Supabase configuration ────────────────────────────────────────

const SUPABASE_URL = "http://localhost:54321";
// Default local anon and service role keys from `supabase start`.
const ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRFA0NiK7W9oaLFwQ1egSTumqSwalckNOm0NqZouAKc";
const SERVICE_ROLE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hj04zWl196z2-SBc0";

// ─── Availability check ───────────────────────────────────────────────────

let supabaseAvailable = false;

try {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/`, {
    headers: { apikey: ANON_KEY },
    signal: AbortSignal.timeout(2000),
  });
  supabaseAvailable = r.status < 500;
} catch {
  supabaseAvailable = false;
}

function skipIfUnavailable(): boolean {
  if (!supabaseAvailable) {
    console.log("  [SKIP] local Supabase not running — skipping integration test");
    return true;
  }
  return false;
}

// ─── Environment setup (handler reads these) ──────────────────────────────

Deno.env.set("SUPABASE_URL", SUPABASE_URL);
Deno.env.set("SUPABASE_ANON_KEY", ANON_KEY);
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);
Deno.env.set("GOOGLE_CLIENT_ID", "test-google-client-id");
Deno.env.set("GOOGLE_CLIENT_SECRET", "test-google-client-secret");

import { handleGenerateDocuments } from "./index.ts";

// ─── Admin client (service role, bypasses RLS) ────────────────────────────

const adminDb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ─── Drive stub helpers ───────────────────────────────────────────────────

const MOCK_DRIVE_FILE_ID = "new-doc-drive-file-id";
const MOCK_ACCESS_TOKEN = "mock-google-access-token";

/** Wrap globalThis.fetch so that Drive API calls go to a stub while
 *  all other requests (Supabase Auth, PostgREST) reach the real local stack. */
function installDriveStub(opts: {
  templateContent?: string;
  driveCopyFail?: boolean;
  driveExportFail?: boolean;
  driveUpdateFail?: boolean;
}): () => void {
  const original = globalThis.fetch;

  globalThis.fetch = async function (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
        ? input.href
        : (input as Request).url;
    const method = (init as RequestInit | undefined)?.method?.toUpperCase() ?? "GET";

    // Google token refresh
    if (url.includes("oauth2.googleapis.com/token")) {
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

    // Drive: search for existing file in folder
    if (
      url.includes("drive.googleapis.com/drive/v3/files") &&
      method === "GET" &&
      url.includes("trashed")
    ) {
      return new Response(JSON.stringify({ files: [] }), { status: 200 });
    }

    // Drive: copy file
    if (url.includes("/copy") && method === "POST") {
      if (opts.driveCopyFail) {
        return new Response(JSON.stringify({ error: "server_error" }), { status: 500 });
      }
      return new Response(JSON.stringify({ id: MOCK_DRIVE_FILE_ID }), { status: 200 });
    }

    // Drive: export file as text
    if (url.includes("/export") && method === "GET") {
      if (opts.driveExportFail) {
        return new Response("error", { status: 500 });
      }
      return new Response(
        opts.templateContent ??
          "Contrato: {{nome do inquilino}}, CPF {{cpf do inquilino}}.",
        { status: 200 },
      );
    }

    // Drive: media upload (write substituted content)
    if (url.includes("upload/drive/v3/files") && method === "PATCH") {
      if (opts.driveUpdateFail) {
        return new Response(JSON.stringify({ error: "server_error" }), { status: 500 });
      }
      return new Response(JSON.stringify({ id: MOCK_DRIVE_FILE_ID }), { status: 200 });
    }

    // Drive: delete file
    if (url.includes("drive.googleapis.com/drive/v3/files/") && method === "DELETE") {
      return new Response(null, { status: 204 });
    }

    // Everything else (Supabase Auth, PostgREST) → real stack
    return original(input, init);
  } as typeof fetch;

  // Return a restore function
  return () => {
    globalThis.fetch = original;
  };
}

// ─── Test data helpers ────────────────────────────────────────────────────

async function createTestUser(email: string): Promise<{ id: string; jwt: string }> {
  const password = "TestPassword123!";
  const { data, error } = await adminDb.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`Failed to create user: ${error?.message}`);

  // Sign in to get a JWT
  const anonClient = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: session, error: signInError } = await anonClient.auth.signInWithPassword({
    email,
    password,
  });
  if (signInError || !session.session) {
    throw new Error(`Failed to sign in: ${signInError?.message}`);
  }
  return { id: data.user.id, jwt: session.session.access_token };
}

async function deleteTestUser(userId: string): Promise<void> {
  await adminDb.auth.admin.deleteUser(userId);
}

async function seedTestData(userId: string): Promise<{
  propertyId: string;
  tenantId: string;
  templateId: string;
}> {
  // Insert landlord row (bypasses RLS via service role)
  const { error: landlordError } = await adminDb.from("landlords").insert({
    id: userId,
    email: `test-${userId}@example.com`,
    name: "Test Landlord",
    whatsapp: "+5511999990000",
    google_refresh_token: "mock-refresh-token",
    autentique_api_key: "mock-autentique-key",
    root_folder_id: "root-folder-id",
    templates_folder_id: "templates-folder-id",
  });
  if (landlordError) throw new Error(`Failed to insert landlord: ${landlordError.message}`);

  // Insert placeholder definitions
  const { error: pError } = await adminDb.from("placeholders").insert([
    {
      landlord_id: userId,
      name: "nome do inquilino",
      required: true,
      format: "text",
      case: "título",
    },
    {
      landlord_id: userId,
      name: "cpf do inquilino",
      required: true,
      format: "cpf",
      case: null,
    },
  ]);
  if (pError) throw new Error(`Failed to insert placeholders: ${pError.message}`);

  // Insert property
  const { data: propData, error: propError } = await adminDb
    .from("properties")
    .insert({
      landlord_id: userId,
      type: "house",
      name: "Casa Teste",
      address: "Rua Teste, 1",
      drive_folder_id: "prop-drive-folder-id",
    })
    .select("id")
    .single();
  if (propError || !propData) throw new Error(`Failed to insert property: ${propError?.message}`);
  const propertyId = propData.id as string;

  // Insert tenant
  const { data: tenantData, error: tenantError } = await adminDb
    .from("tenants")
    .insert({
      landlord_id: userId,
      property_id: propertyId,
      name: "João Silva",
      cpf: "123.456.789-00",
      drive_folder_id: "tenant-drive-folder-id",
    })
    .select("id")
    .single();
  if (tenantError || !tenantData) {
    throw new Error(`Failed to insert tenant: ${tenantError?.message}`);
  }
  const tenantId = tenantData.id as string;

  // Insert template
  const { data: templateData, error: templateError } = await adminDb
    .from("templates")
    .insert({
      landlord_id: userId,
      drive_file_id: "template-drive-file-id",
      name: "Contrato de Locação",
      drive_last_modified_at: new Date().toISOString(),
      placeholder_names: ["nome do inquilino", "cpf do inquilino"],
    })
    .select("id")
    .single();
  if (templateError || !templateData) {
    throw new Error(`Failed to insert template: ${templateError?.message}`);
  }
  const templateId = templateData.id as string;

  // Map template to property type
  const { error: mappingError } = await adminDb.from("property_type_templates").insert({
    landlord_id: userId,
    property_type: "house",
    template_id: templateId,
  });
  if (mappingError) throw new Error(`Failed to insert mapping: ${mappingError.message}`);

  return { propertyId, tenantId, templateId };
}

async function cleanupTestData(userId: string): Promise<void> {
  // Cascade deletes handle all child rows when the landlord (and auth user) is deleted.
  await adminDb.from("landlords").delete().eq("id", userId);
  await deleteTestUser(userId);
}

// ─── Request helpers ──────────────────────────────────────────────────────

function makePostRequest(body: unknown, jwt: string): Request {
  return new Request("http://localhost/documents/generate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify(body),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// integration: POST /documents/generate — real Supabase DB, Drive mocked
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("integration: generate — 200 happy path against real DB", async () => {
  if (skipIfUnavailable()) return;

  const { id: userId, jwt } = await createTestUser(
    `gen-happy-${Date.now()}@test.example`,
  );
  const { propertyId, tenantId } = await seedTestData(userId);
  const restore = installDriveStub({
    templateContent: "Contrato: {{nome do inquilino}}, CPF {{cpf do inquilino}}.",
  });

  try {
    const res = await handleGenerateDocuments(
      makePostRequest(
        {
          property_id: propertyId,
          tenant_id: tenantId,
          placeholders: {
            "nome do inquilino": "João Silva",
            "cpf do inquilino": "123.456.789-00",
          },
        },
        jwt,
      ),
    );
    assertEquals(res.status, 200);
    const body = await res.json() as { documents: Array<{ template_name: string; drive_url: string }> };
    assertEquals(Array.isArray(body.documents), true);
    assertEquals(body.documents.length, 1);
    assertEquals(body.documents[0].template_name, "Contrato de Locação");
    assertStringIncludes(body.documents[0].drive_url, MOCK_DRIVE_FILE_ID);
  } finally {
    restore();
    await cleanupTestData(userId);
  }
});

Deno.test("integration: generate — 422 when required placeholder omitted (real DB)", async () => {
  if (skipIfUnavailable()) return;

  const { id: userId, jwt } = await createTestUser(
    `gen-422-${Date.now()}@test.example`,
  );
  const { propertyId, tenantId } = await seedTestData(userId);
  const restore = installDriveStub({});

  try {
    const res = await handleGenerateDocuments(
      makePostRequest(
        {
          property_id: propertyId,
          tenant_id: tenantId,
          // "cpf do inquilino" is required but omitted
          placeholders: { "nome do inquilino": "João Silva" },
        },
        jwt,
      ),
    );
    assertEquals(res.status, 422);
    const body = await res.json() as { error: { code: string; message: string } };
    assertEquals(body.error.code, "MISSING_REQUIRED_PLACEHOLDERS");
    assertStringIncludes(body.error.message, "cpf do inquilino");
  } finally {
    restore();
    await cleanupTestData(userId);
  }
});

Deno.test("integration: generate — 400 when unknown placeholder key sent (real DB)", async () => {
  if (skipIfUnavailable()) return;

  const { id: userId, jwt } = await createTestUser(
    `gen-400-${Date.now()}@test.example`,
  );
  const { propertyId, tenantId } = await seedTestData(userId);
  const restore = installDriveStub({});

  try {
    const res = await handleGenerateDocuments(
      makePostRequest(
        {
          property_id: propertyId,
          tenant_id: tenantId,
          placeholders: {
            "nome do inquilino": "João Silva",
            "cpf do inquilino": "123.456.789-00",
            "campo_desconhecido": "valor",
          },
        },
        jwt,
      ),
    );
    assertEquals(res.status, 400);
    const body = await res.json() as { error: { code: string } };
    assertEquals(body.error.code, "UNKNOWN_PLACEHOLDER");
  } finally {
    restore();
    await cleanupTestData(userId);
  }
});

Deno.test("integration: generate — 401 when JWT is invalid (real DB)", async () => {
  if (skipIfUnavailable()) return;

  const restore = installDriveStub({});
  try {
    const res = await handleGenerateDocuments(
      makePostRequest(
        {
          property_id: "00000000-0000-0000-0000-000000000001",
          tenant_id: "00000000-0000-0000-0000-000000000002",
          placeholders: {},
        },
        "invalid.jwt.token",
      ),
    );
    assertEquals(res.status, 401);
    const body = await res.json() as { error: { code: string } };
    assertEquals(body.error.code, "UNAUTHORIZED");
  } finally {
    restore();
  }
});

Deno.test("integration: generate — RLS blocks cross-landlord access (real DB)", async () => {
  if (skipIfUnavailable()) return;

  // Create two landlords. Landlord B tries to generate documents for landlord A's property.
  const { id: userAId, jwt: _jwtA } = await createTestUser(
    `gen-rls-a-${Date.now()}@test.example`,
  );
  const { id: userBId, jwt: jwtB } = await createTestUser(
    `gen-rls-b-${Date.now()}@test.example`,
  );
  const { propertyId, tenantId } = await seedTestData(userAId);
  await seedTestData(userBId);
  const restore = installDriveStub({});

  try {
    // Landlord B's JWT used with landlord A's property → RLS returns 404 (property not visible)
    const res = await handleGenerateDocuments(
      makePostRequest(
        {
          property_id: propertyId,
          tenant_id: tenantId,
          placeholders: {
            "nome do inquilino": "João Silva",
            "cpf do inquilino": "123.456.789-00",
          },
        },
        jwtB,
      ),
    );
    // RLS hides the row, so the handler sees it as not found.
    assertEquals(res.status, 404);
  } finally {
    restore();
    await cleanupTestData(userAId);
    await cleanupTestData(userBId);
  }
});
