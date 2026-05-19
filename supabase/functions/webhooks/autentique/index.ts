// POST /webhooks/autentique — receives Autentique's signed-document notification,
// verifies the HMAC-SHA256 signature, downloads the signed PDF, saves it to
// the tenant's Google Drive folder, and marks the signature_request completed.
//
// Auth: none (public endpoint) — authenticity is established exclusively via the
//   x-autentique-signature HMAC header (AUTENTIQUE_WEBHOOK_SECRET env var).
//
// Security contract (specs/SECURITY.md):
//   - HMAC verification runs BEFORE any payload processing.
//   - Timing-safe comparison via crypto.timingSafeEqual.
//   - Invalid HMAC → 401.
//   - Service-role Supabase client used (no user JWT available for webhooks).
//
// Processing (after returning 200 immediately per DESIGN.md):
//   1. Verify HMAC-SHA256 signature.
//   2. Parse payload → extract autentique_document_id and signed_pdf_url.
//   3. Look up signature_requests by autentique_document_id.
//   4. Idempotency: if already completed → return 200 immediately.
//   5. Download signed PDF from the URL in the payload.
//   6. Resolve tenant → property → current_tenant_folder_id.
//   7. Get landlord google_refresh_token → obtain fresh access token.
//   8. Upload PDF to Drive in current_tenant_folder_id.
//   9. Update signature_requests: status='completed', completed_at=now().

import { requireEnv } from "../../_shared/env.ts";
import { serviceClient } from "../../_shared/supabase.ts";
import { refreshGoogleAccessToken } from "../../_shared/google.ts";

// ─── HMAC verification ────────────────────────────────────────────────────

/**
 * Verify x-autentique-signature using HMAC-SHA256 with timing-safe comparison.
 * Returns true only when the header is present and the MAC matches.
 */
