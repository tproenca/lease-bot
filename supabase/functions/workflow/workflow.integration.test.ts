// integration: POST /workflow/next — full add_tenant conversation e2e + auth boundaries
//
// Steps through the entire add_tenant flow against the real local Supabase DB:
//   menu → ask_property → ask_name → ask_cpf → ask_whatsapp → confirm → done
//
// Also verifies all three auth boundary states end-to-end through the handler:
//   1. Invalid/missing JWT → 401 UNAUTHORIZED (no Supabase DB needed)
//   2. Unregistered user (valid JWT, no landlord row) → onboarding response
//   3. Expired Google OAuth (GOOGLE_REAUTH_REQUIRED) → reauth boundary response
//
// loadContext uses the real handleContext (real DB queries, real RLS) for
// boundary scenarios 1 and 2. Scenario 3 uses a stubbed loadContext because
// GET /context does not itself return GOOGLE_REAUTH_REQUIRED — that code is
// returned by write endpoints (createTenant, etc.) when the landlord's Google
// refresh token has expired. The stub confirms the boundary wiring in the
// handler is correct.
//
// Prerequisites: `supabase start` must be running.
// Test names follow the "integration:" prefix convention.

import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
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
Deno.env.set("PUBLIC_FUNCTIONS_BASE_URL", `${SUPABASE_URL}/functions/v1`);
Deno.env.set("GOOGLE_CLIENT_ID", "test-google-client-id");
Deno.env.set("GOOGLE_CLIENT_SECRET", "test-google-client-secret");

import { handleWorkflowNext, type WorkflowDeps } from "./index.ts";
import { invokeHandler } from "../_shared/internal.ts";
import { handleContext } from "../context/index.ts";

// ─── Clients ──────────────────────────────────────────────────────────────────

const adminDb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ─── Constants ────────────────────────────────────────────────────────────────

const TEST_EMAIL = "workflow-integration-add-tenant@test.local";
const TEST_PASSWORD = "integration-test-password-123!";
const TEST_PROPERTY_ID = "00000000-0000-0000-0000-aabb00000101";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeReq(body: unknown, jwt: string): Request {
  return new Request("http://localhost/workflow/next", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify(body),
  });
}

async function callNext(
  handler: (req: Request) => Promise<Response>,
  body: unknown,
  jwt: string,
): Promise<Record<string, unknown>> {
  const res = await handler(makeReq(body, jwt));
  assertEquals(res.status, 200);
  return await res.json() as Record<string, unknown>;
}

// ─── Integration test ─────────────────────────────────────────────────────────

