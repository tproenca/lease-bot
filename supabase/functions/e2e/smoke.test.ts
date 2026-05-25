// e2e smoke/regression: direct handlers + real local Supabase DB/Auth/RLS.
//
// External Google Drive/OAuth calls are mocked. Supabase Auth and PostgREST use
// the local Supabase service started by `supabase start`.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

Deno.env.set("SUPABASE_URL", SUPABASE_URL);
Deno.env.set("SUPABASE_ANON_KEY", ANON_KEY);
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);
Deno.env.set("GOOGLE_CLIENT_ID", "test-google-client-id");
Deno.env.set("GOOGLE_CLIENT_SECRET", "test-google-client-secret");

import { handleBuildings } from "../buildings/index.ts";
import { handleContext } from "../context/index.ts";
import { handleGenerateDocuments } from "../documents/generate/index.ts";
import { handlePayments } from "../payments/index.ts";
import { handleProperties } from "../properties/index.ts";
import { handleTenants } from "../tenants/index.ts";

const adminDb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const MOCK_ACCESS_TOKEN = "mock-google-access-token";
const MOCK_TEMPLATE_DRIVE_FILE_ID = "template-drive-file-id";
const MOCK_GENERATED_DOC_ID = "generated-doc-drive-file-id";

async function createTestUser(): Promise<{ id: string; jwt: string }> {
  const stamp = `${Date.now()}-${crypto.randomUUID()}`;
  const email = `smoke-${stamp}@test.example`;
  const password = "TestPassword123!";

  const { data, error } = await adminDb.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) {
    throw new Error(`Failed to create smoke user: ${error?.message}`);
  }

  const anonClient = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: session, error: signInError } = await anonClient.auth
    .signInWithPassword({ email, password });
  if (signInError || !session.session) {
    throw new Error(`Failed to sign in smoke user: ${signInError?.message}`);
  }

  return { id: data.user.id, jwt: session.session.access_token };
}

async function seedLandlord(userId: string): Promise<void> {
  const { error } = await adminDb.from("landlords").insert({
    id: userId,
    email: `landlord-${userId}@test.example`,
    name: "Smoke Landlord",
    whatsapp: "+5511999990000",
    google_refresh_token: "mock-refresh-token",
    autentique_api_key: "mock-autentique-key",
    autentique_webhook_secret: "mock-autentique-webhook-secret",
    root_folder_id: "root-folder-id",
    templates_folder_id: "templates-folder-id",
  });
  if (error) throw new Error(`Failed to seed landlord: ${error.message}`);
}

async function seedTemplate(userId: string): Promise<void> {
  const { error: placeholderError } = await adminDb.from("placeholders").insert(
    [
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
    ],
  );
  if (placeholderError) {
    throw new Error(`Failed to seed placeholders: ${placeholderError.message}`);
  }

  const { data: template, error: templateError } = await adminDb
    .from("templates")
    .insert({
      landlord_id: userId,
      drive_file_id: MOCK_TEMPLATE_DRIVE_FILE_ID,
      name: "Contrato de Locação",
      last_modified_at: new Date().toISOString(),
      placeholder_names: ["nome do inquilino", "cpf do inquilino"],
    })
    .select("id")
    .single();
  if (templateError || !template) {
    throw new Error(`Failed to seed template: ${templateError?.message}`);
  }

  const { error: mappingError } = await adminDb
    .from("property_type_templates")
    .insert({
      landlord_id: userId,
      property_type: "house",
      template_id: template.id,
    });
  if (mappingError) {
    throw new Error(`Failed to seed template mapping: ${mappingError.message}`);
  }
}

async function cleanup(userId: string): Promise<void> {
  await adminDb.from("landlords").delete().eq("id", userId);
  await adminDb.auth.admin.deleteUser(userId);
}

