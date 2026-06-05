// unit: POST /workflow/next — backend-owned menu + add_tenant state machine
//
// Tests use injectable deps (loadContext, createTenant) so no real Supabase
// instance or Google account is needed. The pattern mirrors
// documents/generate/generate.test.ts.
//
// Contract (issue #169):
//   Request:  { intent?, state?, message }
//   Response: { message, intent?, state, step, options? }
//
// state is an opaque base64-encoded JSON token.
// state: null = session boundary (menu, onboarding, reauth, error).
// state: string = flow in progress.
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
  current_tenant_id: null,
  current_tenant_folder_id: null,
};

const MOCK_PROPERTY_WITH_TENANT: ContextProperty = {
  id: "prop-uuid-2",
  name: "Casa 2",
  display_name: "Prédio B - Apto 202",
  current_tenant_id: "tenant-uuid-existing",
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
const MOCK_CREATE_GOOGLE_AUTH_FAILED = {
  status: 502,
  body: { error: { code: "GOOGLE_AUTH_FAILED", message: "Auth failed" } },
};
const MOCK_CREATE_DRIVE_FOLDER_FAILED = {
  status: 502,
  body: {
    error: { code: "DRIVE_CREATE_FOLDER_FAILED", message: "Drive error" },
  },
};
const MOCK_CREATE_DB_ERROR = {
  status: 500,
  body: { error: { code: "DB_ERROR", message: "DB error" } },
};
const MOCK_CREATE_UNKNOWN_ERROR = {
  status: 500,
  body: { error: { code: "SOME_UNKNOWN_CODE", message: "Unknown" } },
};

// ─── Stub builders ─────────────────────────────────────────────────────────────

function makeStubDeps(opts: {
  contextResult?: { status: number; body: unknown };
  createResult?: { status: number; body: unknown };
  generateResult?: { status: number; body: unknown };
  createPropertyResult?: { status: number; body: unknown };
  templatesDiffResult?: { status: number; body: unknown };
}): WorkflowDeps {
  return {
    loadContext: async (_jwt) => {
      return opts.contextResult ?? { status: 200, body: MOCK_CONTEXT };
    },
    loadTemplatesDiff: async (_jwt) => {
      return opts.templatesDiffResult ??
        {
          status: 200,
          body: {
            templates: { added: [], removed: [] },
            placeholders: { added: [], removed: [] },
            witnesses: { added: [] },
          },
        };
    },
    createTenant: async (_jwt, _payload) => {
      return opts.createResult ?? MOCK_CREATE_OK;
    },
    generateDocument: async (_jwt, _payload) => {
      return opts.generateResult ?? { status: 200, body: {} };
    },
    createProperty: async (_jwt, _payload) => {
      return opts.createPropertyResult ??
        {
          status: 201,
          body: { id: "prop-uuid-new", drive_folder_id: "drive-folder-new" },
        };
    },
    sendSignature: async (_jwt, _payload) => {
      return { status: 201, body: {} };
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

// ─── Request helpers ────────────────────────────────────────────────────────────

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

/** Decode opaque state token from response body. Returns {} on null/absent. */
function decodeState(body: Record<string, unknown>): Record<string, unknown> {
  const state = body.state as string | null | undefined;
  if (!state) return {};
  try {
    return JSON.parse(atob(state)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// ─── Auth tests ────────────────────────────────────────────────────────────────

Deno.test("unit: workflow/next — 401 when no JWT", async () => {
  const handler = handleWorkflowNext(makeStubDeps({}));
  const res = await handler(
    new Request("http://localhost/workflow/next", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
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
      makeReq({ message: "5" }),
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

Deno.test("unit: workflow/next — first message returns main menu with 6 options and state: null", async () => {
  const deps = makeStubDeps({});
  const handler = handleWorkflowNext(deps);

  const res = await withMockFetch(
    MOCK_USER,
    () => handler(makeReq({ message: "oi" })),
  );

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.step, "menu");
  assertEquals(body.intent, null);
  assertEquals(body.state, null); // session boundary
  const options = body.options as Array<{ label: string; value: string }>;
  assertEquals(Array.isArray(options), true);
  assertEquals(options.length, 6);
  assertStringIncludes(body.message as string, "João");
});

Deno.test("unit: workflow/next — menu greeting uses first name only for multi-word landlord name", async () => {
  const deps: WorkflowDeps = {
    ...makeStubDeps({}),
    loadContext: async (_jwt) => ({
      status: 200,
      body: {
        ...MOCK_CONTEXT,
        landlord: { name: "Tiago Proença", whatsapp: "+5511999999999" },
      },
    }),
  };
  const handler = handleWorkflowNext(deps);

  const res = await withMockFetch(
    MOCK_USER,
    () => handler(makeReq({ message: "oi" })),
  );

  assertEquals(res.status, 200);
  const body = await res.clone().json() as Record<string, unknown>;
  assertStringIncludes(body.message as string, "Tiago");
  assertEquals((body.message as string).includes("Proença"), false);
});

Deno.test("unit: workflow/next — startup calls loadTemplatesDiff", async () => {
  let diffCalled = false;
  const deps: WorkflowDeps = {
    ...makeStubDeps({}),
    loadTemplatesDiff: async (_jwt) => {
      diffCalled = true;
      return {
        status: 200,
        body: {
          templates: { added: [], removed: [] },
          placeholders: { added: [], removed: [] },
          witnesses: { added: [] },
        },
      };
    },
  };
  const handler = handleWorkflowNext(deps);

  await withMockFetch(
    MOCK_USER,
    () => handler(makeReq({ message: "oi" })),
  );

  assertEquals(diffCalled, true);
});

Deno.test("unit: workflow/next — invalid menu selection returns menu again (state: null)", async () => {
  const deps = makeStubDeps({});
  const handler = handleWorkflowNext(deps);

  const res = await withMockFetch(
    MOCK_USER,
    () => handler(makeReq({ message: "9" })),
  );

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.step, "menu");
  assertEquals(body.state, null);
  const options = body.options as Array<unknown>;
  assertEquals(options.length, 6);
});

Deno.test("unit: workflow/next — menu number '5' routes to add_tenant ask_property (Enter phase)", async () => {
  const deps = makeStubDeps({});
  const handler = handleWorkflowNext(deps);

  const res = await withMockFetch(
    MOCK_USER,
    () => handler(makeReq({ message: "5" })),
  );

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.intent, "add_tenant");
  assertEquals(body.step, "ask_property");
  assertStringIncludes(body.message as string, "imóvel");
  // state must be present (flow in progress)
  assertEquals(typeof body.state, "string");
});

Deno.test("unit: workflow/next — text label routes to add_tenant (Enter phase)", async () => {
  const deps = makeStubDeps({});
  const handler = handleWorkflowNext(deps);

  const res = await withMockFetch(
    MOCK_USER,
    () => handler(makeReq({ message: "Adicionar inquilino" })),
  );

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.intent, "add_tenant");
  assertEquals(body.step, "ask_property");
  assertEquals(typeof body.state, "string");
});

Deno.test("unit: workflow/next — context 404 returns onboarding response (state: null)", async () => {
  const deps = makeStubDeps({
    contextResult: {
      status: 404,
      body: { error: { code: "LANDLORD_NOT_FOUND", message: "Not found" } },
    },
  });
  const handler = handleWorkflowNext(deps);

  const res = await withMockFetch(
    MOCK_USER,
    () => handler(makeReq({ message: "oi" })),
  );

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.step, "awaiting_setup");
  assertEquals(body.intent, "onboarding");
  assertEquals(body.state, null); // session boundary
  assertStringIncludes(body.message as string, "não está cadastrado");
  const options = body.options as Array<{ label: string; value: string }>;
  assertEquals(Array.isArray(options), true);
  assertEquals(options.length, 1);
  assertStringIncludes(options[0].value, "/setup");
});

Deno.test("unit: workflow/next — context GOOGLE_REAUTH_REQUIRED returns reauth response (state: null)", async () => {
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
    () => handler(makeReq({ message: "oi" })),
  );

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.step, "reauth_required");
  assertEquals(body.intent, null);
  assertEquals(body.state, null); // session boundary
  assertStringIncludes(body.message as string, "Google Drive expirou");
});

// ─── Enter/Process phase tests ─────────────────────────────────────────────────

Deno.test("unit: workflow/next — Enter phase: intent + no state renders prompt without validation", async () => {
  // Sending intent + no state (Enter phase) should render the first prompt
  // without attempting to validate the message.
  const deps = makeStubDeps({});
  const handler = handleWorkflowNext(deps);

  const res = await withMockFetch(MOCK_USER, () =>
    handler(
      makeReq({ intent: "add_tenant", message: "anything" }),
      // no state field → Enter phase
    ));

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  // Should show ask_property prompt, not validate "anything" as a property
  assertEquals(body.step, "ask_property");
  assertStringIncludes(body.message as string, "imóvel");
  assertEquals(typeof body.state, "string");
});

Deno.test("unit: workflow/next — Process phase: intent + state validates message", async () => {
  // Encode empty values as state (simulating start of flow already entered).
  const state = btoa(JSON.stringify({}));
  const deps = makeStubDeps({});
  const handler = handleWorkflowNext(deps);

  const res = await withMockFetch(MOCK_USER, () =>
    handler(
      makeReq({ intent: "add_tenant", state, message: "1" }),
    ));

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  // "1" is a valid property selection → should advance to ask_name
  assertEquals(body.step, "ask_name");
  const values = decodeState(body);
  assertEquals(values.property_id, MOCK_PROPERTY.id);
});

// ─── Property selection ────────────────────────────────────────────────────────

Deno.test("unit: workflow/next — first turn returns property options with display_name", async () => {
  const deps = makeStubDeps({});
  const handler = handleWorkflowNext(deps);

  const res = await withMockFetch(MOCK_USER, () =>
    handler(
      makeReq({ message: "5" }),
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

  // Process phase: state present (empty values)
  const state = btoa(JSON.stringify({}));
  const res = await withMockFetch(MOCK_USER, () =>
    handler(
      makeReq({
        intent: "add_tenant",
        state,
        message: "1",
      }),
    ));

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.step, "ask_name");
  const values = decodeState(body);
  assertEquals(values.property_id, MOCK_PROPERTY.id);
  assertStringIncludes(body.message as string, "nome");
});

Deno.test("unit: workflow/next — invalid property number re-asks", async () => {
  const deps = makeStubDeps({});
  const handler = handleWorkflowNext(deps);

  const state = btoa(JSON.stringify({}));
  const res = await withMockFetch(MOCK_USER, () =>
    handler(
      makeReq({
        intent: "add_tenant",
        state,
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

  const state = btoa(JSON.stringify({
    property_id: "prop-uuid-1",
    property_name: "Prédio A - Apto 101",
  }));
  const res = await withMockFetch(MOCK_USER, () =>
    handler(
      makeReq({
        intent: "add_tenant",
        state,
        message: "Maria Silva",
      }),
    ));

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.step, "ask_cpf");
  const values = decodeState(body);
  assertEquals(values.name, "Maria Silva");
  assertStringIncludes(body.message as string, "CPF");
});

// ─── CPF validation ────────────────────────────────────────────────────────────

Deno.test("unit: workflow/next — invalid CPF re-asks, does not advance", async () => {
  const deps = makeStubDeps({});
  const handler = handleWorkflowNext(deps);

  const state = btoa(JSON.stringify({
    property_id: "prop-uuid-1",
    property_name: "Prédio A - Apto 101",
    name: "Maria Silva",
  }));
  const res = await withMockFetch(MOCK_USER, () =>
    handler(
      makeReq({
        intent: "add_tenant",
        state,
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

  const state = btoa(JSON.stringify({
    property_id: "prop-uuid-1",
    property_name: "Prédio A - Apto 101",
    name: "Maria Silva",
  }));
  const res = await withMockFetch(MOCK_USER, () =>
    handler(
      makeReq({
        intent: "add_tenant",
        state,
        message: "123.456.789-09",
      }),
    ));

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.step, "ask_whatsapp");
  const values = decodeState(body);
  assertEquals(values.cpf, "123.456.789-09");
  assertStringIncludes(body.message as string, "WhatsApp");
});

Deno.test("unit: workflow/next — unformatted CPF digits accepted and auto-formatted", async () => {
  const deps = makeStubDeps({});
  const handler = handleWorkflowNext(deps);

  const state = btoa(JSON.stringify({
    property_id: "prop-uuid-1",
    property_name: "Prédio A - Apto 101",
    name: "Maria Silva",
  }));
  // 22342645880 → 223.426.458-80 (valid check digits)
  const res = await withMockFetch(MOCK_USER, () =>
    handler(
      makeReq({
        intent: "add_tenant",
        state,
        message: "22342645880",
      }),
    ));

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.step, "ask_whatsapp");
  const values = decodeState(body);
  // Stored value must be the formatted version
  assertEquals(values.cpf, "223.426.458-80");
  assertStringIncludes(body.message as string, "WhatsApp");
});

Deno.test("unit: workflow/next — CPF with wrong check digits is rejected", async () => {
  const deps = makeStubDeps({});
  const handler = handleWorkflowNext(deps);

  const state = btoa(JSON.stringify({
    property_id: "prop-uuid-1",
    property_name: "Prédio A - Apto 101",
    name: "Maria Silva",
  }));
  // 22342645899 has wrong check digits (should end in 80)
  const res = await withMockFetch(MOCK_USER, () =>
    handler(
      makeReq({
        intent: "add_tenant",
        state,
        message: "22342645899",
      }),
    ));

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.step, "ask_cpf");
  assertStringIncludes(body.message as string, "CPF inválido");
});

Deno.test("unit: workflow/next — all-same-digit CPF is rejected", async () => {
  const deps = makeStubDeps({});
  const handler = handleWorkflowNext(deps);

  const state = btoa(JSON.stringify({
    property_id: "prop-uuid-1",
    property_name: "Prédio A - Apto 101",
    name: "Maria Silva",
  }));
  const res = await withMockFetch(MOCK_USER, () =>
    handler(
      makeReq({
        intent: "add_tenant",
        state,
        message: "11111111111",
      }),
    ));

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.step, "ask_cpf");
  assertStringIncludes(body.message as string, "CPF inválido");
});

// ─── WhatsApp collection ───────────────────────────────────────────────────────

Deno.test("unit: workflow/next — 'pular' sets whatsapp to null and advances to confirm", async () => {
  const deps = makeStubDeps({});
  const handler = handleWorkflowNext(deps);

  const state = btoa(JSON.stringify({
    property_id: "prop-uuid-1",
    property_name: "Prédio A - Apto 101",
    name: "Maria Silva",
    cpf: "123.456.789-09",
  }));
  const res = await withMockFetch(MOCK_USER, () =>
    handler(
      makeReq({
        intent: "add_tenant",
        state,
        message: "pular",
      }),
    ));

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.step, "confirm");
  const values = decodeState(body);
  assertEquals(values.whatsapp, null);
  // Should show bold heading
  assertStringIncludes(body.message as string, "**Novo inquilino**");
  assertStringIncludes(body.message as string, "Confirma?");
  // property_name should appear as friendly label, not raw UUID
  assertStringIncludes(body.message as string, "Imóvel:");
  assertStringIncludes(body.message as string, "Prédio A - Apto 101");
});

Deno.test("unit: workflow/next — valid whatsapp advances to confirm", async () => {
  const deps = makeStubDeps({});
  const handler = handleWorkflowNext(deps);

  const state = btoa(JSON.stringify({
    property_id: "prop-uuid-1",
    property_name: "Prédio A - Apto 101",
    name: "Maria Silva",
    cpf: "123.456.789-09",
  }));
  const res = await withMockFetch(MOCK_USER, () =>
    handler(
      makeReq({
        intent: "add_tenant",
        state,
        message: "+5511999999999",
      }),
    ));

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.step, "confirm");
  const values = decodeState(body);
  assertEquals(values.whatsapp, "+5511999999999");
});

Deno.test("unit: workflow/next — invalid whatsapp re-asks", async () => {
  const deps = makeStubDeps({});
  const handler = handleWorkflowNext(deps);

  const state = btoa(JSON.stringify({
    property_id: "prop-uuid-1",
    property_name: "Prédio A - Apto 101",
    name: "Maria Silva",
    cpf: "123.456.789-09",
  }));
  const res = await withMockFetch(MOCK_USER, () =>
    handler(
      makeReq({
        intent: "add_tenant",
        state,
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

  const state = btoa(JSON.stringify({
    property_id: "prop-uuid-1",
    property_name: "Prédio A - Apto 101",
    name: "Maria Silva",
    cpf: "123.456.789-09",
    whatsapp: null,
  }));
  const res = await withMockFetch(MOCK_USER, () =>
    handler(
      makeReq({
        intent: "add_tenant",
        state,
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

Deno.test("unit: workflow/next — 'Sim' triggers write and transitions to menu (step: done auto-transition)", async () => {
  const deps = makeStubDeps({ createResult: MOCK_CREATE_OK });
  const handler = handleWorkflowNext(deps);

  const state = btoa(JSON.stringify({
    property_id: "prop-uuid-1",
    property_name: "Prédio A - Apto 101",
    name: "Maria Silva",
    cpf: "123.456.789-09",
    whatsapp: null,
  }));
  const res = await withMockFetch(MOCK_USER, () =>
    handler(
      makeReq({
        intent: "add_tenant",
        state,
        message: "Sim",
      }),
    ));

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  // step: done auto-transitions to menu — response is the menu
  assertEquals(body.step, "menu");
  assertEquals(body.state, null); // session boundary
  assertEquals(body.intent, null);
  // Success message prepended to "O que mais posso te ajudar?"
  assertStringIncludes(body.message as string, "Inquilino adicionado.");
  assertStringIncludes(body.message as string, "O que mais posso te ajudar?");
});

// ─── Write error mapping ───────────────────────────────────────────────────────

Deno.test("unit: workflow/next — GOOGLE_REAUTH_REQUIRED maps to friendly message", async () => {
  const deps = makeStubDeps({ createResult: MOCK_CREATE_REAUTH });
  const handler = handleWorkflowNext(deps);

  const state = btoa(JSON.stringify({
    property_id: "prop-uuid-1",
    property_name: "Prédio A - Apto 101",
    name: "Maria Silva",
    cpf: "123.456.789-09",
    whatsapp: null,
  }));
  const res = await withMockFetch(MOCK_USER, () =>
    handler(
      makeReq({
        intent: "add_tenant",
        state,
        message: "Sim",
      }),
    ));

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  // Not done — error occurred, still at confirm
  assertEquals(body.step, "confirm");
  assertStringIncludes(
    body.message as string,
    "Google Drive expirou",
  );
});

Deno.test("unit: workflow/next — INVALID_CPF from write maps to friendly message", async () => {
  const deps = makeStubDeps({ createResult: MOCK_CREATE_INVALID_CPF });
  const handler = handleWorkflowNext(deps);

  const state = btoa(JSON.stringify({
    property_id: "prop-uuid-1",
    property_name: "Prédio A - Apto 101",
    name: "Maria Silva",
    cpf: "123.456.789-09",
    whatsapp: null,
  }));
  const res = await withMockFetch(MOCK_USER, () =>
    handler(
      makeReq({
        intent: "add_tenant",
        state,
        message: "Sim",
      }),
    ));

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.step, "confirm");
  assertStringIncludes(body.message as string, "CPF");
});

Deno.test("unit: workflow/next — GOOGLE_AUTH_FAILED maps to friendly message", async () => {
  const deps = makeStubDeps({ createResult: MOCK_CREATE_GOOGLE_AUTH_FAILED });
  const handler = handleWorkflowNext(deps);
  const state = btoa(JSON.stringify({
    property_id: "prop-uuid-1",
    property_name: "Prédio A - Apto 101",
    name: "Maria Silva",
    cpf: "123.456.789-09",
    whatsapp: null,
  }));
  const res = await withMockFetch(
    MOCK_USER,
    () => handler(makeReq({ intent: "add_tenant", state, message: "Sim" })),
  );
  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.step, "confirm");
  assertStringIncludes(body.message as string, "Google Drive");
});

Deno.test("unit: workflow/next — DRIVE_CREATE_FOLDER_FAILED maps to friendly message", async () => {
  const deps = makeStubDeps({ createResult: MOCK_CREATE_DRIVE_FOLDER_FAILED });
  const handler = handleWorkflowNext(deps);
  const state = btoa(JSON.stringify({
    property_id: "prop-uuid-1",
    property_name: "Prédio A - Apto 101",
    name: "Maria Silva",
    cpf: "123.456.789-09",
    whatsapp: null,
  }));
  const res = await withMockFetch(
    MOCK_USER,
    () => handler(makeReq({ intent: "add_tenant", state, message: "Sim" })),
  );
  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.step, "confirm");
  assertStringIncludes(body.message as string, "Google Drive");
});

Deno.test("unit: workflow/next — DB_ERROR maps to friendly message", async () => {
  const deps = makeStubDeps({ createResult: MOCK_CREATE_DB_ERROR });
  const handler = handleWorkflowNext(deps);
  const state = btoa(JSON.stringify({
    property_id: "prop-uuid-1",
    property_name: "Prédio A - Apto 101",
    name: "Maria Silva",
    cpf: "123.456.789-09",
    whatsapp: null,
  }));
  const res = await withMockFetch(
    MOCK_USER,
    () => handler(makeReq({ intent: "add_tenant", state, message: "Sim" })),
  );
  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.step, "confirm");
  assertStringIncludes(body.message as string, "salvar");
});

Deno.test("unit: workflow/next — unknown error code with backend message uses tier-2 passthrough", async () => {
  // MOCK_CREATE_UNKNOWN_ERROR has { code: "SOME_UNKNOWN_CODE", message: "Unknown" }.
  // Tier 1 (ERROR_MAP) misses, tier 2 passes through the backend message.
  const deps = makeStubDeps({ createResult: MOCK_CREATE_UNKNOWN_ERROR });
  const handler = handleWorkflowNext(deps);
  const state = btoa(JSON.stringify({
    property_id: "prop-uuid-1",
    property_name: "Prédio A - Apto 101",
    name: "Maria Silva",
    cpf: "123.456.789-09",
    whatsapp: null,
  }));
  const res = await withMockFetch(
    MOCK_USER,
    () => handler(makeReq({ intent: "add_tenant", state, message: "Sim" })),
  );
  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.step, "confirm");
  // Tier 2: backend message is passed through.
  assertStringIncludes(body.message as string, "Unknown");
});

Deno.test("unit: workflow/next — unknown error code with no backend message uses tier-3 generic fallback", async () => {
  const noMessageError = {
    status: 500,
    body: { error: { code: "SOME_UNKNOWN_CODE" } },
  };
  const deps = makeStubDeps({ createResult: noMessageError });
  const handler = handleWorkflowNext(deps);
  const state = btoa(JSON.stringify({
    property_id: "prop-uuid-1",
    property_name: "Prédio A - Apto 101",
    name: "Maria Silva",
    cpf: "123.456.789-09",
    whatsapp: null,
  }));
  const res = await withMockFetch(
    MOCK_USER,
    () => handler(makeReq({ intent: "add_tenant", state, message: "Sim" })),
  );
  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.step, "confirm");
  // Tier 3: generic fallback.
  assertStringIncludes(body.message as string, "Ocorreu um erro inesperado");
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
      makeReq({ message: "5" }),
    ));

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.intent, "add_tenant");
  assertEquals(body.step, "ask_property");
  // Should list the property even though there's no tenant
  assertStringIncludes(body.message as string, "imóvel");
});

// ─── Intent router tests ───────────────────────────────────────────────────────

Deno.test("unit: workflow/next — intent router: number maps to flow (Enter phase)", async () => {
  const deps = makeStubDeps({});
  const handler = handleWorkflowNext(deps);

  const res = await withMockFetch(
    MOCK_USER,
    () => handler(makeReq({ message: "5" })),
  );

  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.intent, "add_tenant");
  assertEquals(body.step, "ask_property");
});

Deno.test("unit: workflow/next — intent router: text label maps to flow (Enter phase)", async () => {
  const deps = makeStubDeps({});
  const handler = handleWorkflowNext(deps);

  const res = await withMockFetch(
    MOCK_USER,
    () => handler(makeReq({ message: "adicionar inquilino" })),
  );

  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.intent, "add_tenant");
  assertEquals(body.step, "ask_property");
});

Deno.test("unit: workflow/next — intent router: no match falls back to menu", async () => {
  const deps = makeStubDeps({});
  const handler = handleWorkflowNext(deps);

  const res = await withMockFetch(
    MOCK_USER,
    () => handler(makeReq({ message: "preciso de ajuda" })),
  );

  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.step, "menu");
  assertEquals(body.state, null);
});

// ─── add_tenant intent in request (Enter phase) ────────────────────────────────

Deno.test("unit: workflow/next — add_tenant intent without state (Enter phase) goes to ask_property", async () => {
  const deps = makeStubDeps({});
  const handler = handleWorkflowNext(deps);

  const res = await withMockFetch(MOCK_USER, () =>
    handler(
      makeReq({
        intent: "add_tenant",
        // no state → Enter phase
        message: "oi",
      }),
    ));

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.intent, "add_tenant");
  assertEquals(body.step, "ask_property");
});

// ─── ADD_TENANT definition assertions ─────────────────────────────────────────

import { ADD_TENANT } from "./intents/add-tenant.ts";

Deno.test("unit: ADD_TENANT — has 4 steps: property_id, name, cpf, whatsapp", () => {
  const keys = resolveFlowSteps(ADD_TENANT).map((s) => s.key);
  assertEquals(keys, ["property_id", "name", "cpf", "whatsapp"]);
});

Deno.test("unit: ADD_TENANT — whatsapp step is optional", () => {
  const whatsapp = resolveFlowSteps(ADD_TENANT).find((s) =>
    s.key === "whatsapp"
  );
  assertEquals(whatsapp?.optional, true);
});

Deno.test("unit: ADD_TENANT — property_id step has options builder", () => {
  const step = resolveFlowSteps(ADD_TENANT).find((s) =>
    s.key === "property_id"
  );
  assertEquals(typeof step?.options, "function");
});

Deno.test("unit: ADD_TENANT — name validate rejects empty string", () => {
  const step = resolveFlowSteps(ADD_TENANT).find((s) => s.key === "name")!;
  const result = step.validate!("", {}, { properties: [] } as ContextPayload);
  assertEquals(result.ok, false);
});

Deno.test("unit: ADD_TENANT — cpf validate accepts valid format", () => {
  const step = resolveFlowSteps(ADD_TENANT).find((s) => s.key === "cpf")!;
  const result = step.validate!(
    "123.456.789-09",
    {},
    { properties: [] } as ContextPayload,
  );
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value, "123.456.789-09");
});

Deno.test("unit: ADD_TENANT — cpf validate accepts unformatted digits and formats them", () => {
  const step = resolveFlowSteps(ADD_TENANT).find((s) => s.key === "cpf")!;
  const result = step.validate!(
    "12345678909",
    {},
    { properties: [] } as ContextPayload,
  );
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value, "123.456.789-09");
});

Deno.test("unit: ADD_TENANT — cpf validate rejects invalid check digits", () => {
  const step = resolveFlowSteps(ADD_TENANT).find((s) => s.key === "cpf")!;
  const result = step.validate!(
    "12345678900",
    {},
    { properties: [] } as ContextPayload,
  );
  assertEquals(result.ok, false);
  if (!result.ok) assertStringIncludes(result.error, "CPF inválido");
});

// ─── Generic engine tests (2-step test definition) ─────────────────────────────
//
// Uses a minimal FlowDefinition independent of add_tenant to verify the engine:
//   collect → invalid re-ask → advance → optional "pular" → confirm → Sim → done
//   confirm non-Sim → re-opens

import {
  type FlowDefinition,
  resolveFlowSteps,
  runFlowEngine,
} from "./flow-engine.ts";
import type { WorkflowRequest } from "./index.ts";

const EMPTY_CONTEXT: ContextPayload = {
  properties: [],
};

const MOCK_DEPS_ENGINE: WorkflowDeps = {
  loadContext: async (_jwt) => ({ status: 200, body: EMPTY_CONTEXT }),
  loadTemplatesDiff: async (_jwt) => ({ status: 200, body: {} }),
  createTenant: async (_jwt, _payload) => ({ status: 201, body: {} }),
  generateDocument: async (_jwt, _payload) => ({ status: 200, body: {} }),
  createProperty: async (_jwt, _payload) => ({ status: 201, body: {} }),
  sendSignature: async (_jwt, _payload) => ({ status: 201, body: {} }),
};

const TEST_FLOW: FlowDefinition = {
  intent: "test_flow",
  confirmationTitle: "Test Summary",
  steps: [
    {
      key: "username",
      prompt: "What is your username?",
      validate: (input) => {
        const trimmed = input.trim();
        return trimmed.length >= 3
          ? { ok: true, value: trimmed }
          : { ok: false, error: "Username must be at least 3 characters." };
      },
    },
    {
      key: "nickname",
      prompt: "What is your nickname? (say 'pular' to skip)",
      optional: true,
      validate: (input) => {
        const trimmed = input.trim();
        return trimmed.length > 0
          ? { ok: true, value: trimmed }
          : { ok: false, error: "Nickname cannot be empty if provided." };
      },
    },
  ],
  execute: async (_values, _jwt, _deps) => {
    return { ok: true, message: "Test flow complete!" };
  },
};

function engineReq(
  values: Record<string, unknown>,
  message: string,
): WorkflowRequest {
  return { intent: "test_flow", values, message };
}

Deno.test("unit: engine — initial call (Enter phase: empty message) returns first step prompt", async () => {
  const res = await runFlowEngine(
    TEST_FLOW,
    engineReq({}, ""),
    EMPTY_CONTEXT,
    MOCK_DEPS_ENGINE,
    "jwt",
  );
  assertEquals(res.step, "ask_username");
  assertStringIncludes(res.message, "username");
  assertEquals(res.intent, "test_flow");
});

Deno.test("unit: engine — invalid input re-asks same step", async () => {
  // "ab" is too short → validation fails
  const res = await runFlowEngine(
    TEST_FLOW,
    engineReq({}, "ab"),
    EMPTY_CONTEXT,
    MOCK_DEPS_ENGINE,
    "jwt",
  );
  assertEquals(res.step, "ask_username");
  assertStringIncludes(res.message, "at least 3");
});

Deno.test("unit: engine — valid input advances to next step", async () => {
  const res = await runFlowEngine(
    TEST_FLOW,
    engineReq({}, "alice"),
    EMPTY_CONTEXT,
    MOCK_DEPS_ENGINE,
    "jwt",
  );
  assertEquals(res.step, "ask_nickname");
  assertEquals((res.values as Record<string, unknown>).username, "alice");
});

Deno.test("unit: engine — 'pular' on optional step stores null and advances to confirm", async () => {
  const res = await runFlowEngine(
    TEST_FLOW,
    engineReq({ username: "alice" }, "pular"),
    EMPTY_CONTEXT,
    MOCK_DEPS_ENGINE,
    "jwt",
  );
  assertEquals(res.step, "confirm");
  assertEquals((res.values as Record<string, unknown>).nickname, null);
  assertStringIncludes(res.message, "**Test Summary**");
  assertStringIncludes(res.message, "Confirma?");
});

Deno.test("unit: engine — confirm non-Sim re-opens (asks what to change)", async () => {
  const res = await runFlowEngine(
    TEST_FLOW,
    engineReq({ username: "alice", nickname: null }, "não"),
    EMPTY_CONTEXT,
    MOCK_DEPS_ENGINE,
    "jwt",
  );
  assertEquals(res.step, "confirm");
  assertStringIncludes(res.message, "O que deseja alterar");
});

Deno.test("unit: engine — 'Sim' calls execute and returns done", async () => {
  const res = await runFlowEngine(
    TEST_FLOW,
    engineReq({ username: "alice", nickname: null }, "Sim"),
    EMPTY_CONTEXT,
    MOCK_DEPS_ENGINE,
    "jwt",
  );
  assertEquals(res.step, "done");
  assertStringIncludes(res.message, "Test flow complete");
});

Deno.test("unit: engine — execute failure returns error message at given step", async () => {
  const failingFlow: FlowDefinition = {
    ...TEST_FLOW,
    execute: async () => ({
      ok: false,
      step: "confirm",
      message: "Write failed.",
    }),
  };
  const res = await runFlowEngine(
    failingFlow,
    engineReq({ username: "alice", nickname: null }, "Sim"),
    EMPTY_CONTEXT,
    MOCK_DEPS_ENGINE,
    "jwt",
  );
  assertEquals(res.step, "confirm");
  assertStringIncludes(res.message, "Write failed");
});

// ─── generate_document flow tests ─────────────────────────────────────────────

import { GENERATE_DOCUMENT } from "./intents/generate-document.ts";

const MOCK_TENANT_1 = {
  id: "tenant-uuid-1",
  property_id: "prop-uuid-1",
  name: "Maria Silva",
};

const MOCK_TENANT_2 = {
  id: "tenant-uuid-2",
  property_id: "prop-uuid-2",
  name: "João Santos",
};

const MOCK_CONTEXT_WITH_TENANTS: ContextPayload = {
  ...MOCK_CONTEXT,
  tenants: [MOCK_TENANT_1, MOCK_TENANT_2],
};

Deno.test("unit: generate_document — menu number '3' routes to ask_tenant (Enter phase)", async () => {
  const deps = makeStubDeps({
    contextResult: { status: 200, body: MOCK_CONTEXT_WITH_TENANTS },
  });
  const handler = handleWorkflowNext(deps);

  const res = await withMockFetch(
    MOCK_USER,
    () => handler(makeReq({ message: "3" })),
  );

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.intent, "generate_document");
  assertEquals(body.step, "ask_tenant");
  assertStringIncludes(body.message as string, "inquilino");
  assertEquals(typeof body.state, "string");
});

