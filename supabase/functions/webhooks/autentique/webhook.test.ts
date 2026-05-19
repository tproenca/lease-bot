// unit: POST /webhooks/autentique
//
// Tests call handleAutentiqueWebhook() directly. All external calls (Supabase,
// Drive upload, signed PDF fetch, Google token refresh) are stubbed via
// globalThis.fetch replacement.
//
// No hardcoded secrets — AUTENTIQUE_WEBHOOK_SECRET is read from Deno.env.
// All test names are prefixed "unit:" per ci.sh filter conventions.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

// Set required env vars BEFORE importing the handler so requireEnv() passes.
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_ANON_KEY", "test-anon-key");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
Deno.env.set("AUTENTIQUE_WEBHOOK_SECRET", "test-webhook-secret-32chars!!");
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

const WEBHOOK_SECRET = Deno.env.get("AUTENTIQUE_WEBHOOK_SECRET")!;

const MOCK_DOC_ID = "autentique-doc-uuid-123";
const MOCK_SIG_REQUEST_ID = "sig-request-uuid-456";
const MOCK_TENANT_ID = "tenant-uuid-789";
const MOCK_LANDLORD_ID = "landlord-uuid-abc";
const MOCK_PROPERTY_ID = "property-uuid-def";
const MOCK_FOLDER_ID = "drive-folder-id-ghi";
const MOCK_SIGNED_PDF_URL = "https://cdn.autentique.com.br/signed/doc.pdf";
const MOCK_REFRESH_TOKEN = "google-refresh-token";
const MOCK_ACCESS_TOKEN = "google-access-token";
const MOCK_DRIVE_FILE_ID = "new-drive-file-id";

const VALID_PAYLOAD = JSON.stringify({
  document: {
    id: MOCK_DOC_ID,
    files: { signed: MOCK_SIGNED_PDF_URL },
  },
});

// ─── Fetch stub builder ───────────────────────────────────────────────────────

type MockFetchOpts = {
  sigRequestData?: unknown;
  sigRequestError?: boolean;
  sigRequestStatus?: string;
  tenantData?: unknown;
  tenantError?: boolean;
  propertyData?: unknown;
  propertyError?: boolean;
  landlordData?: unknown;
  landlordError?: boolean;
  signatureUpdateError?: boolean;
  pdfDownloadOk?: boolean;
  googleTokenOk?: boolean;
  driveUploadOk?: boolean;
};

function buildMockFetch(opts: MockFetchOpts = {}) {
  const {
    sigRequestData,
    sigRequestError = false,
    sigRequestStatus = "pending",
    tenantData,
    tenantError = false,
    propertyData,
    propertyError = false,
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
        const data = sigRequestData ?? defaultSigRequest;
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
      const data = tenantData ?? defaultTenant;
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
      const data = propertyData ?? defaultProperty;
      return new Response(JSON.stringify(data), { status: 200 });
    }

    // PostgREST: landlords lookup
    if (url.includes("/rest/v1/landlords")) {
      if (landlordError) {
        return new Response(
          JSON.stringify({ message: "db error", code: "PGRST000" }),
          { status: 500 },
        );
      }
      const data = landlordData ?? defaultLandlord;
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
  } = {},
): Promise<Request> {
  const { useValidSignature = true, secret = WEBHOOK_SECRET } = opts;

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

  return new Request("http://localhost/webhooks/autentique", {
    method: "POST",
    headers,
    body,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// HMAC verification
// ═══════════════════════════════════════════════════════════════════════════════

Deno.test("unit: webhook — 401 when x-autentique-signature header is missing", async () => {
  const req = new Request("http://localhost/webhooks/autentique", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: VALID_PAYLOAD,
  });

  const res = await handleAutentiqueWebhook(req);
  assertEquals(res.status, 401);
  const body = await res.json() as Record<string, unknown>;
  assertEquals(
    (body.error as Record<string, string>).code,
    "UNAUTHORIZED",
  );
});

Deno.test("unit: webhook — 401 when HMAC signature is invalid", async () => {
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
});

Deno.test("unit: webhook — 401 when HMAC is computed with a different secret", async () => {
  const req = await makeWebhookRequest(VALID_PAYLOAD, {
    useValidSignature: true,
    secret: "wrong-secret-completely-different",
  });

  const res = await handleAutentiqueWebhook(req);
  assertEquals(res.status, 401);
});

Deno.test("unit: webhook — 401 when signature header has wrong length", async () => {
  const req = await makeWebhookRequest(VALID_PAYLOAD, {
    signature: "tooshort",
  });

  const res = await handleAutentiqueWebhook(req);
  assertEquals(res.status, 401);
});

Deno.test("unit: webhook — 401 when signature header is not valid hex", async () => {
  const req = await makeWebhookRequest(VALID_PAYLOAD, {
    signature:
      "GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG",
  });

  const res = await handleAutentiqueWebhook(req);
  assertEquals(res.status, 401);
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
  const badPayload = "not json at all {{";
  const req = await makeWebhookRequest(badPayload);
  const res = await handleAutentiqueWebhook(req);
  assertEquals(res.status, 200);
});

Deno.test("unit: webhook — 200 silent when payload is missing document.id", async () => {
  const noId = JSON.stringify({
    document: { files: { signed: MOCK_SIGNED_PDF_URL } },
  });
  const req = await makeWebhookRequest(noId);
  const res = await handleAutentiqueWebhook(req);
  assertEquals(res.status, 200);
});

Deno.test("unit: webhook — 200 silent when payload is missing signed PDF URL", async () => {
  const noUrl = JSON.stringify({ document: { id: MOCK_DOC_ID } });
  const req = await makeWebhookRequest(noUrl);
  const res = await handleAutentiqueWebhook(req);
  assertEquals(res.status, 200);
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
    new Request("http://localhost/webhooks/autentique", { method: "GET" }),
  );
  assertEquals(res.status, 405);
});

Deno.test("unit: webhook — 405 when method is DELETE", async () => {
  const res = await handleAutentiqueWebhook(
    new Request("http://localhost/webhooks/autentique", { method: "DELETE" }),
  );
  assertEquals(res.status, 405);
});
