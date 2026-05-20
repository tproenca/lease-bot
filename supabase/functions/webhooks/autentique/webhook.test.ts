// unit: POST /webhooks/autentique/{landlord_id}
//
// Tests call handleAutentiqueWebhook() directly. All external calls (Supabase,
// Drive upload, signed PDF fetch, Google token refresh) are stubbed via
// globalThis.fetch replacement.
//
// The per-landlord webhook secret is read from the DB (mocked here via the
// fetch stub returning a `landlords` row with `autentique_webhook_secret`).
// All test names are prefixed "unit:" per test naming conventions.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

// Set required env vars BEFORE importing the handler so requireEnv() passes.
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_ANON_KEY", "test-anon-key");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
Deno.env.set("GOOGLE_CLIENT_ID", "test-client-id");
Deno.env.set("GOOGLE_CLIENT_SECRET", "test-client-secret");

import { handleAutentiqueWebhook } from "./index.ts";

// ─── HMAC helper ──────────────────────────────────────────────────────────────
// Re-implement the same HMAC logic here so tests can generate valid signatures
// without importing internal implementation details.

async function computeHmacSignature(
  body: string,
  secret: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(body),
  );
  return Array.from(new Uint8Array(sigBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const WEBHOOK_SECRET = "test-webhook-secret-32chars!!";

const MOCK_DOC_ID = "autentique-doc-uuid-123";
const MOCK_SIG_REQUEST_ID = "sig-request-uuid-456";
const MOCK_TENANT_ID = "tenant-uuid-789";
// Must be a UUID-shaped string — extractLandlordId() rejects anything else.
const MOCK_LANDLORD_ID = "11111111-2222-3333-4444-555555555555";
const MOCK_PROPERTY_ID = "property-uuid-def";
const MOCK_FOLDER_ID = "drive-folder-id-ghi";
const MOCK_SIGNED_PDF_URL = "https://cdn.autentique.com.br/signed/doc.pdf";
const MOCK_REFRESH_TOKEN = "google-refresh-token";
const MOCK_ACCESS_TOKEN = "google-access-token";
const MOCK_DRIVE_FILE_ID = "new-drive-file-id";

// Real `document.finished` payload shape (event.data.id / event.data.files.signed).
const VALID_PAYLOAD = JSON.stringify({
  event: {
    type: "document.finished",
    data: {
      id: MOCK_DOC_ID,
      files: { signed: MOCK_SIGNED_PDF_URL },
    },
  },
});

// ─── Fetch stub builder ───────────────────────────────────────────────────────

type MockFetchOpts = {
  // Each *Data field uses a sentinel: omit the key (undefined) to get the
  // default fixture, set to `null` to simulate "no row" (PostgREST returns
  // null body / maybeSingle returns null), or set to a concrete object to
  // override the fixture. We cannot use the `??` operator on the option value
  // because `null` is the "no row" signal — `null ?? default` would
  // unintentionally fall back to the default.
  sigRequestData?: unknown;
  sigRequestError?: boolean;
  sigRequestStatus?: string;
  tenantData?: unknown;
  tenantError?: boolean;
  propertyData?: unknown;
  propertyError?: boolean;
  // The "landlords" lookup happens twice in the handler:
  //   1. First to fetch `autentique_webhook_secret` BEFORE HMAC verification.
  //   2. Later to fetch `google_refresh_token` for Drive upload.
  // The mock distinguishes by which column is requested in the URL.
  landlordSecretData?: unknown;
  landlordSecretError?: boolean;
  landlordData?: unknown;
  landlordError?: boolean;
  signatureUpdateError?: boolean;
  pdfDownloadOk?: boolean;
  googleTokenOk?: boolean;
  driveUploadOk?: boolean;
};

// Treat `undefined` as "no override → use default fixture", and any other
// value (including `null`) as the explicit value the mock should return.
function pick<T>(override: unknown, defaultValue: T): unknown {
  return override === undefined ? defaultValue : override;
}

function buildMockFetch(opts: MockFetchOpts = {}) {
  const {
    sigRequestData,
    sigRequestError = false,
    sigRequestStatus = "pending",
    tenantData,
    tenantError = false,
    propertyData,
    propertyError = false,
    landlordSecretData,
    landlordSecretError = false,
    landlordData,
    landlordError = false,
    pdfDownloadOk = true,
    googleTokenOk = true,
    driveUploadOk = true,
  } = opts;

  const defaultSigRequest = {
    id: MOCK_SIG_REQUEST_ID,
    status: sigRequestStatus,
    tenant_id: MOCK_TENANT_ID,
    landlord_id: MOCK_LANDLORD_ID,
  };

  const defaultTenant = {
    id: MOCK_TENANT_ID,
    property_id: MOCK_PROPERTY_ID,
  };

  const defaultProperty = {
    current_tenant_folder_id: MOCK_FOLDER_ID,
  };

  const defaultLandlordSecret = {
    autentique_webhook_secret: WEBHOOK_SECRET,
  };

  const defaultLandlord = {
    google_refresh_token: MOCK_REFRESH_TOKEN,
  };

  return async function mockFetch(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : (input as Request).url;
    const method = (init as RequestInit | undefined)?.method?.toUpperCase() ??
      "GET";

    // PostgREST: signature_requests lookup (GET by autentique_document_id)
    if (url.includes("/rest/v1/signature_requests")) {
      if (method === "GET") {
        if (sigRequestError) {
          return new Response(
            JSON.stringify({ message: "db error", code: "PGRST000" }),
            { status: 500 },
          );
        }
        const data = pick(sigRequestData, defaultSigRequest);
        // maybeSingle returns the object directly or null
        return new Response(JSON.stringify(data), {
          status: 200,
          headers: { "Content-Range": "0-0/1" },
        });
      }
      if (method === "PATCH") {
        if (opts.signatureUpdateError) {
          return new Response(
            JSON.stringify({ message: "db error", code: "PGRST000" }),
            { status: 500 },
          );
        }
        return new Response(JSON.stringify([]), { status: 200 });
      }
    }

    // PostgREST: tenants lookup
    if (url.includes("/rest/v1/tenants")) {
      if (tenantError) {
        return new Response(
          JSON.stringify({ message: "db error", code: "PGRST000" }),
          { status: 500 },
        );
      }
      const data = pick(tenantData, defaultTenant);
      return new Response(JSON.stringify(data), { status: 200 });
    }

    // PostgREST: properties lookup
    if (url.includes("/rest/v1/properties")) {
      if (propertyError) {
        return new Response(
          JSON.stringify({ message: "db error", code: "PGRST000" }),
          { status: 500 },
        );
      }
      const data = pick(propertyData, defaultProperty);
      return new Response(JSON.stringify(data), { status: 200 });
    }

    // PostgREST: landlords lookup. The handler queries this table TWICE — once
    // to read the webhook secret (BEFORE HMAC verification) and once later to
    // read the Google refresh token. Distinguish by the `select` query param.
    if (url.includes("/rest/v1/landlords")) {
      const isSecretQuery = url.includes("autentique_webhook_secret");
      if (isSecretQuery) {
        if (landlordSecretError) {
          return new Response(
            JSON.stringify({ message: "db error", code: "PGRST000" }),
            { status: 500 },
          );
        }
        const data = pick(landlordSecretData, defaultLandlordSecret);
        return new Response(JSON.stringify(data), { status: 200 });
      }
      // Otherwise it is the refresh-token lookup later in the flow.
      if (landlordError) {
        return new Response(
          JSON.stringify({ message: "db error", code: "PGRST000" }),
          { status: 500 },
        );
      }
      const data = pick(landlordData, defaultLandlord);
      return new Response(JSON.stringify(data), { status: 200 });
    }

    // Autentique CDN — signed PDF download
    if (url.includes("autentique.com.br") || url === MOCK_SIGNED_PDF_URL) {
      if (!pdfDownloadOk) {
        return new Response(null, { status: 500 });
      }
      // Return minimal valid PDF bytes
      const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF
      return new Response(pdfBytes.buffer, {
        status: 200,
        headers: { "Content-Type": "application/pdf" },
      });
    }

    // Google OAuth token endpoint
    if (url.includes("oauth2.googleapis.com/token")) {
      if (!googleTokenOk) {
        return new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
        });
      }
      return new Response(
        JSON.stringify({
          access_token: MOCK_ACCESS_TOKEN,
          token_type: "Bearer",
          expires_in: 3600,
          scope: "https://www.googleapis.com/auth/drive",
        }),
        { status: 200 },
      );
    }

    // Google Drive upload
    if (
      url.includes("googleapis.com/upload/drive") ||
      url.includes("googleapis.com/drive")
    ) {
      if (!driveUploadOk) {
        return new Response(null, { status: 500 });
      }
      return new Response(
        JSON.stringify({ id: MOCK_DRIVE_FILE_ID }),
        { status: 200 },
      );
    }

    throw new Error(`Unexpected fetch in test: ${method} ${url}`);
  };
}

