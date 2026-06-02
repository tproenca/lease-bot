// unit: POST /workflow/next — backend-owned menu + add_tenant state machine
//
// Tests use injectable deps (loadContext, createTenant) so no real Supabase
// instance or Google account is needed. The pattern mirrors
// documents/generate/generate.test.ts.
//
// Test names follow the "unit:" prefix convention.

import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

// Set required env vars before importing the handler.
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_ANON_KEY", "test-anon-key");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
Deno.env.set("GOOGLE_CLIENT_ID", "test-google-client-id");
Deno.env.set("GOOGLE_CLIENT_SECRET", "test-google-client-secret");

import {
  type ContextPayload,
  type ContextProperty,
  handleWorkflowNext,
  type WorkflowDeps,
} from "./index.ts";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_USER = {
  id: "user-uuid-landlord",
  email: "landlord@example.com",
  user_metadata: {},
};

const MOCK_PROPERTY: ContextProperty = {
  id: "prop-uuid-1",
  name: "Casa 1",
  display_name: "Prédio A - Apto 101",
  current_tenant_folder_id: null,
};

const MOCK_PROPERTY_WITH_TENANT: ContextProperty = {
  id: "prop-uuid-2",
  name: "Casa 2",
  display_name: "Prédio B - Apto 202",
  current_tenant_folder_id: "tenant-folder-existing",
};

const MOCK_CONTEXT: ContextPayload = {
  landlord: { name: "João", whatsapp: "+5511999999999" },
  properties: [MOCK_PROPERTY, MOCK_PROPERTY_WITH_TENANT],
  buildings: [],
  templates: [],
  placeholders: [],
  witnesses: [],
  tenants: [],
  account_config: { payment_reminder_frequency: "daily" },
  cron_errors: [],
};

const MOCK_CREATE_OK = {
  status: 201,
  body: { id: "tenant-uuid-1", drive_folder_id: "drive-folder-1" },
};
const MOCK_CREATE_REAUTH = {
  status: 401,
  body: { error: { code: "GOOGLE_REAUTH_REQUIRED", message: "Reauth" } },
};
const MOCK_CREATE_INVALID_CPF = {
  status: 400,
  body: { error: { code: "INVALID_CPF", message: "CPF inválido" } },
};

// ─── Stub builders ─────────────────────────────────────────────────────────────

function makeStubDeps(opts: {
  contextResult?: { status: number; body: unknown };
  createResult?: { status: number; body: unknown };
}): WorkflowDeps {
  return {
    loadContext: async (_jwt) => {
      return opts.contextResult ?? { status: 200, body: MOCK_CONTEXT };
    },
    createTenant: async (_jwt, _payload) => {
      return opts.createResult ?? MOCK_CREATE_OK;
    },
  };
}

// ─── Fetch stub for auth ───────────────────────────────────────────────────────
// getAuthenticatedUser calls Supabase Auth, so we need to stub globalThis.fetch.

async function mockFetchForAuth(
  authUser: typeof MOCK_USER | null,
  input: string | URL | Request,
): Promise<Response> {
  const url = typeof input === "string"
    ? input
    : input instanceof URL
    ? input.href
    : (input as Request).url;

  if (url.includes("/auth/v1/user")) {
    if (authUser === null) {
      return new Response(JSON.stringify({ error: "invalid_token" }), {
        status: 401,
      });
    }
    return new Response(JSON.stringify(authUser), { status: 200 });
  }

  // Fallback — should not be called in these tests
  throw new Error(`Unexpected fetch: ${url}`);
}

function withMockFetch<T>(
  authUser: typeof MOCK_USER | null,
  fn: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  // deno-lint-ignore require-await
  globalThis.fetch = (async (
    input: string | URL | Request,
  ) => mockFetchForAuth(authUser, input)) as typeof fetch;

  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

// ─── Request helper ────────────────────────────────────────────────────────────

function makeReq(
  body: unknown,
  jwt = "valid-jwt",
): Request {
  return new Request("http://localhost/workflow/next", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify(body),
  });
}

async function json(res: Response): Promise<unknown> {
  return await res.json();
}

// ─── Auth tests ────────────────────────────────────────────────────────────────

Deno.test("unit: workflow/next — 401 when no JWT", async () => {
  const handler = handleWorkflowNext(makeStubDeps({}));
  const res = await handler(
    new Request("http://localhost/workflow/next", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        intent: null,
        values: {},
        message: "5",
      }),
    }),
  );
  assertEquals(res.status, 401);
  const body = await json(res) as Record<string, Record<string, string>>;
  assertEquals(body.error.code, "UNAUTHORIZED");
});