Deno.test("unit: generate_document — text label 'gerar documento' routes to flow (Enter phase)", async () => {
  const deps = makeStubDeps({
    contextResult: { status: 200, body: MOCK_CONTEXT_WITH_TENANTS },
  });
  const handler = handleWorkflowNext(deps);

  const res = await withMockFetch(
    MOCK_USER,
    () => handler(makeReq({ message: "gerar documento" })),
  );

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.intent, "generate_document");
  assertEquals(body.step, "ask_tenant");
});

Deno.test("unit: generate_document — tenant options list active tenants from ctx.tenants", async () => {
  const deps = makeStubDeps({
    contextResult: { status: 200, body: MOCK_CONTEXT_WITH_TENANTS },
  });
  const handler = handleWorkflowNext(deps);

  const res = await withMockFetch(
    MOCK_USER,
    () => handler(makeReq({ message: "3" })),
  );

  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.step, "ask_tenant");
  const options = body.options as Array<{ label: string; value: string }>;
  assertEquals(Array.isArray(options), true);
  assertEquals(options.length, 2);
  assertStringIncludes(options[0].label, "Maria Silva");
  assertStringIncludes(options[1].label, "João Santos");
  assertEquals(options[0].value, MOCK_TENANT_1.id);
});

Deno.test("unit: generate_document — no tenants guard: prompt returns early-exit message", async () => {
  const deps = makeStubDeps({
    contextResult: {
      status: 200,
      body: { ...MOCK_CONTEXT, tenants: [] },
    },
  });
  const handler = handleWorkflowNext(deps);

  const res = await withMockFetch(
    MOCK_USER,
    () => handler(makeReq({ message: "3" })),
  );

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.intent, "generate_document");
  assertEquals(body.step, "ask_tenant");
  assertStringIncludes(
    body.message as string,
    "Nenhum inquilino ativo encontrado.",
  );
});