// ─── Request helper ───────────────────────────────────────────────────────────

async function makeWebhookRequest(
  body: string,
  opts: {
    signature?: string | null;
    useValidSignature?: boolean;
    secret?: string;
    landlordId?: string;
  } = {},
): Promise<Request> {
  const {
    useValidSignature = true,
    secret = WEBHOOK_SECRET,
    landlordId = MOCK_LANDLORD_ID,
  } = opts;

  let signatureHeader: string | undefined;
  if (opts.signature !== undefined) {
    signatureHeader = opts.signature ?? undefined;
  } else if (useValidSignature) {
    signatureHeader = await computeHmacSignature(body, secret);
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (signatureHeader !== undefined && signatureHeader !== null) {
    headers["x-autentique-signature"] = signatureHeader;
  }

  // Build the path with the landlord_id segment. If landlordId is empty
  // string we omit the trailing slash to exercise the "missing landlord_id"
  // path-parsing branch.
  const path = landlordId
    ? `/webhooks/autentique/${landlordId}`
    : `/webhooks/autentique`;

  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers,
    body,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Path parsing — landlord_id extraction
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("unit: webhook — 401 when landlord_id missing from URL path", async () => {
  const originalFetch = globalThis.fetch;
  // Even if fetch were called, no DB lookup should happen — but guard anyway.
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const req = await makeWebhookRequest(VALID_PAYLOAD, { landlordId: "" });
    const res = await handleAutentiqueWebhook(req);
    assertEquals(res.status, 401);
    const body = await res.json() as Record<string, unknown>;
    assertEquals(
      (body.error as Record<string, string>).code,
      "UNAUTHORIZED",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("unit: webhook — 401 when landlord_id is not a UUID", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const req = await makeWebhookRequest(VALID_PAYLOAD, {
      landlordId: "not-a-uuid",
    });
    const res = await handleAutentiqueWebhook(req);
    assertEquals(res.status, 401);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("unit: webhook — 401 when landlord_id not found in DB", async () => {
  const originalFetch = globalThis.fetch;
  // landlordSecretData=null → maybeSingle returns no row → 401 (same response
  // as bad signature so we do not leak landlord existence).
  globalThis.fetch = buildMockFetch({
    landlordSecretData: null,
  }) as typeof fetch;
  try {
    const req = await makeWebhookRequest(VALID_PAYLOAD);
    const res = await handleAutentiqueWebhook(req);
    assertEquals(res.status, 401);
    const body = await res.json() as Record<string, unknown>;
    assertEquals(
      (body.error as Record<string, string>).code,
      "UNAUTHORIZED",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("unit: webhook — 401 when DB lookup for landlord secret fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({
    landlordSecretError: true,
  }) as typeof fetch;
  try {
    const req = await makeWebhookRequest(VALID_PAYLOAD);
    const res = await handleAutentiqueWebhook(req);
    assertEquals(res.status, 401);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// HMAC verification
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("unit: webhook — 401 when x-autentique-signature header is missing", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const req = new Request(
      `http://localhost/webhooks/autentique/${MOCK_LANDLORD_ID}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: VALID_PAYLOAD,
      },
    );

    const res = await handleAutentiqueWebhook(req);
    assertEquals(res.status, 401);
    const body = await res.json() as Record<string, unknown>;
    assertEquals(
      (body.error as Record<string, string>).code,
      "UNAUTHORIZED",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("unit: webhook — 401 when HMAC signature is invalid", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const req = await makeWebhookRequest(VALID_PAYLOAD, {
      signature:
        "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    });

    const res = await handleAutentiqueWebhook(req);
    assertEquals(res.status, 401);
    const body = await res.json() as Record<string, unknown>;
    assertEquals(
      (body.error as Record<string, string>).code,
      "UNAUTHORIZED",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("unit: webhook — 401 when HMAC is computed with a different secret", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const req = await makeWebhookRequest(VALID_PAYLOAD, {
      useValidSignature: true,
      secret: "wrong-secret-completely-different",
    });

    const res = await handleAutentiqueWebhook(req);
    assertEquals(res.status, 401);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("unit: webhook — 401 when signature header has wrong length", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const req = await makeWebhookRequest(VALID_PAYLOAD, {
      signature: "tooshort",
    });

    const res = await handleAutentiqueWebhook(req);
    assertEquals(res.status, 401);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("unit: webhook — 401 when signature header is not valid hex", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const req = await makeWebhookRequest(VALID_PAYLOAD, {
      signature:
        "GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG",
    });

    const res = await handleAutentiqueWebhook(req);
    assertEquals(res.status, 401);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("unit: webhook — 401 when landlord row has empty webhook secret", async () => {
  const originalFetch = globalThis.fetch;
  // Empty secret cannot produce a meaningful HMAC; treat as unauthenticated.
  globalThis.fetch = buildMockFetch({
    landlordSecretData: { autentique_webhook_secret: "" },
  }) as typeof fetch;
  try {
    const req = await makeWebhookRequest(VALID_PAYLOAD);
    const res = await handleAutentiqueWebhook(req);
    assertEquals(res.status, 401);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Happy path — valid webhook end to end
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("unit: webhook — 200 on valid signature and successful processing", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const req = await makeWebhookRequest(VALID_PAYLOAD);
    const res = await handleAutentiqueWebhook(req);
    assertEquals(res.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("unit: webhook — accepts sha256=<hex> prefixed signature format", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const hexSig = await computeHmacSignature(VALID_PAYLOAD, WEBHOOK_SECRET);
    const req = await makeWebhookRequest(VALID_PAYLOAD, {
      signature: `sha256=${hexSig}`,
    });
    const res = await handleAutentiqueWebhook(req);
    assertEquals(res.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Idempotency — already completed
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("unit: webhook — 200 no-op when signature_request already completed", async () => {
  const originalFetch = globalThis.fetch;
  // Status is 'completed' — should return 200 immediately without Drive/Google calls.
  globalThis.fetch = buildMockFetch({
    sigRequestStatus: "completed",
  }) as typeof fetch;
  try {
    const req = await makeWebhookRequest(VALID_PAYLOAD);
    const res = await handleAutentiqueWebhook(req);
    assertEquals(res.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Missing document — silent 200 (don't expose internal IDs)
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("unit: webhook — 200 silent when autentique_document_id not found in DB", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ sigRequestData: null }) as typeof fetch;
  try {
    const req = await makeWebhookRequest(VALID_PAYLOAD);
    const res = await handleAutentiqueWebhook(req);
    assertEquals(res.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Malformed payload — silent 200
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("unit: webhook — 200 silent when payload is not valid JSON", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const badPayload = "not json at all {{";
    const req = await makeWebhookRequest(badPayload);
    const res = await handleAutentiqueWebhook(req);
    assertEquals(res.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("unit: webhook — 200 silent when payload is missing event.data.id", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const noId = JSON.stringify({
      event: { data: { files: { signed: MOCK_SIGNED_PDF_URL } } },
    });
    const req = await makeWebhookRequest(noId);
    const res = await handleAutentiqueWebhook(req);
    assertEquals(res.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("unit: webhook — 200 silent when payload is missing signed PDF URL", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const noUrl = JSON.stringify({
      event: { data: { id: MOCK_DOC_ID } },
    });
    const req = await makeWebhookRequest(noUrl);
    const res = await handleAutentiqueWebhook(req);
    assertEquals(res.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("unit: webhook — 200 silent when payload uses legacy `document.id` path (no `event` wrapper)", async () => {
  // Defence against silently regressing back to the old (wrong) parse paths:
  // a payload shaped like `{ document: { id, files: { signed } } }` must NOT
  // be accepted as containing a document id/signed_pdf_url.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({}) as typeof fetch;
  try {
    const legacy = JSON.stringify({
      document: {
        id: MOCK_DOC_ID,
        files: { signed: MOCK_SIGNED_PDF_URL },
      },
    });
    const req = await makeWebhookRequest(legacy);
    const res = await handleAutentiqueWebhook(req);
    // Auth passes (HMAC is valid against the body), but no documentId is
    // extracted → silent 200 (no DB lookup for the doc).
    assertEquals(res.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Downstream failures — silent 200 (resilience — don't trigger Autentique retries)
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("unit: webhook — 200 silent when PDF download fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ pdfDownloadOk: false }) as typeof fetch;
  try {
    const req = await makeWebhookRequest(VALID_PAYLOAD);
    const res = await handleAutentiqueWebhook(req);
    assertEquals(res.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("unit: webhook — 200 silent when Google token refresh fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ googleTokenOk: false }) as typeof fetch;
  try {
    const req = await makeWebhookRequest(VALID_PAYLOAD);
    const res = await handleAutentiqueWebhook(req);
    assertEquals(res.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("unit: webhook — 200 silent when Drive upload fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ driveUploadOk: false }) as typeof fetch;
  try {
    const req = await makeWebhookRequest(VALID_PAYLOAD);
    const res = await handleAutentiqueWebhook(req);
    assertEquals(res.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("unit: webhook — 200 silent when signature_request DB lookup fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ sigRequestError: true }) as typeof fetch;
  try {
    const req = await makeWebhookRequest(VALID_PAYLOAD);
    const res = await handleAutentiqueWebhook(req);
    assertEquals(res.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("unit: webhook — 200 silent when tenant DB lookup fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({ tenantError: true }) as typeof fetch;
  try {
    const req = await makeWebhookRequest(VALID_PAYLOAD);
    const res = await handleAutentiqueWebhook(req);
    assertEquals(res.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("unit: webhook — 200 silent when property has no current_tenant_folder_id", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({
    propertyData: { current_tenant_folder_id: null },
  }) as typeof fetch;
  try {
    const req = await makeWebhookRequest(VALID_PAYLOAD);
    const res = await handleAutentiqueWebhook(req);
    assertEquals(res.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("unit: DB update failure after Drive upload returns 500", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildMockFetch({
    signatureUpdateError: true,
  }) as typeof fetch;
  try {
    const req = await makeWebhookRequest(VALID_PAYLOAD);
    const res = await handleAutentiqueWebhook(req);
    assertEquals(res.status, 500);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Method validation
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("unit: webhook — 405 when method is GET", async () => {
  const res = await handleAutentiqueWebhook(
    new Request(`http://localhost/webhooks/autentique/${MOCK_LANDLORD_ID}`, {
      method: "GET",
    }),
  );
  assertEquals(res.status, 405);
});

Deno.test("unit: webhook — 405 when method is DELETE", async () => {
  const res = await handleAutentiqueWebhook(
    new Request(`http://localhost/webhooks/autentique/${MOCK_LANDLORD_ID}`, {
      method: "DELETE",
    }),
  );
  assertEquals(res.status, 405);
});
