// unit: signatures/status handler
//
// Tests GET /signatures/:id/status and PATCH /signatures/:id/reminder
// with all external dependencies mocked.
//
// Test names follow the ci.sh filter: "unit|integration".

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

// Set required env vars before importing modules.
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_ANON_KEY", "test-anon-key");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
Deno.env.set("GOOGLE_CLIENT_ID", "test-google-client-id");
Deno.env.set("GOOGLE_CLIENT_SECRET", "test-google-client-secret");

import { handleStatus } from "./index.ts";

// ─── Fixtures ─────────────────────────────────────────────────────────────

const VALID_UUID = "123e4567-e89b-12d3-a456-426614174000";
const SIG_REQ_UUID = "323e4567-e89b-12d3-a456-426614174002";
const AUTENTIQUE_DOC_ID = "autentique-doc-123";
const MOCK_JWT = "mock-jwt-token";

// ─── Request builders ──────────────────────────────────────────────────────

function makeStatusRequest(id: string, jwt = MOCK_JWT): Request {
  return new Request(
    `http://localhost/signatures/${id}/status`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${jwt}` },
    },
  );
}

function makeReminderRequest(
  id: string,
  body: unknown,
  jwt = MOCK_JWT,
): Request {
  return new Request(
    `http://localhost/signatures/${id}/reminder`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
}

// ─── Fetch stub ───────────────────────────────────────────────────────────

type StatusStubConfig = {
  userValid?: boolean;
  sigReqFound?: boolean;
  landlordFound?: boolean;
  autentiqueStatusOk?: boolean;
  autentiqueUpdateOk?: boolean;
  autentiqueSigners?: Array<{ name: string; signed_at: string | null }>;
};

function buildStatusFetch(cfg: StatusStubConfig = {}): typeof globalThis.fetch {
  const c: Required<StatusStubConfig> = {
    userValid: cfg.userValid ?? true,
    sigReqFound: cfg.sigReqFound ?? true,
    landlordFound: cfg.landlordFound ?? true,
    autentiqueStatusOk: cfg.autentiqueStatusOk ?? true,
    autentiqueUpdateOk: cfg.autentiqueUpdateOk ?? true,
    autentiqueSigners: cfg.autentiqueSigners ?? [
      { name: "João Silva", signed_at: "2026-01-15T10:00:00Z" },
      { name: "Maria Proprietária", signed_at: null },
    ],
  };

  return async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : (input as Request).url;
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();

    // ── Supabase Auth: getUser ───────────────────────────────────────────
    if (url.includes("/auth/v1/user") && method === "GET") {
      if (!c.userValid) {
        return new Response(
          JSON.stringify({ error: "invalid_token" }),
          { status: 401 },
        );
      }
      return new Response(
        JSON.stringify({
          user: {
            id: VALID_UUID,
            email: "landlord@example.com",
            user_metadata: {},
          },
        }),
        { status: 200 },
      );
    }

    // ── Supabase REST: signature_requests query ─────────────────────────
    if (url.includes("/rest/v1/signature_requests") && method === "GET") {
      if (!c.sigReqFound) {
        return new Response(JSON.stringify(null), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          id: SIG_REQ_UUID,
          autentique_document_id: AUTENTIQUE_DOC_ID,
          status: "pending",
          created_at: "2026-01-10T08:00:00Z",
          completed_at: null,
        }),
        { status: 200 },
      );
    }

    // ── Supabase REST: landlords query ──────────────────────────────────
    if (url.includes("/rest/v1/landlords") && method === "GET") {
      if (!c.landlordFound) {
        return new Response(JSON.stringify(null), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          autentique_api_key: "a".repeat(32),
        }),
        { status: 200 },
      );
    }

    // ── Autentique GraphQL ───────────────────────────────────────────────
    if (url.includes("api.autentique.com.br")) {
      // Distinguish status query vs update mutation by request body.
      let bodyText = "";
      if (init?.body) {
        if (typeof init.body === "string") {
          bodyText = init.body;
        } else if (init.body instanceof FormData) {
          bodyText = "multipart";
        }
      }

      const isUpdate = bodyText.includes("updateDocument") ||
        bodyText.includes("UpdateDocument");

      if (isUpdate) {
        if (!c.autentiqueUpdateOk) {
          return new Response(
            JSON.stringify({ errors: [{ message: "update failed" }] }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            data: { updateDocument: { id: AUTENTIQUE_DOC_ID } },
          }),
          { status: 200 },
        );
      }

      // Status query.
      if (!c.autentiqueStatusOk) {
        return new Response(
          JSON.stringify({ errors: [{ message: "query failed" }] }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          data: {
            document: {
              name: "Contrato de Locação",
              signatures: c.autentiqueSigners.map((s) => ({
                name: s.name,
                signed: s.signed_at ? { created_at: s.signed_at } : null,
              })),
            },
          },
        }),
        { status: 200 },
      );
    }

    throw new Error(`Unexpected fetch in unit test: ${method} ${url}`);
  };
}