Deno.test("unit: generate_document — no tenants guard: validation rejects any reply", async () => {
  const deps = makeStubDeps({
    contextResult: {
      status: 200,
      body: { ...MOCK_CONTEXT, tenants: [] },
    },
  });
  const handler = handleWorkflowNext(deps);

  const state = btoa(JSON.stringify({}));
  const res = await withMockFetch(
    MOCK_USER,
    () =>
      handler(
        makeReq({ intent: "generate_document", state, message: "1" }),
      ),
  );

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.step, "ask_tenant");
  assertStringIncludes(
    body.message as string,
    "Nenhum inquilino ativo encontrado.",
  );
});

Deno.test("unit: generate_document — tenant selection by number advances to confirm", async () => {
  const deps = makeStubDeps({
    contextResult: { status: 200, body: MOCK_CONTEXT_WITH_TENANTS },
  });
  const handler = handleWorkflowNext(deps);

  const state = btoa(JSON.stringify({}));
  const res = await withMockFetch(
    MOCK_USER,
    () =>
      handler(
        makeReq({ intent: "generate_document", state, message: "1" }),
      ),
  );

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.step, "confirm");
  const values = decodeState(body);
  assertEquals(values.tenant_id, MOCK_TENANT_1.id);
  assertEquals(values.property_id, MOCK_TENANT_1.property_id);
  assertStringIncludes(body.message as string, "Gerar documento");
  assertStringIncludes(body.message as string, "Maria Silva");
});

