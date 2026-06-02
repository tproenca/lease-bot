// integration: POST /workflow/next — full add_tenant conversation e2e
//
// Steps through the entire add_tenant flow against the real local Supabase DB:
//   menu → ask_property → ask_name → ask_cpf → ask_whatsapp → confirm → done
//
// loadContext uses the real handleContext (real DB queries, real RLS).
// createTenant and loadTemplatesDiff are stubbed to avoid Google Drive/Sheets
// calls unavailable in the local test environment.
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
        { intent: t2.intent, values: t2.values, message: "1" },
        jwt,
      );
      assertEquals(t3.intent, "add_tenant");
      assertEquals(t3.step, "ask_name");

      // Turn 4: provide name → ask_cpf.
      const t4 = await callNext(
        handler,
        { intent: t3.intent, values: t3.values, message: "João Silva" },
        jwt,
      );
      assertEquals(t4.step, "ask_cpf");

      // Turn 5: provide valid CPF → ask_whatsapp.
      const t5 = await callNext(
        handler,
        { intent: t4.intent, values: t4.values, message: "123.456.789-09" },
        jwt,
      );
      assertEquals(t5.step, "ask_whatsapp");

      // Turn 6: skip whatsapp → confirm with summary.
      const t6 = await callNext(
        handler,
        { intent: t5.intent, values: t5.values, message: "pular" },
        jwt,
      );
      assertEquals(t6.step, "confirm");
      assertStringIncludes(t6.message as string, "João Silva");
      assertStringIncludes(t6.message as string, "123.456.789-09");

      // Turn 7: confirm → done.
      const t7 = await callNext(
        handler,
        { intent: t6.intent, values: t6.values, message: "Sim" },
        jwt,
      );
      assertEquals(t7.step, "done");
      assertStringIncludes(t7.message as string, "Inquilino adicionado");
    } finally {
      // Teardown — always runs even if assertions fail.
      await adminDb.from("properties").delete().eq("id", TEST_PROPERTY_ID);
      await adminDb.from("landlords").delete().eq("id", user.id);
      await adminDb.auth.admin.deleteUser(user.id);
    }
  },
);