Deno.test("unit: workflow/next — 401 when JWT invalid", async () => {
  const handler = handleWorkflowNext(makeStubDeps({}));
  const res = await withMockFetch(null, () =>
    handler(
      makeReq({ intent: null, values: {}, message: "5" }),
    ));
  assertEquals(res.status, 401);
});

Deno.test("unit: workflow/next — 405 for GET", async () => {
  const handler = handleWorkflowNext(makeStubDeps({}));
  const res = await handler(
    new Request("http://localhost/workflow/next", { method: "GET" }),
  );
  assertEquals(res.status, 405);
});

Deno.test("unit: workflow/next — 200 on OPTIONS (CORS preflight)", async () => {
  const handler = handleWorkflowNext(makeStubDeps({}));
  const res = await handler(
    new Request("http://localhost/workflow/next", { method: "OPTIONS" }),
  );
  assertEquals(res.status, 200);
});

// ─── Menu (startup) ────────────────────────────────────────────────────────────

Deno.test("unit: workflow/next — first message returns main menu with 6 options", async () => {
  const deps = makeStubDeps({});
  const handler = handleWorkflowNext(deps);

  const res = await withMockFetch(
    MOCK_USER,
    () => handler(makeReq({ intent: null, values: {}, message: "oi" })),
  );

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.step, "menu");
  assertEquals(body.intent, null);
  const options = body.options as Array<{ label: string; value: string }>;
  assertEquals(Array.isArray(options), true);
  assertEquals(options.length, 6);
  assertStringIncludes(body.message as string, "João");
});

Deno.test("unit: workflow/next — invalid menu selection returns menu again", async () => {
  const deps = makeStubDeps({});
  const handler = handleWorkflowNext(deps);

  const res = await withMockFetch(
    MOCK_USER,
    () => handler(makeReq({ intent: null, values: {}, message: "9" })),
  );

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.step, "menu");
  const options = body.options as Array<unknown>;
  assertEquals(options.length, 6);
});

Deno.test("unit: workflow/next — menu selection '5' routes to add_tenant ask_property", async () => {
  const deps = makeStubDeps({});
  const handler = handleWorkflowNext(deps);

  const res = await withMockFetch(
    MOCK_USER,
    () => handler(makeReq({ intent: null, values: {}, message: "5" })),
  );

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.intent, "add_tenant");
  assertEquals(body.step, "ask_property");
  assertStringIncludes(body.message as string, "imóvel");
});

Deno.test("unit: workflow/next — context 404 returns onboarding response", async () => {
  const deps = makeStubDeps({
    contextResult: {
      status: 404,
      body: { error: { code: "LANDLORD_NOT_FOUND", message: "Not found" } },
    },
  });
  const handler = handleWorkflowNext(deps);

  const res = await withMockFetch(
    MOCK_USER,
    () => handler(makeReq({ intent: null, values: {}, message: "oi" })),
  );

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.step, "awaiting_setup");
  assertEquals(body.intent, "onboarding");
  assertStringIncludes(body.message as string, "não está cadastrado");
  const options = body.options as Array<{ label: string; value: string }>;
  assertEquals(Array.isArray(options), true);
  assertEquals(options.length, 1);
  assertStringIncludes(options[0].value, "/setup");
});

Deno.test("unit: workflow/next — context GOOGLE_REAUTH_REQUIRED returns reauth response", async () => {
  const deps = makeStubDeps({
    contextResult: {
      status: 401,
      body: {
        error: { code: "GOOGLE_REAUTH_REQUIRED", message: "Reauth required" },
      },
    },
  });
  const handler = handleWorkflowNext(deps);

  const res = await withMockFetch(
    MOCK_USER,
    () => handler(makeReq({ intent: null, values: {}, message: "oi" })),
  );

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.step, "reauth_required");
  assertEquals(body.intent, null);
  assertStringIncludes(body.message as string, "Google Drive expirou");
});

// ─── Property selection ────────────────────────────────────────────────────────

Deno.test("unit: workflow/next — first turn returns property options with display_name", async () => {
  const deps = makeStubDeps({});
  const handler = handleWorkflowNext(deps);

  const res = await withMockFetch(MOCK_USER, () =>
    handler(
      makeReq({ intent: null, values: {}, message: "5" }),
    ));

  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.step, "ask_property");

  const options = body.options as Array<{ label: string; value: string }>;
  assertEquals(Array.isArray(options), true);
  assertEquals(options.length, 2);
  // display_name should be used when available
  assertStringIncludes(options[0].label, "Prédio A - Apto 101");
  assertStringIncludes(options[1].label, "Prédio B - Apto 202");
});

Deno.test("unit: workflow/next — property selection by number advances to ask_name", async () => {
  const deps = makeStubDeps({});
  const handler = handleWorkflowNext(deps);

  const res = await withMockFetch(MOCK_USER, () =>
    handler(
      makeReq({
        intent: "add_tenant",
        values: {},
        message: "1",
      }),
    ));

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.step, "ask_name");
  const values = body.values as Record<string, unknown>;
  assertEquals(values.property_id, MOCK_PROPERTY.id);
  assertStringIncludes(body.message as string, "nome");
});