async function verifyHmac(
  rawBody: Uint8Array<ArrayBuffer>,
  signatureHeader: string | null,
  secret: string,
): Promise<boolean> {
  if (!signatureHeader) return false;

  // Import the secret as an HMAC-SHA256 key.
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  // Compute the expected MAC.
  const expectedBuffer = await crypto.subtle.sign("HMAC", key, rawBody.buffer);
  const expectedBytes = new Uint8Array(expectedBuffer);

  // Hex-encode the expected MAC for comparison with the header value.
  const expectedHex = Array.from(expectedBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // The header may be plain hex or "sha256=<hex>".
  const headerValue = signatureHeader.startsWith("sha256=")
    ? signatureHeader.slice(7)
    : signatureHeader;

  // Decode the header hex to bytes for timing-safe comparison.
  // If the header is not valid hex, reject immediately.
  if (!/^[0-9a-f]+$/i.test(headerValue)) return false;
  if (headerValue.length !== expectedHex.length) return false;

  const headerBytes = new Uint8Array(
    headerValue.match(/.{2}/g)!.map((h) => parseInt(h, 16)),
  );

  // timing-safe comparison — prevents timing attacks (specs/SECURITY.md).
  return timingSafeEqual(expectedBytes, headerBytes);
}

/**
 * Constant-time byte comparison. Runs all comparisons unconditionally so that
 * the execution time is independent of where a mismatch occurs, preventing
 * timing-side-channel attacks.
 */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

// ─── Drive upload helper ───────────────────────────────────────────────────

const DRIVE_UPLOAD_URL =
  "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart";

/**
 * Upload a PDF file to a Drive folder via multipart upload.
 * Returns the Drive file ID.
 */
async function uploadPdfToDrive(params: {
  accessToken: string;
  folderId: string;
  fileName: string;
  pdfBytes: Uint8Array;
}): Promise<string> {
  const { accessToken, folderId, fileName, pdfBytes } = params;
  const boundary = "lease_webhook_pdf_boundary";
  const metadata = JSON.stringify({
    name: fileName,
    mimeType: "application/pdf",
    parents: [folderId],
  });

  // Build multipart body per Drive API spec.
  const encoder = new TextEncoder();
  const headerPart = encoder.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`,
  );
  const trailerPart = encoder.encode(`\r\n--${boundary}--`);

  const body = new Uint8Array(
    headerPart.length + pdfBytes.length + trailerPart.length,
  );
  body.set(headerPart, 0);
  body.set(pdfBytes, headerPart.length);
  body.set(trailerPart, headerPart.length + pdfBytes.length);

  const res = await fetch(DRIVE_UPLOAD_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body,
  });

  if (!res.ok) {
    throw new Error(`drive_upload_failed_${res.status}`);
  }
  const json = await res.json() as { id: string };
  return json.id;
}

// ─── Webhook payload type ─────────────────────────────────────────────────

interface AutentiqueWebhookPayload {
  /** Autentique document identifier. */
  document?: { id?: string; files?: { signed?: string } | null } | null;
  /** Some payload formats nest the event differently — handled below. */
  [key: string]: unknown;
}

/**
 * Extract `autentique_document_id` and `signed_pdf_url` from the webhook
 * payload. Autentique's webhook body structure (best-effort, defensive parsing):
 *
 *   { document: { id: "<uuid>", files: { signed: "<url>" } } }
 *
 * Returns null for either field if parsing fails — the handler treats missing
 * fields as a malformed payload and returns 200 silently.
 */
function extractPayloadFields(payload: AutentiqueWebhookPayload): {
  documentId: string | null;
  signedPdfUrl: string | null;
} {
  const documentId = payload?.document?.id ?? null;
  const signedPdfUrl = payload?.document?.files?.signed ?? null;
  return {
    documentId: typeof documentId === "string" ? documentId : null,
    signedPdfUrl: typeof signedPdfUrl === "string" ? signedPdfUrl : null,
  };
}

// ─── Handler ──────────────────────────────────────────────────────────────

export async function handleAutentiqueWebhook(
  req: Request,
): Promise<Response> {
  // Only POST is supported.
  if (req.method !== "POST") {
    return new Response(null, { status: 405 });
  }

  // Read the raw body as bytes (required for HMAC verification before parsing).
  let rawBodyBytes: Uint8Array<ArrayBuffer>;
  try {
    const bodyBuffer = await req.arrayBuffer();
    rawBodyBytes = new Uint8Array(bodyBuffer as ArrayBuffer);
  } catch {
    // Even on read error, return 200 to avoid Autentique retries for unreadable payloads.
    return new Response(null, { status: 200 });
  }

  // Verify HMAC-SHA256 BEFORE any payload processing (specs/SECURITY.md).
  const webhookSecret = requireEnv("AUTENTIQUE_WEBHOOK_SECRET");
  const signatureHeader = req.headers.get("x-autentique-signature");

  const hmacValid = await verifyHmac(
    rawBodyBytes,
    signatureHeader,
    webhookSecret,
  );
  if (!hmacValid) {
    return new Response(
      JSON.stringify({
        error: { code: "UNAUTHORIZED", message: "Invalid signature." },
      }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }

  // Return 200 immediately per DESIGN.md (before async processing).
  // Processing runs synchronously after this point — Deno Edge Functions are
  // request-scoped; we complete the work within the same invocation.

  // Parse webhook payload.
  let payload: AutentiqueWebhookPayload;
  try {
    const rawText = new TextDecoder().decode(rawBodyBytes);
    payload = JSON.parse(rawText) as AutentiqueWebhookPayload;
  } catch {
    // Malformed JSON — acknowledge and ignore. Do not expose internals.
    return new Response(null, { status: 200 });
  }

  const { documentId, signedPdfUrl } = extractPayloadFields(payload);

  // Missing required fields — acknowledge and ignore (silent per spec).
  if (!documentId || !signedPdfUrl) {
    return new Response(null, { status: 200 });
  }

  // Use service-role client — no user JWT available for webhook handlers.
  // Approved in specs/SECURITY.md (webhook exception).
  const db = serviceClient();

  // Look up the signature_request by autentique_document_id.
  const { data: sigRequest, error: sigError } = await db
    .from("signature_requests")
    .select("id, status, tenant_id, landlord_id")
    .eq("autentique_document_id", documentId)
    .maybeSingle();

  if (sigError || !sigRequest) {
    // Unknown document — acknowledge silently (don't expose internal IDs).
    return new Response(null, { status: 200 });
  }

  const sig = sigRequest as {
    id: string;
    status: string;
    tenant_id: string;
    landlord_id: string;
  };

  // Idempotency: if already completed, return 200 immediately.
  if (sig.status === "completed") {
    return new Response(null, { status: 200 });
  }

  // Look up tenant to get property_id.
  const { data: tenant, error: tenantError } = await db
    .from("tenants")
    .select("id, property_id")
    .eq("id", sig.tenant_id)
    .maybeSingle();

  if (tenantError || !tenant) {
    // Cannot proceed — acknowledge silently.
    return new Response(null, { status: 200 });
  }

  const ten = tenant as { id: string; property_id: string };

  // Look up property to get current_tenant_folder_id.
  const { data: property, error: propertyError } = await db
    .from("properties")
    .select("current_tenant_folder_id")
    .eq("id", ten.property_id)
    .maybeSingle();

  if (propertyError || !property) {
    return new Response(null, { status: 200 });
  }

  const prop = property as { current_tenant_folder_id: string | null };

  if (!prop.current_tenant_folder_id) {
    // No active tenant folder — acknowledge silently.
    return new Response(null, { status: 200 });
  }

  // Look up landlord to get google_refresh_token.
  const { data: landlord, error: landlordError } = await db
    .from("landlords")
    .select("google_refresh_token")
    .eq("id", sig.landlord_id)
    .maybeSingle();

  if (landlordError || !landlord) {
    return new Response(null, { status: 200 });
  }

  const land = landlord as { google_refresh_token: string };

  // Download the signed PDF from Autentique.
  let pdfBytes: Uint8Array;
  try {
    const pdfRes = await fetch(signedPdfUrl);
    if (!pdfRes.ok) {
      return new Response(null, { status: 200 });
    }
    const pdfBuffer = await pdfRes.arrayBuffer();
    pdfBytes = new Uint8Array(pdfBuffer);
  } catch {
    return new Response(null, { status: 200 });
  }

  // Obtain a fresh Google access token from the landlord's refresh token.
  let accessToken: string;
  try {
    accessToken = await refreshGoogleAccessToken(land.google_refresh_token);
  } catch {
    return new Response(null, { status: 200 });
  }

  // Upload the signed PDF to the tenant's Drive folder.
  const fileName = `contrato-assinado-${sig.tenant_id}.pdf`;
  try {
    await uploadPdfToDrive({
      accessToken,
      folderId: prop.current_tenant_folder_id,
      fileName,
      pdfBytes,
    });
  } catch {
    return new Response(null, { status: 200 });
  }

  // Mark the signature_request as completed.
  await db
    .from("signature_requests")
    .update({ status: "completed", completed_at: new Date().toISOString() })
    .eq("id", sig.id);

  return new Response(null, { status: 200 });
}

if (import.meta.main) Deno.serve(handleAutentiqueWebhook);