Deno.test(
  "integration: workflow/next — full add_tenant flow from menu to done",
  async () => {
    if (skipIfUnavailable()) return;

    // 1. Create test user.
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
      // 2. Seed landlord + property using service role (bypasses RLS).
      const { error: landlordError } = await adminDb.from("landlords").insert({
        id: user.id,
        email: TEST_EMAIL,
        name: "Integração",
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

      const { error: propertyError } = await adminDb.from("properties").insert({
        id: TEST_PROPERTY_ID,
        landlord_id: user.id,
        type: "apartment",
        name: "Apto Teste 101",
        drive_folder_id: "test-property-drive-folder",
        current_tenant_folder_id: null,
      });
      if (propertyError) {
        throw new Error(`Property seed failed: ${propertyError.message}`);
      }

      // 3. Sign in to get a real JWT.
      const anonClient = createClient(SUPABASE_URL, ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data: sessionData, error: signInError } = await anonClient.auth
        .signInWithPassword({ email: TEST_EMAIL, password: TEST_PASSWORD });
      if (signInError || !sessionData.session) {
        throw new Error(`Sign in failed: ${signInError?.message}`);
      }
      const jwt = sessionData.session.access_token;

      // 4. Custom deps: real context, stubbed createTenant and loadTemplatesDiff.
      const deps: WorkflowDeps = {
        loadContext: (j) =>
          invokeHandler(handleContext, {
            method: "GET",
            path: "/context",
            jwt: j,
          }),
        loadTemplatesDiff: (_j) =>
          Promise.resolve({
            status: 200,
            body: {
              templates: { added: [], removed: [] },
              placeholders: { added: [], removed: [] },
              witnesses: { added: [] },
            },
          }),
        createTenant: (_j, _payload) =>
          Promise.resolve({
            status: 201,
            body: {
              id: "integration-tenant-uuid",
              drive_folder_id: "integration-drive-folder",
            },
          }),
        generateDocument: (_j, _payload) =>
          Promise.resolve({ status: 200, body: {} }),
        createProperty: (_j, _payload) =>
          Promise.resolve({ status: 201, body: {} }),
        sendSignature: (_j, _payload) =>
          Promise.resolve({ status: 201, body: {} }),
      };
      const handler = handleWorkflowNext(deps);

      // Turn 1: any first message → menu.
      const t1 = await callNext(handler, { message: "oie" }, jwt);
      assertEquals(t1.step, "menu");
      assertStringIncludes(t1.message as string, "Integração");
      const opts1 = t1.options as Array<{ label: string; value: string }>;
      const addOpt = opts1.find((o) => o.value === "add_tenant");
      assertStringIncludes(addOpt?.label ?? "", "nquilino");

      // Turn 2: select add_tenant (menu option 5) → ask_property.
      const t2 = await callNext(handler, { message: "5" }, jwt);
      assertEquals(t2.intent, "add_tenant");
      assertEquals(t2.step, "ask_property");
      assertStringIncludes(t2.message as string, "imóvel");
      const opts2 = t2.options as Array<{ label: string; value: string }>;
      assertEquals(opts2.length, 1);
      assertStringIncludes(opts2[0].label, "Apto Teste 101");

      // Turn 3: select property 1 → ask_name.
      const t3 = await callNext(
        handler,
        { intent: t2.intent, state: t2.state, message: "1" },
        jwt,
      );
      assertEquals(t3.intent, "add_tenant");
      assertEquals(t3.step, "ask_name");

      // Turn 4: provide name → ask_cpf.
      const t4 = await callNext(
        handler,
        { intent: t3.intent, state: t3.state, message: "João Silva" },
        jwt,
      );
      assertEquals(t4.step, "ask_cpf");

      // Turn 5: provide valid CPF → ask_whatsapp.
      const t5 = await callNext(
        handler,
        { intent: t4.intent, state: t4.state, message: "123.456.789-09" },
        jwt,
      );
      assertEquals(t5.step, "ask_whatsapp");

      // Turn 6: skip whatsapp → confirm with summary.
      const t6 = await callNext(
        handler,
        { intent: t5.intent, state: t5.state, message: "pular" },
        jwt,
      );
      assertEquals(t6.step, "confirm");
      assertStringIncludes(t6.message as string, "João Silva");
      assertStringIncludes(t6.message as string, "123.456.789-09");

      // Turn 7: confirm → step:done auto-transitions to menu with success message prepended.
      const t7 = await callNext(
        handler,
        { intent: t6.intent, state: t6.state, message: "Sim" },
        jwt,
      );
      assertEquals(t7.step, "menu");
      assertStringIncludes(t7.message as string, "Inquilino adicionado");
    } finally {
      // Teardown — always runs even if assertions fail.
      await adminDb.from("properties").delete().eq("id", TEST_PROPERTY_ID);
      await adminDb.from("landlords").delete().eq("id", user.id);
      await adminDb.auth.admin.deleteUser(user.id);
    }
  },
);

// ─── Auth boundary: invalid/missing JWT → 401 ────────────────────────────────
//
// This boundary is enforced by the JWT verification layer before any DB query.
// No Supabase instance is needed; the handler rejects the request immediately.

Deno.test(
  "integration: workflow/next — missing JWT returns 401 UNAUTHORIZED",
  async () => {
    if (skipIfUnavailable()) return;

    // Use a minimal stub — the handler must never reach loadContext.
    const deps: WorkflowDeps = {
      loadContext: (_j) => {
        throw new Error("loadContext must not be called when JWT is absent");
      },
      loadTemplatesDiff: (_j) => Promise.resolve({ status: 200, body: {} }),
      createTenant: (_j, _p) => Promise.resolve({ status: 201, body: {} }),
      generateDocument: (_j, _p) => Promise.resolve({ status: 200, body: {} }),
      createProperty: (_j, _p) => Promise.resolve({ status: 201, body: {} }),
      sendSignature: (_j, _p) => Promise.resolve({ status: 201, body: {} }),
    };
    const handler = handleWorkflowNext(deps);

    // Request with no Authorization header.
    const res = await handler(
      new Request("http://localhost/workflow/next", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "oi" }),
      }),
    );

    assertEquals(res.status, 401);
    const body = await res.json() as Record<string, Record<string, string>>;
    assertEquals(body.error.code, "UNAUTHORIZED");
  },
);