Deno.test("unit: workflow/next — invalid property number re-asks", async () => {
  const deps = makeStubDeps({});
  const handler = handleWorkflowNext(deps);

  const res = await withMockFetch(MOCK_USER, () =>
    handler(
      makeReq({
        intent: "add_tenant",
        values: {},
        message: "99",
      }),
    ));

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  // Should re-ask with options
  const options = body.options as Array<unknown>;
  assertEquals(Array.isArray(options), true);
  assertStringIncludes(body.message as string, "Não entendi");
});

// ─── Name collection ────────────────────────────────────────────────────────────

Deno.test("unit: workflow/next — name advances to ask_cpf", async () => {
  const deps = makeStubDeps({});
  const handler = handleWorkflowNext(deps);

  const res = await withMockFetch(MOCK_USER, () =>
    handler(
      makeReq({
        intent: "add_tenant",
        values: {
          property_id: "prop-uuid-1",
          property_name: "Prédio A - Apto 101",
        },
        message: "Maria Silva",
      }),
    ));

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.step, "ask_cpf");
  const values = body.values as Record<string, unknown>;
  assertEquals(values.name, "Maria Silva");
  assertStringIncludes(body.message as string, "CPF");
});

// ─── CPF validation ────────────────────────────────────────────────────────────

Deno.test("unit: workflow/next — invalid CPF re-asks, does not advance", async () => {
  const deps = makeStubDeps({});
  const handler = handleWorkflowNext(deps);

  const res = await withMockFetch(MOCK_USER, () =>
    handler(
      makeReq({
        intent: "add_tenant",
        values: {
          property_id: "prop-uuid-1",
          property_name: "Prédio A - Apto 101",
          name: "Maria Silva",
        },
        message: "123",
      }),
    ));

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  // Step should still be ask_cpf (no advancement)
  assertEquals(body.step, "ask_cpf");
  assertStringIncludes(body.message as string, "CPF inválido");
});

Deno.test("unit: workflow/next — valid CPF advances to ask_whatsapp", async () => {
  const deps = makeStubDeps({});
  const handler = handleWorkflowNext(deps);

  const res = await withMockFetch(MOCK_USER, () =>
    handler(
      makeReq({
        intent: "add_tenant",
        values: {
          property_id: "prop-uuid-1",
          property_name: "Prédio A - Apto 101",
          name: "Maria Silva",
        },
        message: "123.456.789-09",
      }),
    ));

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.step, "ask_whatsapp");
  const values = body.values as Record<string, unknown>;
  assertEquals(values.cpf, "123.456.789-09");
  assertStringIncludes(body.message as string, "WhatsApp");
});

// ─── WhatsApp collection ───────────────────────────────────────────────────────

Deno.test("unit: workflow/next — 'pular' sets whatsapp to null and advances to confirm", async () => {
  const deps = makeStubDeps({});
  const handler = handleWorkflowNext(deps);

  const res = await withMockFetch(MOCK_USER, () =>
    handler(
      makeReq({
        intent: "add_tenant",
        values: {
          property_id: "prop-uuid-1",
          property_name: "Prédio A - Apto 101",
          name: "Maria Silva",
          cpf: "123.456.789-09",
        },
        message: "pular",
      }),
    ));

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.step, "confirm");
  const values = body.values as Record<string, unknown>;
  assertEquals(values.whatsapp, null);
  // Should show bold heading
  assertStringIncludes(body.message as string, "**Novo inquilino**");
  assertStringIncludes(body.message as string, "Confirma?");
});

Deno.test("unit: workflow/next — valid whatsapp advances to confirm", async () => {
  const deps = makeStubDeps({});
  const handler = handleWorkflowNext(deps);

  const res = await withMockFetch(MOCK_USER, () =>
    handler(
      makeReq({
        intent: "add_tenant",
        values: {
          property_id: "prop-uuid-1",
          property_name: "Prédio A - Apto 101",
          name: "Maria Silva",
          cpf: "123.456.789-09",
        },
        message: "+5511999999999",
      }),
    ));

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.step, "confirm");
  const values = body.values as Record<string, unknown>;
  assertEquals(values.whatsapp, "+5511999999999");
});

Deno.test("unit: workflow/next — invalid whatsapp re-asks", async () => {
  const deps = makeStubDeps({});
  const handler = handleWorkflowNext(deps);

  const res = await withMockFetch(MOCK_USER, () =>
    handler(
      makeReq({
        intent: "add_tenant",
        values: {
          property_id: "prop-uuid-1",
          property_name: "Prédio A - Apto 101",
          name: "Maria Silva",
          cpf: "123.456.789-09",
        },
        message: "not-a-phone",
      }),
    ));

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.step, "ask_whatsapp");
});