Deno.test("unit: generate_document — invalid tenant number re-asks", async () => {
  const deps = makeStubDeps({
    contextResult: { status: 200, body: MOCK_CONTEXT_WITH_TENANTS },
  });
  const handler = handleWorkflowNext(deps);

  const state = btoa(JSON.stringify({}));
  const res = await withMockFetch(
    MOCK_USER,
    () =>
      handler(
        makeReq({ intent: "generate_document", state, message: "99" }),
      ),
  );

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.step, "ask_tenant");
  assertStringIncludes(body.message as string, "Não entendi");
});

Deno.test("unit: generate_document — happy path: 'Sim' triggers generateDocument and returns to menu", async () => {
  const deps = makeStubDeps({
    contextResult: { status: 200, body: MOCK_CONTEXT_WITH_TENANTS },
    generateResult: { status: 200, body: {} },
  });
  const handler = handleWorkflowNext(deps);

  const state = btoa(JSON.stringify({
    tenant_id: MOCK_TENANT_1.id,
    tenant_name: MOCK_TENANT_1.name,
    property_id: MOCK_TENANT_1.property_id,
    property_name: "Prédio A - Apto 101",
  }));
  const res = await withMockFetch(
    MOCK_USER,
    () =>
      handler(
        makeReq({ intent: "generate_document", state, message: "Sim" }),
      ),
  );

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.step, "menu");
  assertEquals(body.state, null);
  assertEquals(body.intent, null);
  assertStringIncludes(body.message as string, "Documentos gerados.");
  assertStringIncludes(body.message as string, "O que mais posso te ajudar?");
});