Deno.test(
  "integration: workflow/next — invalid JWT returns 401 UNAUTHORIZED",
  async () => {
    if (skipIfUnavailable()) return;

    // Use real handleContext with a real Supabase instance so JWT verification
    // goes through the actual auth.getUser() call.
    const deps: WorkflowDeps = {
      loadContext: (j) =>
        invokeHandler(handleContext, {
          method: "GET",
          path: "/context",
          jwt: j,
        }),
      loadTemplatesDiff: (_j) => Promise.resolve({ status: 200, body: {} }),
      createTenant: (_j, _p) => Promise.resolve({ status: 201, body: {} }),
      generateDocument: (_j, _p) => Promise.resolve({ status: 200, body: {} }),
      createProperty: (_j, _p) => Promise.resolve({ status: 201, body: {} }),
      sendSignature: (_j, _p) => Promise.resolve({ status: 201, body: {} }),
    };
    const handler = handleWorkflowNext(deps);

    const res = await handler(
      new Request("http://localhost/workflow/next", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer not-a-real-jwt",
        },
        body: JSON.stringify({ message: "oi" }),
      }),
    );

    assertEquals(res.status, 401);
    const body = await res.json() as Record<string, Record<string, string>>;
    assertEquals(body.error.code, "UNAUTHORIZED");
  },
);

// ─── Auth boundary: unregistered user → onboarding ───────────────────────────
//
// A user who has a valid Supabase JWT (authenticated) but has not completed
// the setup flow (no landlord row in the DB) should receive an onboarding
// message with a link to the setup URL.

Deno.test(
  {
    name:
      "integration: workflow/next — unregistered user receives onboarding response with setup URL",
    // sanitizeResources: false because handleContext runs parallel DB queries
    // via the Supabase JS SDK; the SDK's internal streaming responses may not
    // be fully consumed before Deno's resource tracker checks them.
    sanitizeResources: false,
    sanitizeOps: false,
    fn: async () => {
      if (skipIfUnavailable()) return;

      const UNREGISTERED_EMAIL = "workflow-integration-unregistered@test.local";
      const UNREGISTERED_PASSWORD = "integration-test-unregistered-456!";

      // Create a Supabase user with no corresponding landlord row.
      const { data: userData, error: createError } = await adminDb.auth.admin
        .createUser({
          email: UNREGISTERED_EMAIL,
          password: UNREGISTERED_PASSWORD,
          email_confirm: true,
        });
      if (createError || !userData.user) {
        throw new Error(`Failed to create user: ${createError?.message}`);
      }
      const user = userData.user;

      try {
        // Sign in to get a real JWT — this user has no landlord row.
        const anonClient = createClient(SUPABASE_URL, ANON_KEY, {
          auth: { persistSession: false, autoRefreshToken: false },
        });
        const { data: sessionData, error: signInError } = await anonClient.auth
          .signInWithPassword({
            email: UNREGISTERED_EMAIL,
            password: UNREGISTERED_PASSWORD,
          });
        if (signInError || !sessionData.session) {
          throw new Error(`Sign in failed: ${signInError?.message}`);
        }
        const jwt = sessionData.session.access_token;

        // Use real context handler so GET /context returns LANDLORD_NOT_FOUND.
        const deps: WorkflowDeps = {
          loadContext: (j) =>
            invokeHandler(handleContext, {
              method: "GET",
              path: "/context",
              jwt: j,
            }),
          loadTemplatesDiff: (_j) => Promise.resolve({ status: 200, body: {} }),
          createTenant: (_j, _p) => Promise.resolve({ status: 201, body: {} }),
          generateDocument: (_j, _p) =>
            Promise.resolve({ status: 200, body: {} }),
          createProperty: (_j, _p) =>
            Promise.resolve({ status: 201, body: {} }),
          sendSignature: (_j, _p) => Promise.resolve({ status: 201, body: {} }),
        };
        const handler = handleWorkflowNext(deps);

        const res = await handler(makeReq({ message: "oi" }, jwt));
        assertEquals(res.status, 200);
        const body = await res.json() as Record<string, unknown>;

        // Should return the onboarding boundary response, not a generic error.
        assertEquals(body.step, "awaiting_setup");
        assertEquals(body.intent, "onboarding");
        assertEquals(body.state, null); // session boundary
        assertStringIncludes(body.message as string, "não está cadastrado");

        // Must include a link to the setup URL.
        const options = body.options as Array<{ label: string; value: string }>;
        assertEquals(Array.isArray(options), true);
        assertEquals(options.length, 1);
        assertEquals(options[0].label, "Abrir configuração");
        assertStringIncludes(options[0].value, "/setup");
      } finally {
        // Teardown — always runs even if assertions fail.
        await adminDb.auth.admin.deleteUser(user.id);
      }
    },
  },
);