// ─── Confirmation gate ─────────────────────────────────────────────────────────

Deno.test("unit: workflow/next — confirm non-'Sim' re-opens collection", async () => {
  const deps = makeStubDeps({});
  const handler = handleWorkflowNext(deps);

  const res = await withMockFetch(MOCK_USER, () =>
    handler(
      makeReq({
        intent: "add_tenant",
        values: {
          property_id: "prop-uuid-1",
          property_name: "Prédio A - Apto 101",
          name: "Maria Silva",
          cpf: "123.456.789-09",
          whatsapp: null,
        },
        message: "não",
      }),
    ));

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  // Should re-ask what to change — no write
  assertEquals(body.step, "confirm");
  assertStringIncludes(
    body.message as string,
    "O que deseja alterar",
  );
});

Deno.test("unit: workflow/next — 'Sim' triggers write and returns done", async () => {
  const deps = makeStubDeps({ createResult: MOCK_CREATE_OK });
  const handler = handleWorkflowNext(deps);

  const res = await withMockFetch(MOCK_USER, () =>
    handler(
      makeReq({
        intent: "add_tenant",
        values: {
          property_id: "prop-uuid-1",
          property_name: "Prédio A - Apto 101",
          name: "Maria Silva",
          cpf: "123.456.789-09",
          whatsapp: null,
        },
        message: "Sim",
      }),
    ));

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.step, "done");
  assertStringIncludes(
    body.message as string,
    "Inquilino adicionado",
  );
  assertStringIncludes(body.message as string, "contrato");
  const values = body.values as Record<string, unknown>;
  assertEquals(values.tenant_id, "tenant-uuid-1");
});

// ─── Write error mapping ───────────────────────────────────────────────────────

Deno.test("unit: workflow/next — GOOGLE_REAUTH_REQUIRED maps to friendly message", async () => {
  const deps = makeStubDeps({ createResult: MOCK_CREATE_REAUTH });
  const handler = handleWorkflowNext(deps);

  const res = await withMockFetch(MOCK_USER, () =>
    handler(
      makeReq({
        intent: "add_tenant",
        values: {
          property_id: "prop-uuid-1",
          property_name: "Prédio A - Apto 101",
          name: "Maria Silva",
          cpf: "123.456.789-09",
          whatsapp: null,
        },
        message: "Sim",
      }),
    ));

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  // Not done — error occurred
  assertEquals(body.step, "confirm");
  assertStringIncludes(
    body.message as string,
    "Google Drive expirou",
  );
});

Deno.test("unit: workflow/next — INVALID_CPF from write maps to friendly message", async () => {
  const deps = makeStubDeps({ createResult: MOCK_CREATE_INVALID_CPF });
  const handler = handleWorkflowNext(deps);

  const res = await withMockFetch(MOCK_USER, () =>
    handler(
      makeReq({
        intent: "add_tenant",
        values: {
          property_id: "prop-uuid-1",
          property_name: "Prédio A - Apto 101",
          name: "Maria Silva",
          cpf: "123.456.789-09",
          whatsapp: null,
        },
        message: "Sim",
      }),
    ));

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.step, "confirm");
  assertStringIncludes(body.message as string, "CPF");
});

// ─── No-active-tenant path ─────────────────────────────────────────────────────

Deno.test("unit: workflow/next — no active tenant on property is not an error (add_tenant)", async () => {
  // Context has properties where current_tenant_folder_id is null — that's fine
  const contextWithNoTenant: ContextPayload = {
    ...MOCK_CONTEXT,
    properties: [MOCK_PROPERTY], // no active tenant
  };

  const deps = makeStubDeps({
    contextResult: { status: 200, body: contextWithNoTenant },
  });
  const handler = handleWorkflowNext(deps);

  const res = await withMockFetch(MOCK_USER, () =>
    handler(
      makeReq({ intent: null, values: {}, message: "5" }),
    ));

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.intent, "add_tenant");
  assertEquals(body.step, "ask_property");
  // Should list the property even though there's no tenant
  assertStringIncludes(body.message as string, "imóvel");
});

// ─── Existing add_tenant intent passed directly ────────────────────────────────

Deno.test("unit: workflow/next — add_tenant intent in request body goes to ask_property", async () => {
  const deps = makeStubDeps({});
  const handler = handleWorkflowNext(deps);

  const res = await withMockFetch(MOCK_USER, () =>
    handler(
      makeReq({
        intent: "add_tenant",
        values: {},
        message: "add_tenant",
      }),
    ));

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.intent, "add_tenant");
  assertEquals(body.step, "ask_property");
});