Deno.test("unit: generate_document — execute failure maps GOOGLE_REAUTH_REQUIRED", async () => {
  const deps = makeStubDeps({
    contextResult: { status: 200, body: MOCK_CONTEXT_WITH_TENANTS },
    generateResult: {
      status: 401,
      body: { error: { code: "GOOGLE_REAUTH_REQUIRED", message: "Reauth" } },
    },
  });
  const handler = handleWorkflowNext(deps);

  const state = btoa(JSON.stringify({
    tenant_id: MOCK_TENANT_1.id,
    tenant_name: MOCK_TENANT_1.name,
    property_id: MOCK_TENANT_1.property_id,
    property_name: "Prédio A - Apto 101",
  }));
  const res = await withMockFetch(
    MOCK_USER,
    () =>
      handler(
        makeReq({ intent: "generate_document", state, message: "Sim" }),
      ),
  );

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.step, "confirm");
  assertStringIncludes(body.message as string, "Google Drive expirou");
});

Deno.test("unit: generate_document — execute failure maps NO_TEMPLATES_FOUND", async () => {
  const deps = makeStubDeps({
    contextResult: { status: 200, body: MOCK_CONTEXT_WITH_TENANTS },
    generateResult: {
      status: 404,
      body: { error: { code: "NO_TEMPLATES_FOUND", message: "No templates" } },
    },
  });
  const handler = handleWorkflowNext(deps);

  const state = btoa(JSON.stringify({
    tenant_id: MOCK_TENANT_1.id,
    tenant_name: MOCK_TENANT_1.name,
    property_id: MOCK_TENANT_1.property_id,
    property_name: "Prédio A - Apto 101",
  }));
  const res = await withMockFetch(
    MOCK_USER,
    () =>
      handler(
        makeReq({ intent: "generate_document", state, message: "Sim" }),
      ),
  );

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.step, "confirm");
  assertStringIncludes(body.message as string, "template");
});

Deno.test("unit: generate_document — execute failure with unknown code falls back to generic message", async () => {
  const deps = makeStubDeps({
    contextResult: { status: 200, body: MOCK_CONTEXT_WITH_TENANTS },
    generateResult: {
      status: 500,
      body: { error: { code: "SOME_UNKNOWN_CODE" } },
    },
  });
  const handler = handleWorkflowNext(deps);

  const state = btoa(JSON.stringify({
    tenant_id: MOCK_TENANT_1.id,
    tenant_name: MOCK_TENANT_1.name,
    property_id: MOCK_TENANT_1.property_id,
    property_name: "Prédio A - Apto 101",
  }));
  const res = await withMockFetch(
    MOCK_USER,
    () =>
      handler(
        makeReq({ intent: "generate_document", state, message: "Sim" }),
      ),
  );

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.step, "confirm");
  assertStringIncludes(body.message as string, "Ocorreu um erro inesperado");
});

// ─── GENERATE_DOCUMENT definition assertions ──────────────────────────────────

Deno.test("unit: GENERATE_DOCUMENT — has 1 step: tenant_id", () => {
  const keys = resolveFlowSteps(GENERATE_DOCUMENT).map((s) => s.key);
  assertEquals(keys, ["tenant_id"]);
});

Deno.test("unit: GENERATE_DOCUMENT — tenant_id step has options builder", () => {
  const step = resolveFlowSteps(GENERATE_DOCUMENT).find((s) =>
    s.key === "tenant_id"
  );
  assertEquals(typeof step?.options, "function");
});

Deno.test("unit: GENERATE_DOCUMENT — tenant_id options returns empty array when no tenants", () => {
  const step = resolveFlowSteps(GENERATE_DOCUMENT).find((s) =>
    s.key === "tenant_id"
  )!;
  const ctx: ContextPayload = { properties: [], tenants: [] };
  const opts = step.options!(
    {},
    ctx,
  );
  assertEquals(opts, []);
});

Deno.test("unit: GENERATE_DOCUMENT — tenant_id options maps tenants to label/value pairs", () => {
  const step = resolveFlowSteps(GENERATE_DOCUMENT).find((s) =>
    s.key === "tenant_id"
  )!;
  const ctx: ContextPayload = {
    properties: [],
    tenants: [MOCK_TENANT_1, MOCK_TENANT_2],
  };
  const opts = step.options!({}, ctx);
  assertEquals(opts.length, 2);
  assertEquals(opts[0].value, MOCK_TENANT_1.id);
  assertStringIncludes(opts[0].label, "Maria Silva");
});
// ─── ADD_PROPERTY definition assertions ───────────────────────────────────────

import { ADD_PROPERTY } from "./intents/add-property.ts";

Deno.test("unit: ADD_PROPERTY — has 4 steps: type, building_id, address, name", () => {
  const keys = resolveFlowSteps(ADD_PROPERTY).map((s) => s.key);
  assertEquals(keys, ["type", "building_id", "address", "name"]);
});

Deno.test("unit: ADD_PROPERTY — building_id step has skip fn that skips for non-apartment", () => {
  const step = resolveFlowSteps(ADD_PROPERTY).find((s) =>
    s.key === "building_id"
  )!;
  assertEquals(typeof step.skip, "function");
  assertEquals(step.skip!({ type: "house" }), true);
  assertEquals(step.skip!({ type: "office_unit" }), true);
  assertEquals(step.skip!({ type: "apartment" }), false);
});

Deno.test("unit: ADD_PROPERTY — address step has skip fn that skips for apartment", () => {
  const step = resolveFlowSteps(ADD_PROPERTY).find((s) => s.key === "address")!;
  assertEquals(typeof step.skip, "function");
  assertEquals(step.skip!({ type: "apartment" }), true);
  assertEquals(step.skip!({ type: "house" }), false);
  assertEquals(step.skip!({ type: "office_unit" }), false);
});

Deno.test("unit: ADD_PROPERTY — type validate accepts numeric '1'/'2'/'3'", () => {
  const step = resolveFlowSteps(ADD_PROPERTY).find((s) => s.key === "type")!;
  const ctx: ContextPayload = { properties: [] };

  const r1 = step.validate!("1", {}, ctx);
  assertEquals(r1.ok, true);
  if (r1.ok) assertEquals(r1.value, "apartment");

  const r2 = step.validate!("2", {}, ctx);
  assertEquals(r2.ok, true);
  if (r2.ok) assertEquals(r2.value, "house");

  const r3 = step.validate!("3", {}, ctx);
  assertEquals(r3.ok, true);
  if (r3.ok) assertEquals(r3.value, "office_unit");
});

Deno.test("unit: ADD_PROPERTY — type validate accepts text labels (case insensitive)", () => {
  const step = resolveFlowSteps(ADD_PROPERTY).find((s) => s.key === "type")!;
  const ctx: ContextPayload = { properties: [] };

  const ra = step.validate!("Apartamento", {}, ctx);
  assertEquals(ra.ok, true);
  if (ra.ok) assertEquals(ra.value, "apartment");

  const rh = step.validate!("casa", {}, ctx);
  assertEquals(rh.ok, true);
  if (rh.ok) assertEquals(rh.value, "house");
});

Deno.test("unit: ADD_PROPERTY — type validate rejects invalid input", () => {
  const step = resolveFlowSteps(ADD_PROPERTY).find((s) => s.key === "type")!;
  const ctx: ContextPayload = { properties: [] };
  const r = step.validate!("studio", {}, ctx);
  assertEquals(r.ok, false);
  if (!r.ok) assertStringIncludes(r.error, "Tipo inválido");
});

Deno.test("unit: ADD_PROPERTY — name validate rejects empty string", () => {
  const step = resolveFlowSteps(ADD_PROPERTY).find((s) => s.key === "name")!;
  const ctx: ContextPayload = { properties: [] };
  const r = step.validate!("", {}, ctx);
  assertEquals(r.ok, false);
});

// ─── ADD_PROPERTY flow: menu routing ─────────────────────────────────────────

Deno.test("unit: workflow/next — menu number '6' routes to add_property ask_type (Enter phase)", async () => {
  const deps = makeStubDeps({});
  const handler = handleWorkflowNext(deps);

  const res = await withMockFetch(
    MOCK_USER,
    () => handler(makeReq({ message: "6" })),
  );

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.intent, "add_property");
  assertEquals(body.step, "ask_type");
  assertEquals(typeof body.state, "string");
});