function withFetch(
  stub: typeof globalThis.fetch,
  fn: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// GET /signatures/:id/status
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: status — OPTIONS returns 200", async () => {
  const req = new Request(
    `http://localhost/signatures/${SIG_REQ_UUID}/status`,
    {
      method: "OPTIONS",
    },
  );
  const res = await handleStatus(req);
  assertEquals(res.status, 200);
});

Deno.test("unit: status GET — missing Authorization header returns 401", async () => {
  const req = new Request(
    `http://localhost/signatures/${SIG_REQ_UUID}/status`,
    { method: "GET" },
  );
  const stub = buildStatusFetch();
  await withFetch(stub, async () => {
    const res = await handleStatus(req);
    assertEquals(res.status, 401);
  });
});

Deno.test("unit: status GET — invalid JWT returns 401", async () => {
  const req = makeStatusRequest(SIG_REQ_UUID);
  const stub = buildStatusFetch({ userValid: false });
  await withFetch(stub, async () => {
    const res = await handleStatus(req);
    assertEquals(res.status, 401);
  });
});

Deno.test("unit: status GET — signature_request not found returns 404", async () => {
  const req = makeStatusRequest(SIG_REQ_UUID);
  const stub = buildStatusFetch({ sigReqFound: false });
  await withFetch(stub, async () => {
    const res = await handleStatus(req);
    assertEquals(res.status, 404);
    const body = await res.json();
    assertEquals(body.error.code, "SIGNATURE_REQUEST_NOT_FOUND");
  });
});

Deno.test("unit: status GET — non-UUID id returns 400", async () => {
  const req = makeStatusRequest("not-a-uuid");
  const stub = buildStatusFetch();
  await withFetch(stub, async () => {
    const res = await handleStatus(req);
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error.code, "INVALID_ID");
  });
});

Deno.test("unit: status GET — happy path returns 200 with correct shape", async () => {
  const req = makeStatusRequest(SIG_REQ_UUID);
  const stub = buildStatusFetch({
    autentiqueSigners: [
      { name: "João Silva", signed_at: "2026-01-15T10:00:00Z" },
      { name: "Maria Proprietária", signed_at: null },
    ],
  });
  await withFetch(stub, async () => {
    const res = await handleStatus(req);
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.status, "pending");
    assertEquals(body.created_at, "2026-01-10T08:00:00Z");
    assertEquals(body.completed_at, null);
    assertEquals(Array.isArray(body.signers), true);
    assertEquals(body.signers.length, 2);
    assertEquals(body.signers[0].name, "João Silva");
    assertEquals(body.signers[0].signed_at, "2026-01-15T10:00:00Z");
    assertEquals(body.signers[1].name, "Maria Proprietária");
    assertEquals(body.signers[1].signed_at, null);
  });
});

Deno.test("unit: status GET — all signed returns signers with signed_at set", async () => {
  const req = makeStatusRequest(SIG_REQ_UUID);
  const stub = buildStatusFetch({
    autentiqueSigners: [
      { name: "João Silva", signed_at: "2026-01-15T10:00:00Z" },
      { name: "Maria Proprietária", signed_at: "2026-01-16T11:00:00Z" },
    ],
  });
  await withFetch(stub, async () => {
    const res = await handleStatus(req);
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(Array.isArray(body.signers), true);
    // Both signers have signed_at.
    for (const signer of body.signers) {
      assertEquals(signer.signed_at !== null, true);
    }
  });
});

Deno.test("unit: status GET — Autentique fetch failure returns 502", async () => {
  const req = makeStatusRequest(SIG_REQ_UUID);
  const stub = buildStatusFetch({ autentiqueStatusOk: false });
  await withFetch(stub, async () => {
    const res = await handleStatus(req);
    assertEquals(res.status, 502);
    const body = await res.json();
    assertEquals(body.error.code, "AUTENTIQUE_FETCH_FAILED");
  });
});