// ─── Auth boundary: expired Google OAuth → reauth ────────────────────────────
//
// When the landlord's Google refresh token has expired, write endpoints (e.g.
// POST /tenants) return 401 GOOGLE_REAUTH_REQUIRED. The workflow handler
// surfaces this as a manual-reconnect message with step: reauth_required.
//
// GET /context does not itself return GOOGLE_REAUTH_REQUIRED — it is only
// returned by endpoints that call Google APIs. The stub below simulates the
// response that the handler would receive from a write endpoint to verify that
// the boundary wiring in loadContext() is correct.
//
// Known edge: the Supabase JWT remains valid when only the Google token expires.
// ChatGPT cannot auto-retrigger Google OAuth because its OAuth flow is tied to
// the Supabase credential. The user must manually reconnect in ChatGPT Settings.

Deno.test(
  "integration: workflow/next — expired Google OAuth triggers reauth boundary (step: reauth_required)",
  async () => {
    if (skipIfUnavailable()) return;

    // Stub loadContext to return GOOGLE_REAUTH_REQUIRED (simulates expired
    // Google refresh token surfaced via a write endpoint).
    const deps: WorkflowDeps = {
      loadContext: (_j) =>
        Promise.resolve({
          status: 401,
          body: {
            error: {
              code: "GOOGLE_REAUTH_REQUIRED",
              message: "Google token expired",
            },
          },
        }),
      loadTemplatesDiff: (_j) => Promise.resolve({ status: 200, body: {} }),
      createTenant: (_j, _p) => Promise.resolve({ status: 201, body: {} }),
      generateDocument: (_j, _p) => Promise.resolve({ status: 200, body: {} }),
      createProperty: (_j, _p) => Promise.resolve({ status: 201, body: {} }),
      sendSignature: (_j, _p) => Promise.resolve({ status: 201, body: {} }),
    };
    const handler = handleWorkflowNext(deps);

    // Use the local anon key as a dummy JWT — the handler will pass auth
    // (getAuthenticatedUser uses the local Supabase instance) but then
    // receive GOOGLE_REAUTH_REQUIRED from the stubbed loadContext.
    //
    // Create a real user so getAuthenticatedUser returns a non-null user.
    const REAUTH_EMAIL = "workflow-integration-reauth@test.local";
    const REAUTH_PASSWORD = "integration-test-reauth-789!";

    const { data: userData, error: createError } = await adminDb.auth.admin
      .createUser({
        email: REAUTH_EMAIL,
        password: REAUTH_PASSWORD,
        email_confirm: true,
      });
    if (createError || !userData.user) {
      throw new Error(`Failed to create user: ${createError?.message}`);
    }
    const user = userData.user;

    try {
      const anonClient = createClient(SUPABASE_URL, ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data: sessionData, error: signInError } = await anonClient.auth
        .signInWithPassword({ email: REAUTH_EMAIL, password: REAUTH_PASSWORD });
      if (signInError || !sessionData.session) {
        throw new Error(`Sign in failed: ${signInError?.message}`);
      }
      const jwt = sessionData.session.access_token;

      const res = await handler(makeReq({ message: "oi" }, jwt));
      assertEquals(res.status, 200);
      const body = await res.json() as Record<string, unknown>;

      // Must return the reauth boundary response.
      assertEquals(body.step, "reauth_required");
      assertEquals(body.intent, null);
      assertEquals(body.state, null); // session boundary
      // Message must be user-friendly Portuguese and mention Google Drive.
      assertStringIncludes(body.message as string, "Google Drive expirou");
      assertStringIncludes(body.message as string, "Reconecte");
    } finally {
      await adminDb.auth.admin.deleteUser(user.id);
    }
  },
);