Deno.test("unit: workflow/next — text label 'Adicionar imóvel' routes to add_property (Enter phase)", async () => {
  const deps = makeStubDeps({});
  const handler = handleWorkflowNext(deps);

  const res = await withMockFetch(
    MOCK_USER,
    () => handler(makeReq({ message: "Adicionar imóvel" })),
  );

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.intent, "add_property");
  assertEquals(body.step, "ask_type");
});

// ─── ADD_PROPERTY flow: house/office unit path (with address) ────────────────

Deno.test("unit: workflow/next — add_property house path: type→address→name→confirm", async () => {
  const deps = makeStubDeps({});
  const handler = handleWorkflowNext(deps);

  // Step 1: type = "2" (house) → should skip building_id, go to ask_address
  const state1 = btoa(JSON.stringify({}));
  const res1 = await withMockFetch(
    MOCK_USER,
    () =>
      handler(makeReq({ intent: "add_property", state: state1, message: "2" })),
  );
  const body1 = await json(res1) as Record<string, unknown>;
  assertEquals(body1.step, "ask_address");
  const vals1 = decodeState(body1);
  assertEquals(vals1.type, "house");

  // Step 2: address → should go to ask_name
  const state2 = body1.state as string;
  const res2 = await withMockFetch(MOCK_USER, () =>
    handler(
      makeReq({
        intent: "add_property",
        state: state2,
        message: "Rua das Flores, 123",
      }),
    ));
  const body2 = await json(res2) as Record<string, unknown>;
  assertEquals(body2.step, "ask_name");
  const vals2 = decodeState(body2);
  assertEquals(vals2.address, "Rua das Flores, 123");

  // Step 3: name → should go to confirm
  const state3 = body2.state as string;
  const res3 = await withMockFetch(MOCK_USER, () =>
    handler(
      makeReq({
        intent: "add_property",
        state: state3,
        message: "Casa dos fundos",
      }),
    ));
  const body3 = await json(res3) as Record<string, unknown>;
  assertEquals(body3.step, "confirm");
  assertStringIncludes(body3.message as string, "**Novo imóvel**");
  assertStringIncludes(body3.message as string, "Confirma?");
  assertStringIncludes(body3.message as string, "Casa dos fundos");
});

Deno.test("unit: workflow/next — add_property office unit path: type→address (skips building_id)", async () => {
  const deps = makeStubDeps({});
  const handler = handleWorkflowNext(deps);

  // type = "3" (office_unit) → skip building_id, go to ask_address
  const state1 = btoa(JSON.stringify({}));
  const res1 = await withMockFetch(
    MOCK_USER,
    () =>
      handler(makeReq({ intent: "add_property", state: state1, message: "3" })),
  );
  const body1 = await json(res1) as Record<string, unknown>;
  assertEquals(body1.step, "ask_address");
  const vals1 = decodeState(body1);
  assertEquals(vals1.type, "office_unit");
});

// ─── ADD_PROPERTY flow: apartment path (with building selection) ──────────────

Deno.test("unit: workflow/next — add_property apartment path: type→building→name→confirm", async () => {
  const contextWithBuildings: ContextPayload = {
    ...MOCK_CONTEXT,
    buildings: [
      {
        id: "bld-uuid-1",
        name: "Edifício Aurora",
        address: "Av. Paulista, 100",
      },
    ],
  };
  const deps = makeStubDeps({
    contextResult: { status: 200, body: contextWithBuildings },
  });
  const handler = handleWorkflowNext(deps);

  // Step 1: type = "1" (apartment) → should go to ask_building (skip address)
  const state1 = btoa(JSON.stringify({}));
  const res1 = await withMockFetch(
    MOCK_USER,
    () =>
      handler(makeReq({ intent: "add_property", state: state1, message: "1" })),
  );
  const body1 = await json(res1) as Record<string, unknown>;
  assertEquals(body1.step, "ask_building");
  const opts1 = body1.options as Array<{ label: string; value: string }>;
  assertEquals(Array.isArray(opts1), true);
  assertStringIncludes(opts1[0].label, "Edifício Aurora");

  // Step 2: building selection by number "1" → should go to ask_name (skipping address)
  const state2 = body1.state as string;
  const res2 = await withMockFetch(
    MOCK_USER,
    () =>
      handler(makeReq({ intent: "add_property", state: state2, message: "1" })),
  );
  const body2 = await json(res2) as Record<string, unknown>;
  assertEquals(body2.step, "ask_name");
  const vals2 = decodeState(body2);
  assertEquals(vals2.building_id, "bld-uuid-1");

  // Step 3: name → confirm
  const state3 = body2.state as string;
  const res3 = await withMockFetch(MOCK_USER, () =>
    handler(
      makeReq({ intent: "add_property", state: state3, message: "Apto 101" }),
    ));
  const body3 = await json(res3) as Record<string, unknown>;
  assertEquals(body3.step, "confirm");
  assertStringIncludes(body3.message as string, "**Novo imóvel**");
  assertStringIncludes(body3.message as string, "Apto 101");
});

// ─── ADD_PROPERTY flow: confirmation and execute ──────────────────────────────

Deno.test("unit: workflow/next — add_property 'Sim' creates property and transitions to menu", async () => {
  const deps = makeStubDeps({
    createPropertyResult: {
      status: 201,
      body: { id: "prop-uuid-new", drive_folder_id: "drive-folder-new" },
    },
  });
  const handler = handleWorkflowNext(deps);

  // House path with all values set — skip building_id (not in values), address present
  const state = btoa(JSON.stringify({
    type: "house",
    address: "Rua das Flores, 123",
    name: "Casa dos fundos",
  }));
  const res = await withMockFetch(
    MOCK_USER,
    () => handler(makeReq({ intent: "add_property", state, message: "Sim" })),
  );

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.step, "menu");
  assertEquals(body.state, null);
  assertStringIncludes(body.message as string, "Imóvel adicionado.");
  assertStringIncludes(body.message as string, "O que mais posso te ajudar?");
});

Deno.test("unit: workflow/next — add_property createProperty DB_ERROR returns friendly message at confirm", async () => {
  const deps = makeStubDeps({
    createPropertyResult: {
      status: 500,
      body: { error: { code: "DB_ERROR", message: "DB error" } },
    },
  });
  const handler = handleWorkflowNext(deps);

  const state = btoa(JSON.stringify({
    type: "house",
    address: "Rua das Flores, 123",
    name: "Casa dos fundos",
  }));
  const res = await withMockFetch(
    MOCK_USER,
    () => handler(makeReq({ intent: "add_property", state, message: "Sim" })),
  );

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.step, "confirm");
  assertStringIncludes(body.message as string, "salvar");
});

Deno.test("unit: workflow/next — add_property GOOGLE_REAUTH_REQUIRED error maps to friendly message", async () => {
  const deps = makeStubDeps({
    createPropertyResult: {
      status: 401,
      body: { error: { code: "GOOGLE_REAUTH_REQUIRED", message: "Reauth" } },
    },
  });
  const handler = handleWorkflowNext(deps);

  const state = btoa(JSON.stringify({
    type: "house",
    address: "Rua das Flores, 123",
    name: "Casa dos fundos",
  }));
  const res = await withMockFetch(
    MOCK_USER,
    () => handler(makeReq({ intent: "add_property", state, message: "Sim" })),
  );

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.step, "confirm");
  assertStringIncludes(body.message as string, "Google Drive expirou");
});

// ─── ADD_PROPERTY confirm summary: address visibility ────────────────────────

Deno.test("unit: ADD_PROPERTY — address step skip fn also gates confirm summary for apartment", () => {
  const step = resolveFlowSteps(ADD_PROPERTY).find((s) => s.key === "address")!;
  assertEquals(typeof step.skip, "function");
  assertEquals(step.skip!({ type: "apartment" }), true);
  assertEquals(step.skip!({ type: "house" }), false);
  assertEquals(step.skip!({ type: "office_unit" }), false);
});

Deno.test("unit: ADD_PROPERTY — confirm summary for apartment does not include Endereço", async () => {
  const contextWithBuildings: ContextPayload = {
    ...MOCK_CONTEXT,
    buildings: [
      {
        id: "bld-uuid-1",
        name: "Edifício Aurora",
        address: "Av. Paulista, 100",
      },
    ],
  };
  const deps = makeStubDeps({
    contextResult: { status: 200, body: contextWithBuildings },
  });
  const handler = handleWorkflowNext(deps);

  // Provide building + type, then submit name to reach confirm step
  const state2 = btoa(JSON.stringify({
    type: "apartment",
    building_id: "bld-uuid-1",
    _building_name: "Edifício Aurora",
  }));
  const res2 = await withMockFetch(MOCK_USER, () =>
    handler(
      makeReq({ intent: "add_property", state: state2, message: "Apto 202" }),
    ));

  const body2 = await json(res2) as Record<string, unknown>;
  assertEquals(body2.step, "confirm");
  assertStringIncludes(body2.message as string, "**Novo imóvel**");
  assertStringIncludes(body2.message as string, "Confirma?");
  // address line must NOT appear in apartment confirm
  assertEquals((body2.message as string).includes("Endereço"), false);
  // building name should appear instead
  assertStringIncludes(body2.message as string, "Edifício Aurora");
});

Deno.test("unit: ADD_PROPERTY — confirm summary for house includes Endereço", async () => {
  const deps = makeStubDeps({});
  const handler = handleWorkflowNext(deps);

  // house: type + address done, provide name input to reach confirm
  const state = btoa(JSON.stringify({
    type: "house",
    address: "Rua das Flores, 123",
  }));
  const res = await withMockFetch(MOCK_USER, () =>
    handler(
      makeReq({ intent: "add_property", state, message: "Casa dos fundos" }),
    ));

  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.step, "confirm");
  assertStringIncludes(body.message as string, "Endereço");
  assertStringIncludes(body.message as string, "Rua das Flores, 123");
});