Deno.test("unit: status GET — landlord not found returns 404", async () => {
  const req = makeStatusRequest(SIG_REQ_UUID);
  const stub = buildStatusFetch({ landlordFound: false });
  await withFetch(stub, async () => {
    const res = await handleStatus(req);
    assertEquals(res.status, 404);
    const body = await res.json();
    assertEquals(body.error.code, "LANDLORD_NOT_FOUND");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PATCH /signatures/:id/reminder
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("unit: reminder PATCH — missing Authorization header returns 401", async () => {
  const req = new Request(
    `http://localhost/signatures/${SIG_REQ_UUID}/reminder`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ frequency: "DAILY" }),
    },
  );
  const stub = buildStatusFetch();
  await withFetch(stub, async () => {
    const res = await handleStatus(req);
    assertEquals(res.status, 401);
  });
});

Deno.test("unit: reminder PATCH — invalid JWT returns 401", async () => {
  const req = makeReminderRequest(SIG_REQ_UUID, { frequency: "DAILY" });
  const stub = buildStatusFetch({ userValid: false });
  await withFetch(stub, async () => {
    const res = await handleStatus(req);
    assertEquals(res.status, 401);
  });
});

Deno.test("unit: reminder PATCH — invalid frequency returns 400", async () => {
  const req = makeReminderRequest(SIG_REQ_UUID, { frequency: "MONTHLY" });
  const stub = buildStatusFetch();
  await withFetch(stub, async () => {
    const res = await handleStatus(req);
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error.code, "INVALID_FREQUENCY");
  });
});

Deno.test("unit: reminder PATCH — missing frequency returns 400", async () => {
  const req = makeReminderRequest(SIG_REQ_UUID, {});
  const stub = buildStatusFetch();
  await withFetch(stub, async () => {
    const res = await handleStatus(req);
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error.code, "INVALID_FREQUENCY");
  });
});

Deno.test("unit: reminder PATCH — invalid JSON body returns 400", async () => {
  const req = new Request(
    `http://localhost/signatures/${SIG_REQ_UUID}/reminder`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${MOCK_JWT}`,
        "Content-Type": "application/json",
      },
      body: "not json {",
    },
  );
  const stub = buildStatusFetch();
  await withFetch(stub, async () => {
    const res = await handleStatus(req);
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error.code, "INVALID_JSON");
  });
});

Deno.test("unit: reminder PATCH — non-UUID id returns 400", async () => {
  const req = makeReminderRequest("not-a-uuid", { frequency: "DAILY" });
  const stub = buildStatusFetch();
  await withFetch(stub, async () => {
    const res = await handleStatus(req);
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error.code, "INVALID_ID");
  });
});

Deno.test("unit: reminder PATCH — DAILY frequency happy path returns 200", async () => {
  const req = makeReminderRequest(SIG_REQ_UUID, { frequency: "DAILY" });
  const stub = buildStatusFetch();
  await withFetch(stub, async () => {
    const res = await handleStatus(req);
    assertEquals(res.status, 200);
  });
});

Deno.test("unit: reminder PATCH — WEEKLY frequency happy path returns 200", async () => {
  const req = makeReminderRequest(SIG_REQ_UUID, { frequency: "WEEKLY" });
  const stub = buildStatusFetch();
  await withFetch(stub, async () => {
    const res = await handleStatus(req);
    assertEquals(res.status, 200);
  });
});

Deno.test("unit: reminder PATCH — signature_request not found returns 404", async () => {
  const req = makeReminderRequest(SIG_REQ_UUID, { frequency: "DAILY" });
  const stub = buildStatusFetch({ sigReqFound: false });
  await withFetch(stub, async () => {
    const res = await handleStatus(req);
    assertEquals(res.status, 404);
    const body = await res.json();
    assertEquals(body.error.code, "SIGNATURE_REQUEST_NOT_FOUND");
  });
});

Deno.test("unit: reminder PATCH — Autentique update failure returns 502", async () => {
  const req = makeReminderRequest(SIG_REQ_UUID, { frequency: "DAILY" });
  const stub = buildStatusFetch({ autentiqueUpdateOk: false });
  await withFetch(stub, async () => {
    const res = await handleStatus(req);
    assertEquals(res.status, 502);
    const body = await res.json();
    assertEquals(body.error.code, "AUTENTIQUE_UPDATE_FAILED");
  });
});

Deno.test("unit: reminder PATCH — landlord not found returns 404", async () => {
  const req = makeReminderRequest(SIG_REQ_UUID, { frequency: "WEEKLY" });
  const stub = buildStatusFetch({ landlordFound: false });
  await withFetch(stub, async () => {
    const res = await handleStatus(req);
    assertEquals(res.status, 404);
    const body = await res.json();
    assertEquals(body.error.code, "LANDLORD_NOT_FOUND");
  });
});

// ─── Tests: unsupported method ────────────────────────────────────────────

Deno.test("unit: status — PUT method returns 405", async () => {
  const req = new Request(
    `http://localhost/signatures/${SIG_REQ_UUID}/status`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${MOCK_JWT}` },
    },
  );
  const stub = buildStatusFetch();
  await withFetch(stub, async () => {
    const res = await handleStatus(req);
    assertEquals(res.status, 405);
  });
});