function installExternalApiStubs(): () => void {
  const original = globalThis.fetch;
  let folderCounter = 0;

  globalThis.fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : input.url;
    const method = init?.method?.toUpperCase() ?? "GET";

    if (url.includes("oauth2.googleapis.com/token")) {
      return Response.json({
        access_token: MOCK_ACCESS_TOKEN,
        expires_in: 3600,
        token_type: "Bearer",
        scope: "",
      });
    }

    if (url.includes("www.googleapis.com/drive/v3/files") && method === "GET") {
      if (url.includes("/export")) {
        return new Response(
          "Contrato: {{nome do inquilino}}, CPF {{cpf do inquilino}}.",
          { status: 200 },
        );
      }
      return Response.json({ files: [] });
    }

    if (
      url.includes("www.googleapis.com/drive/v3/files") && method === "POST"
    ) {
      if (url.includes("/copy")) {
        return Response.json({ id: MOCK_GENERATED_DOC_ID });
      }
      folderCounter++;
      return Response.json({ id: `drive-folder-${folderCounter}` });
    }

    if (
      url.includes("www.googleapis.com/drive/v3/files") && method === "DELETE"
    ) {
      return new Response(null, { status: 204 });
    }

    if (
      url.includes("www.googleapis.com/upload/drive/v3/files") &&
      method === "PATCH"
    ) {
      return Response.json({ id: MOCK_GENERATED_DOC_ID });
    }

    if (
      url.includes("www.googleapis.com/drive/v3/files") && method === "PATCH"
    ) {
      return Response.json({ id: "starred-file-id" });
    }

    return original(input, init);
  };

  return () => {
    globalThis.fetch = original;
  };
}

function authedRequest(
  path: string,
  jwt: string,
  options: { method?: string; body?: unknown } = {},
): Request {
  return new Request(`http://localhost${path}`, {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${jwt}`,
      ...(options.body === undefined
        ? {}
        : { "Content-Type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

Deno.test("e2e:smoke: e2e:regression: core landlord document and payment flow", async () => {
  const { id: userId, jwt } = await createTestUser();
  await seedLandlord(userId);
  await seedTemplate(userId);
  const restore = installExternalApiStubs();

  try {
    const buildingRes = await handleBuildings(
      authedRequest("/buildings", jwt, {
        method: "POST",
        body: { name: "Edifício Smoke", address: "Rua Smoke, 1" },
      }),
    );
    assertEquals(buildingRes.status, 201);

    const propertyRes = await handleProperties(
      authedRequest("/properties", jwt, {
        method: "POST",
        body: { type: "house", name: "Casa Smoke", address: "Rua Smoke, 2" },
      }),
    );
    assertEquals(propertyRes.status, 201);
    const property = await propertyRes.json() as {
      id: string;
      drive_folder_id: string;
    };

    const tenantRes = await handleTenants(
      authedRequest("/tenants", jwt, {
        method: "POST",
        body: {
          property_id: property.id,
          name: "João Smoke",
          cpf: "123.456.789-00",
          whatsapp: "+5511999990000",
        },
      }),
    );
    assertEquals(tenantRes.status, 201);
    const tenant = await tenantRes.json() as {
      id: string;
      drive_folder_id: string;
    };

    const contextRes = await handleContext(authedRequest("/context", jwt));
    assertEquals(contextRes.status, 200);
    const context = await contextRes.json() as {
      properties: unknown[];
      templates: unknown[];
    };
    assertEquals(context.properties.length >= 1, true);
    assertEquals(context.templates.length >= 1, true);

    const documentsRes = await handleGenerateDocuments(
      authedRequest("/documents/generate", jwt, {
        method: "POST",
        body: {
          property_id: property.id,
          tenant_id: tenant.id,
          placeholders: {
            "nome do inquilino": "João Smoke",
            "cpf do inquilino": "123.456.789-00",
          },
        },
      }),
    );
    assertEquals(documentsRes.status, 200);

    const paymentRes = await handlePayments(
      authedRequest("/payments", jwt, {
        method: "POST",
        body: {
          tenant_id: tenant.id,
          amount: 1500,
          reference_month: "2026-05",
          paid_at: "2026-05-03T12:00:00Z",
        },
      }),
    );
    assertEquals(paymentRes.status, 201);

    const paymentsQueryRes = await handlePayments(
      authedRequest("/payments?month=2026-05", jwt),
    );
    assertEquals(paymentsQueryRes.status, 200);
    const payments = await paymentsQueryRes.json() as {
      paid: Array<{ tenant_id: string }>;
      overdue: unknown[];
    };
    assertEquals(payments.paid.some((p) => p.tenant_id === tenant.id), true);
  } finally {
    restore();
    await cleanup(userId);
  }
});