Deno.test("unit: ADD_PROPERTY — confirm summary for office_unit includes Endereço", async () => {
  const deps = makeStubDeps({});
  const handler = handleWorkflowNext(deps);

  // office_unit: type + address done, provide name input to reach confirm
  const state = btoa(JSON.stringify({
    type: "office_unit",
    address: "Av. Brigadeiro, 500",
  }));
  const res = await withMockFetch(MOCK_USER, () =>
    handler(
      makeReq({ intent: "add_property", state, message: "Sala 12" }),
    ));

  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.step, "confirm");
  assertStringIncludes(body.message as string, "Endereço");
  assertStringIncludes(body.message as string, "Av. Brigadeiro, 500");
});

// ─── Engine: skip? feature ────────────────────────────────────────────────────

Deno.test("unit: engine — skip? step is excluded from pending steps", async () => {
  const skipFlow: FlowDefinition = {
    intent: "skip_test",
    confirmationTitle: "Skip Test",
    steps: [
      {
        key: "a",
        prompt: "Step A?",
        validate: (input) => ({ ok: true, value: input.trim() }),
      },
      {
        key: "b",
        prompt: "Step B (always skipped)?",
        skip: () => true,
        validate: (input) => ({ ok: true, value: input.trim() }),
      },
      {
        key: "c",
        prompt: "Step C?",
        validate: (input) => ({ ok: true, value: input.trim() }),
      },
    ],
    execute: async () => ({ ok: true, message: "done" }),
  };

  // After collecting "a", engine should skip "b" and ask for "c"
  const res = await runFlowEngine(
    skipFlow,
    { intent: "skip_test", values: {}, message: "value_a" },
    EMPTY_CONTEXT,
    MOCK_DEPS_ENGINE,
    "jwt",
  );
  assertEquals(res.step, "ask_c");
  assertEquals((res.values as Record<string, unknown>).a, "value_a");
  assertEquals("b" in (res.values as Record<string, unknown>), false);
});

// ─── send_signature flow tests ─────────────────────────────────────────────────

import { SEND_SIGNATURE } from "./intents/send-signature.ts";

function makeStubDepsWithSignature(opts: {
  contextResult?: { status: number; body: unknown };
  sendSignatureResult?: { status: number; body: unknown };
}): WorkflowDeps {
  return {
    ...makeStubDeps({}),
    loadContext: async (_jwt) => {
      return opts.contextResult ??
        { status: 200, body: MOCK_CONTEXT_WITH_TENANTS };
    },
    sendSignature: async (_jwt, _payload) => {
      return opts.sendSignatureResult ??
        {
          status: 201,
          body: { id: "sig-uuid-1", autentique_document_id: "aut-doc-1" },
        };
    },
  };
}

Deno.test("unit: send_signature — menu number '4' routes to ask_tenant (Enter phase)", async () => {
  const deps = makeStubDepsWithSignature({});
  const handler = handleWorkflowNext(deps);

  const res = await withMockFetch(
    MOCK_USER,
    () => handler(makeReq({ message: "4" })),
  );

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.intent, "send_signature");
  assertEquals(body.step, "ask_tenant");
  assertStringIncludes(body.message as string, "inquilino");
  assertEquals(typeof body.state, "string");
});

Deno.test("unit: send_signature — text label 'enviar para assinatura' routes to flow (Enter phase)", async () => {
  const deps = makeStubDepsWithSignature({});
  const handler = handleWorkflowNext(deps);

  const res = await withMockFetch(
    MOCK_USER,
    () => handler(makeReq({ message: "enviar para assinatura" })),
  );

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.intent, "send_signature");
  assertEquals(body.step, "ask_tenant");
});

Deno.test("unit: send_signature — tenant options list active tenants from ctx.tenants", async () => {
  const deps = makeStubDepsWithSignature({});
  const handler = handleWorkflowNext(deps);

  const res = await withMockFetch(
    MOCK_USER,
    () => handler(makeReq({ message: "4" })),
  );

  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.step, "ask_tenant");
  const options = body.options as Array<{ label: string; value: string }>;
  assertEquals(Array.isArray(options), true);
  assertEquals(options.length, 2);
  assertStringIncludes(options[0].label, "Maria Silva");
  assertStringIncludes(options[1].label, "João Santos");
  assertEquals(options[0].value, MOCK_TENANT_1.id);
});

Deno.test("unit: send_signature — no tenants guard: prompt returns early-exit message", async () => {
  const deps = makeStubDepsWithSignature({
    contextResult: {
      status: 200,
      body: { ...MOCK_CONTEXT, tenants: [] },
    },
  });
  const handler = handleWorkflowNext(deps);

  const res = await withMockFetch(
    MOCK_USER,
    () => handler(makeReq({ message: "4" })),
  );

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.intent, "send_signature");
  assertEquals(body.step, "ask_tenant");
  assertStringIncludes(
    body.message as string,
    "Nenhum inquilino ativo encontrado.",
  );
});

Deno.test("unit: send_signature — no tenants guard: validation rejects any reply", async () => {
  const deps = makeStubDepsWithSignature({
    contextResult: {
      status: 200,
      body: { ...MOCK_CONTEXT, tenants: [] },
    },
  });
  const handler = handleWorkflowNext(deps);

  const state = btoa(JSON.stringify({}));
  const res = await withMockFetch(
    MOCK_USER,
    () =>
      handler(
        makeReq({ intent: "send_signature", state, message: "1" }),
      ),
  );

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.step, "ask_tenant");
  assertStringIncludes(
    body.message as string,
    "Nenhum inquilino ativo encontrado.",
  );
});

Deno.test("unit: send_signature — tenant selection advances to confirm", async () => {
  const deps = makeStubDepsWithSignature({});
  const handler = handleWorkflowNext(deps);

  const state = btoa(JSON.stringify({}));
  const res = await withMockFetch(
    MOCK_USER,
    () =>
      handler(
        makeReq({ intent: "send_signature", state, message: "1" }),
      ),
  );

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.step, "confirm");
  const values = decodeState(body);
  assertEquals(values.tenant_id, MOCK_TENANT_1.id);
  assertStringIncludes(body.message as string, "Enviar para assinatura");
  assertStringIncludes(body.message as string, "Maria Silva");
});

Deno.test("unit: send_signature — happy path: 'Sim' triggers sendSignature and returns to menu", async () => {
  const deps = makeStubDepsWithSignature({
    sendSignatureResult: {
      status: 201,
      body: { id: "sig-uuid-1", autentique_document_id: "aut-doc-1" },
    },
  });
  const handler = handleWorkflowNext(deps);

  const state = btoa(JSON.stringify({
    tenant_id: MOCK_TENANT_1.id,
    tenant_name: MOCK_TENANT_1.name,
  }));
  const res = await withMockFetch(
    MOCK_USER,
    () =>
      handler(
        makeReq({ intent: "send_signature", state, message: "Sim" }),
      ),
  );

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.step, "menu");
  assertEquals(body.state, null);
  assertEquals(body.intent, null);
  assertStringIncludes(
    body.message as string,
    "Contrato enviado para assinatura.",
  );
  assertStringIncludes(body.message as string, "O que mais posso te ajudar?");
});

Deno.test("unit: send_signature — MISSING_WHATSAPP error maps to friendly message", async () => {
  const deps = makeStubDepsWithSignature({
    sendSignatureResult: {
      status: 422,
      body: { error: { code: "MISSING_WHATSAPP", message: "No whatsapp" } },
    },
  });
  const handler = handleWorkflowNext(deps);

  const state = btoa(JSON.stringify({
    tenant_id: MOCK_TENANT_1.id,
    tenant_name: MOCK_TENANT_1.name,
  }));
  const res = await withMockFetch(
    MOCK_USER,
    () =>
      handler(
        makeReq({ intent: "send_signature", state, message: "Sim" }),
      ),
  );

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.step, "confirm");
  assertStringIncludes(body.message as string, "WhatsApp");
});

Deno.test("unit: send_signature — AUTENTIQUE_SUBMISSION_FAILED error maps to friendly message", async () => {
  const deps = makeStubDepsWithSignature({
    sendSignatureResult: {
      status: 502,
      body: {
        error: {
          code: "AUTENTIQUE_SUBMISSION_FAILED",
          message: "Autentique failed",
        },
      },
    },
  });
  const handler = handleWorkflowNext(deps);

  const state = btoa(JSON.stringify({
    tenant_id: MOCK_TENANT_1.id,
    tenant_name: MOCK_TENANT_1.name,
  }));
  const res = await withMockFetch(
    MOCK_USER,
    () =>
      handler(
        makeReq({ intent: "send_signature", state, message: "Sim" }),
      ),
  );

  assertEquals(res.status, 200);
  const body = await json(res) as Record<string, unknown>;
  assertEquals(body.step, "confirm");
  assertStringIncludes(body.message as string, "Autentique");
});

// ─── SEND_SIGNATURE definition assertions ─────────────────────────────────────

Deno.test("unit: SEND_SIGNATURE — has 1 step: tenant_id", () => {
  const keys = resolveFlowSteps(SEND_SIGNATURE).map((s) => s.key);
  assertEquals(keys, ["tenant_id"]);
});

Deno.test("unit: SEND_SIGNATURE — tenant_id step has options builder", () => {
  const step = resolveFlowSteps(SEND_SIGNATURE).find((s) =>
    s.key === "tenant_id"
  );
  assertEquals(typeof step?.options, "function");
});

