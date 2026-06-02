// integration: GET /context — schema drift guard
//
// Calls handleContext() against the real local Supabase DB to verify that the
// query succeeds and the response shape matches the current schema, including
// columns added by recent migrations (e.g. templates.use_case from
// 20260602002337_templates_use_case.sql).
//
// A real user is created and signed in to obtain a valid JWT so that
// PostgREST's RLS checks pass. The Supabase Auth getUser call (used by
// handleContext to identify the caller) is stubbed to avoid a second network
// round-trip — the same user ID is returned. All DB operations (landlords,
// templates, etc.) go to the real local instance.
//
// Prerequisites: `supabase start` must be running.
// Test names follow the "integration:" prefix convention.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createClient } from "@supabase/supabase-js";

// ─── Local Supabase config ────────────────────────────────────────────────────

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRFA0NiK7W9oaLFwQ1egSTumqSwalckNOm0NqZouAKc";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hj04zWl196z2-SBc0";

// ─── Availability check ───────────────────────────────────────────────────────

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
    console.log(
      "  [SKIP] local Supabase not running — skipping integration test",
    );
    return true;
  }
  return false;
}

// ─── Env setup ────────────────────────────────────────────────────────────────

Deno.env.set("SUPABASE_URL", SUPABASE_URL);
Deno.env.set("SUPABASE_ANON_KEY", ANON_KEY);
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);

import { handleContext } from "./index.ts";

// ─── Clients ──────────────────────────────────────────────────────────────────

const adminDb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const anonClient = createClient(SUPABASE_URL, ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ─── Constants ────────────────────────────────────────────────────────────────

const TEST_EMAIL = "context-integration-test@test.local";
const TEST_PASSWORD = "integration-test-password-123!";
const TEST_TEMPLATE_ID = "00000000-0000-0000-0000-ccbb00000001";

// ─── Fetch stub ───────────────────────────────────────────────────────────────

/**
 * Build a fetch stub that intercepts Supabase Auth (getUser) and forwards all
 * real DB/REST calls to the local Supabase stack. This is needed because
 * getAuthenticatedUser() in the handler sends the JWT to /auth/v1/user — by
 * stubbing that call we return the test user's real ID without requiring a
 * second network hop. All PostgREST queries (/rest/v1/) are forwarded to the
 * real local stack and validated against RLS using the real JWT.
 */
function buildContextFetchStub(
  userId: string,
  userEmail: string,
): typeof fetch {
  const realFetch = globalThis.fetch;
  return async function (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : (input as Request).url;

    // Supabase Auth: getUser — return the real user ID so RLS binds to the
    // seeded landlord row. All other calls (PostgREST, etc.) pass through.
    if (url.includes("/auth/v1/user")) {
      return new Response(
        JSON.stringify({
          id: userId,
          email: userEmail,
          user_metadata: {},
          app_metadata: {},
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Forward all other calls (PostgREST table queries) to the real local stack.
    return realFetch(input, init);
  } as typeof fetch;
}

// ─── Integration test ─────────────────────────────────────────────────────────

Deno.test(
  "integration: GET /context — returns 200 with use_case on each template",
  async () => {
    if (skipIfUnavailable()) return;

    // 1. Create test user via Supabase Auth admin API.
    const { data: userData, error: createError } = await adminDb.auth.admin
      .createUser({
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
        email_confirm: true,
      });
    if (createError || !userData.user) {
      throw new Error(`Failed to create user: ${createError?.message}`);
    }
    const user = userData.user;

    try {
      // 2. Seed landlord row using service role (bypasses RLS).
      const { error: landlordError } = await adminDb.from("landlords").insert({
        id: user.id,
        email: TEST_EMAIL,
        name: "Integração Context",
        whatsapp: "+5511999999999",
        payment_reminder_frequency: "weekly",
        google_refresh_token: "test-refresh-token",
        autentique_api_key: "test-autentique-key",
        autentique_webhook_secret: "test-webhook-secret",
        root_folder_id: "test-root-folder",
        templates_folder_id: "test-templates-folder",
      });
      if (landlordError) {
        throw new Error(`Landlord seed failed: ${landlordError.message}`);
      }

      // 3. Seed a template row with use_case so the context query exercises the
      //    new column from migration 20260602002337_templates_use_case.sql.
      const { error: templateError } = await adminDb.from("templates").insert({
        id: TEST_TEMPLATE_ID,
        landlord_id: user.id,
        name: "Contrato Teste Integração",
        use_case: "initial",
        drive_file_id: "test-drive-file-id",
        last_modified_at: new Date().toISOString(),
      });
      if (templateError) {
        throw new Error(`Template seed failed: ${templateError.message}`);
      }

      // 4. Sign in as the test user to get a real JWT. The JWT is passed to
      //    handleContext so that the user-scoped DB client's PostgREST queries
      //    are authenticated and RLS resolves auth.uid() to user.id.
      const { data: sessionData, error: signInError } = await anonClient.auth
        .signInWithPassword({ email: TEST_EMAIL, password: TEST_PASSWORD });
      if (signInError || !sessionData.session) {
        throw new Error(`Sign in failed: ${signInError?.message}`);
      }
      const jwt = sessionData.session.access_token;

      // 5. Stub only the Auth getUser call — DB queries pass through to the
      //    real local Supabase stack where RLS validates the JWT.
      const originalFetch = globalThis.fetch;
      globalThis.fetch = buildContextFetchStub(user.id, TEST_EMAIL);

      try {
        const req = new Request(`${SUPABASE_URL}/functions/v1/context`, {
          method: "GET",
          headers: { Authorization: `Bearer ${jwt}` },
        });

        const res = await handleContext(req);
        assertEquals(res.status, 200);

        const body = await res.json() as Record<string, unknown>;

        // landlord section
        const landlord = body.landlord as Record<string, unknown>;
        assertEquals(landlord.name, "Integração Context");

        // templates section — must include use_case on every item
        const templates = body.templates as Array<Record<string, unknown>>;
        assertEquals(
          templates.length >= 1,
          true,
          "Expected at least one template in context response",
        );

        const seeded = templates.find((t) => t.id === TEST_TEMPLATE_ID);
        assertEquals(
          seeded !== undefined,
          true,
          "Seeded template must appear in context response",
        );
        assertEquals(
          seeded!.use_case,
          "initial",
          "Template must expose use_case field from DB (migration 20260602002337)",
        );
        assertEquals(
          Array.isArray(seeded!.property_types),
          true,
          "Template must include property_types array",
        );

        // other sections present and array-shaped
        assertEquals(Array.isArray(body.properties), true);
        assertEquals(Array.isArray(body.buildings), true);
        assertEquals(Array.isArray(body.placeholders), true);
        assertEquals(Array.isArray(body.witnesses), true);
        assertEquals(Array.isArray(body.tenants), true);
        assertEquals(Array.isArray(body.cron_errors), true);
        assertEquals(
          typeof body.account_config,
          "object",
          "account_config must be present",
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    } finally {
      // Teardown — always runs even if assertions fail.
      await adminDb.from("templates").delete().eq("id", TEST_TEMPLATE_ID);
      await adminDb.from("landlords").delete().eq("id", user.id);
      await adminDb.auth.admin.deleteUser(user.id);
    }
  },
);