Deno.test("unit: SEND_SIGNATURE — tenant_id options returns empty array when no tenants", () => {
  const step = resolveFlowSteps(SEND_SIGNATURE).find((s) =>
    s.key === "tenant_id"
  )!;
  const ctx: ContextPayload = { properties: [], tenants: [] };
  const opts = step.options!({}, ctx);
  assertEquals(opts, []);
});

Deno.test("unit: SEND_SIGNATURE — tenant_id options maps tenants to label/value pairs", () => {
  const step = resolveFlowSteps(SEND_SIGNATURE).find((s) =>
    s.key === "tenant_id"
  )!;
  const ctx: ContextPayload = {
    properties: [],
    tenants: [MOCK_TENANT_1, MOCK_TENANT_2],
  };
  const opts = step.options!({}, ctx);
  assertEquals(opts.length, 2);
  assertEquals(opts[0].value, MOCK_TENANT_1.id);
  assertStringIncludes(opts[0].label, "Maria Silva");
});

// ─── Dynamic step resolution ──────────────────────────────────────────────────
//
// Verifies that FlowDefinition.steps as a function is resolved on every engine
// turn with the current values, producing a different step list as values grow.

Deno.test("unit: engine — dynamic steps: step list is resolved from current values", async () => {
  // The flow starts with a "mode" step. Once mode is collected it injects an
  // extra step only when mode === "advanced".
  const dynamicFlow: FlowDefinition = {
    intent: "dynamic_test",
    confirmationTitle: "Dynamic Summary",
    steps: (values) => {
      const base = [
        {
          key: "mode",
          prompt: "Choose mode (simple/advanced):",
          validate: (input: string) => {
            const v = input.trim().toLowerCase();
            return v === "simple" || v === "advanced"
              ? { ok: true as const, value: v }
              : { ok: false as const, error: "Invalid mode." };
          },
        },
      ];
      if (values.mode === "advanced") {
        base.push({
          key: "detail",
          prompt: "Provide detail:",
          validate: (input: string) => {
            const v = input.trim();
            return v.length > 0
              ? { ok: true as const, value: v }
              : { ok: false as const, error: "Detail required." };
          },
        });
      }
      return base;
    },
    execute: async (_values) => ({ ok: true, message: "Dynamic done!" }),
  };

  // Turn 1: empty values → step list has only "mode"; engine asks for it.
  const res1 = await runFlowEngine(
    dynamicFlow,
    { intent: "dynamic_test", values: {}, message: "" },
    EMPTY_CONTEXT,
    MOCK_DEPS_ENGINE,
    "jwt",
  );
  assertEquals(res1.step, "ask_mode");

  // Turn 2: provide mode = "simple" → only "mode" in list, all collected →
  // engine should go straight to confirm (no "detail" step injected).
  const res2 = await runFlowEngine(
    dynamicFlow,
    { intent: "dynamic_test", values: {}, message: "simple" },
    EMPTY_CONTEXT,
    MOCK_DEPS_ENGINE,
    "jwt",
  );
  assertEquals(res2.step, "confirm");
  assertEquals((res2.values as Record<string, unknown>).mode, "simple");
  assertEquals("detail" in (res2.values as Record<string, unknown>), false);

  // Turn 3: provide mode = "advanced" → "detail" is injected; engine should ask for it.
  const res3 = await runFlowEngine(
    dynamicFlow,
    { intent: "dynamic_test", values: {}, message: "advanced" },
    EMPTY_CONTEXT,
    MOCK_DEPS_ENGINE,
    "jwt",
  );
  assertEquals(res3.step, "ask_detail");
  assertEquals((res3.values as Record<string, unknown>).mode, "advanced");

  // Turn 4: provide detail with mode already set → all steps done → confirm.
  const res4 = await runFlowEngine(
    dynamicFlow,
    {
      intent: "dynamic_test",
      values: { mode: "advanced" },
      message: "extra info",
    },
    EMPTY_CONTEXT,
    MOCK_DEPS_ENGINE,
    "jwt",
  );
  assertEquals(res4.step, "confirm");
  assertEquals(
    (res4.values as Record<string, unknown>).detail,
    "extra info",
  );
});

Deno.test("unit: engine — dynamic steps: resolveFlowSteps passes values to the step function", () => {
  const dynamicFlow: FlowDefinition = {
    intent: "dyn2",
    confirmationTitle: "Dyn2",
    steps: (values) =>
      values.flag === true
        ? [{ key: "extra", prompt: "Extra?" }]
        : [{ key: "base", prompt: "Base?" }],
    execute: async () => ({ ok: true, message: "done" }),
  };

  const withoutFlag = resolveFlowSteps(dynamicFlow, {});
  assertEquals(withoutFlag.length, 1);
  assertEquals(withoutFlag[0].key, "base");

  const withFlag = resolveFlowSteps(dynamicFlow, { flag: true });
  assertEquals(withFlag.length, 1);
  assertEquals(withFlag[0].key, "extra");
});

// ─── Load hook timing ─────────────────────────────────────────────────────────
//
// Verifies that:
//   1. load fires after validate() succeeds.
//   2. load does NOT fire when validate() fails (invalid re-ask).
//   3. load fires exactly once per step, not on the confirm turn.

Deno.test("unit: engine — load hook fires after validate() succeeds, not on failure", async () => {
  let loadCallCount = 0;

  const hookFlow: FlowDefinition = {
    intent: "hook_timing",
    confirmationTitle: "Hook Timing",
    steps: [
      {
        key: "token",
        prompt: "Enter token (min 4 chars):",
        validate: (input) => {
          const v = input.trim();
          return v.length >= 4
            ? { ok: true, value: v }
            : { ok: false, error: "Too short." };
        },
        load: async (values) => {
          loadCallCount++;
          return { _loaded_token: `enriched_${values.token}` };
        },
      },
    ],
    execute: async () => ({ ok: true, message: "done" }),
  };

  // Turn 1: invalid input — load must NOT fire.
  await runFlowEngine(
    hookFlow,
    { intent: "hook_timing", values: {}, message: "ab" },
    EMPTY_CONTEXT,
    MOCK_DEPS_ENGINE,
    "jwt",
  );
  assertEquals(loadCallCount, 0);

  // Turn 2: valid input — load must fire exactly once.
  const res = await runFlowEngine(
    hookFlow,
    { intent: "hook_timing", values: {}, message: "abcd" },
    EMPTY_CONTEXT,
    MOCK_DEPS_ENGINE,
    "jwt",
  );
  assertEquals(loadCallCount, 1);
  assertEquals(res.step, "confirm");

  // Turn 3: confirm turn — load must NOT fire again.
  await runFlowEngine(
    hookFlow,
    {
      intent: "hook_timing",
      values: { token: "abcd", _loaded_token: "enriched_abcd" },
      message: "Sim",
    },
    EMPTY_CONTEXT,
    MOCK_DEPS_ENGINE,
    "jwt",
  );
  assertEquals(loadCallCount, 1); // still 1 — no extra call on confirm
});

// ─── Load hook carry-forward ──────────────────────────────────────────────────
//
// Verifies that the record returned by load is merged into values and available
// to subsequent steps' validate and options callbacks.

Deno.test("unit: engine — load hook result is merged into values for subsequent steps", async () => {
  const carryFlow: FlowDefinition = {
    intent: "carry_forward",
    confirmationTitle: "Carry Forward",
    steps: [
      {
        key: "category",
        prompt: "Pick category (A/B):",
        validate: (input) => {
          const v = input.trim().toUpperCase();
          return v === "A" || v === "B"
            ? { ok: true, value: v }
            : { ok: false, error: "Must be A or B." };
        },
        // load enriches values with _category_label for the next step to use.
        load: async (values) => ({
          _category_label: values.category === "A"
            ? "Category Alpha"
            : "Category Beta",
        }),
      },
      {
        key: "item",
        prompt: (values) =>
          `Pick item for ${values._category_label ?? "unknown"}:`,
        validate: (input, values) => {
          // The validate callback can see load-injected _category_label.
          const label = values._category_label as string | undefined;
          const v = input.trim();
          return v.length > 0 && label !== undefined
            ? { ok: true, value: v }
            : {
              ok: false,
              error: "Item required and category label must be present.",
            };
        },
      },
    ],
    execute: async () => ({ ok: true, message: "carry done" }),
  };

  // Turn 1: collect category "A" → load should fire and set _category_label.
  const res1 = await runFlowEngine(
    carryFlow,
    { intent: "carry_forward", values: {}, message: "A" },
    EMPTY_CONTEXT,
    MOCK_DEPS_ENGINE,
    "jwt",
  );
  assertEquals(res1.step, "ask_item");
  const vals1 = res1.values as Record<string, unknown>;
  assertEquals(vals1.category, "A");
  assertEquals(vals1._category_label, "Category Alpha");
  // The item prompt must reference the loaded label.
  assertStringIncludes(res1.message, "Category Alpha");

  // Turn 2: collect item with _category_label present → validate should succeed.
  const res2 = await runFlowEngine(
    carryFlow,
    {
      intent: "carry_forward",
      values: { category: "A", _category_label: "Category Alpha" },
      message: "widget",
    },
    EMPTY_CONTEXT,
    MOCK_DEPS_ENGINE,
    "jwt",
  );
  assertEquals(res2.step, "confirm");
  const vals2 = res2.values as Record<string, unknown>;
  assertEquals(vals2.item, "widget");
  assertEquals(vals2._category_label, "Category Alpha");
});
