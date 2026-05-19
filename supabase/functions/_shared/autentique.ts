// Thin wrapper around the Autentique GraphQL API. Covers onboarding validation
// and signing operations (submit, status query, reminder update).

const AUTENTIQUE_GRAPHQL_URL = "https://api.autentique.com.br/v2/graphql";

export interface AutentiqueValidationResult {
  ok: boolean;
  // Present only when ok === true. We never return it to the client; it's just
  // used internally by callers that want to log a non-PII success signal.
  accountName?: string;
}

/**
 * Validate an Autentique API key by making a real GraphQL test call.
 *
 * Input bounds enforced before any network call (defence-in-depth — callers
 * should also validate before passing the key here):
 *   - Non-empty string, 10–256 characters.
 *   - No ASCII control characters (0x00–0x1F, 0x7F) — prevents HTTP header
 *     injection when the key is used in `Authorization: Bearer <key>`.
 *   - No internal whitespace — Autentique tokens are opaque and must not
 *     contain spaces.
 *
 * Returns `{ ok: true }` only when the API returns a valid `me { name }` response.
 */
export async function validateAutentiqueApiKey(
  apiKey: string,
): Promise<AutentiqueValidationResult> {
  // Input bounds check — must pass before we put this string in an HTTP header.
  if (typeof apiKey !== "string") return { ok: false };
  const trimmed = apiKey.trim();
  if (trimmed.length < 10 || trimmed.length > 256) return { ok: false };
  // deno-lint-ignore no-control-regex
  if (/[\x00-\x1F\x7F]/.test(trimmed)) return { ok: false };
  if (/\s/.test(trimmed)) return { ok: false };

  let res: Response;
  try {
    res = await fetch(AUTENTIQUE_GRAPHQL_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${trimmed}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ query: "{ me { name } }" }),
    });
  } catch {
    return { ok: false };
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false };
  }
  if (!res.ok) {
    return { ok: false };
  }
  let json: {
    data?: { me?: { name?: string } | null } | null;
    errors?: unknown;
  };
  try {
    json = await res.json();
  } catch {
    return { ok: false };
  }
  if (json.errors || !json.data?.me?.name) {
    return { ok: false };
  }
  return { ok: true, accountName: json.data.me.name };
}

// ─── Shared validation helper ─────────────────────────────────────────────

/**
 * Validate and sanitise an Autentique API key for use in HTTP headers.
 * Returns the trimmed key if valid, or null if the key fails any bound check.
 * This prevents HTTP header injection when the key is placed in Authorization.
 */
function sanitiseApiKey(apiKey: string): string | null {
  if (typeof apiKey !== "string") return null;
  const trimmed = apiKey.trim();
  if (trimmed.length < 10 || trimmed.length > 256) return null;
  // deno-lint-ignore no-control-regex
  if (/[\x00-\x1F\x7F]/.test(trimmed)) return null;
  if (/\s/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Execute an Autentique GraphQL request.
 * Returns the parsed JSON response body, or throws on network/HTTP error.
 */
async function graphqlRequest(
  apiKey: string,
  body: { query: string; variables?: Record<string, unknown> },
): Promise<{ data?: Record<string, unknown> | null; errors?: unknown }> {
  const res = await fetch(AUTENTIQUE_GRAPHQL_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`autentique_http_${res.status}`);
  }
  return await res.json() as {
    data?: Record<string, unknown> | null;
    errors?: unknown;
  };
}

// ─── submitDocument ───────────────────────────────────────────────────────

export interface AutentiqueSigner {
  /** Display name on the signing document. */
  name: string;
  /** Optional email address (may be null for WhatsApp-only signers). */
  email?: string | null;
  /** WhatsApp number in E.164 format, e.g. "+5511999999999". */
  whatsapp: string;
  /** Role token matching the marker in the PDF, e.g. "LOCADOR". */
  role: string;
  /** X position in PDF points from lower-left. */
  x: number;
  /** Y position in PDF points from lower-left. */
  y: number;
  /** 1-based page number. */
  page: number;
}

export interface SubmitDocumentParams {
  /** Raw PDF bytes as a base64-encoded string. */
  pdfBase64: string;
  /** All signers with their positions. */
  signers: AutentiqueSigner[];
  /** Reminder frequency: "DAILY" or "WEEKLY". */
  reminderFrequency: "DAILY" | "WEEKLY";
}

export interface SubmitDocumentResult {
  /** Autentique document ID returned after successful submission. */
  documentId: string;
}

/**
 * Submit a PDF document to Autentique for signing.
 *
 * Delivery method is always WHATSAPP (per project spec).
 * Each signer receives a signing request via their WhatsApp number.
 *
 * Throws on any network failure or GraphQL error so the caller can implement
 * retry logic with exponential backoff.
 */
export async function submitDocument(
  apiKey: string,
  params: SubmitDocumentParams,
): Promise<SubmitDocumentResult> {
  const key = sanitiseApiKey(apiKey);
  if (!key) throw new Error("autentique_invalid_api_key");

  const { pdfBase64, signers, reminderFrequency } = params;
  if (!pdfBase64 || typeof pdfBase64 !== "string") {
    throw new Error("autentique_invalid_pdf_base64");
  }
  if (!Array.isArray(signers) || signers.length === 0) {
    throw new Error("autentique_no_signers");
  }

  // Build the signers input array for the GraphQL mutation.
  const signersInput = signers.map((s) => ({
    name: s.name,
    email: s.email ?? null,
    whatsapp: s.whatsapp,
    action: {
      name: "SIGN",
      positions: [
        {
          x: String(s.x),
          y: String(s.y),
          z: String(s.page),
          element: "SIGNATURE",
          type: "SIGNATURE",
        },
      ],
    },
  }));

  const mutation = `
    mutation CreateDocument($name: String!, $content: Upload!, $signers: [SignerInput!]!, $reminderFrequency: ReminderFrequency) {
      createDocument(
        document: {
          name: $name
          content: $content
          reminder_frequency: $reminderFrequency
          delivery_method: DELIVERY_METHOD_WHATSAPP
        }
        signers: $signers
      ) {
        id
      }
    }
  `;

  // Autentique uses a multipart GraphQL upload for the PDF file.
  // We submit via the standard multipart form per the GraphQL multipart spec.
  const operationsJson = JSON.stringify({
    query: mutation,
    variables: {
      name: "Contrato de Locação",
      content: null, // will be mapped by the file upload
      signers: signersInput,
      reminderFrequency,
    },
  });

  const mapJson = JSON.stringify({ "0": ["variables.content"] });

  // Convert base64 to bytes.
  const pdfBinary = Uint8Array.from(atob(pdfBase64), (c) => c.charCodeAt(0));

  const form = new FormData();
  form.append("operations", operationsJson);
  form.append("map", mapJson);
  form.append(
    "0",
    new Blob([pdfBinary], { type: "application/pdf" }),
    "contrato.pdf",
  );

  const res = await fetch(AUTENTIQUE_GRAPHQL_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
    },
    body: form,
  });

  if (!res.ok) {
    throw new Error(`autentique_http_${res.status}`);
  }

  const json = await res.json() as {
    data?: { createDocument?: { id?: string } | null } | null;
    errors?: unknown;
  };

  if (json.errors) {
    throw new Error(`autentique_graphql_error`);
  }

  const documentId = json.data?.createDocument?.id;
  if (!documentId) {
    throw new Error("autentique_missing_document_id");
  }

  return { documentId };
}

// ─── getDocumentStatus ────────────────────────────────────────────────────

export interface AutentiqueSignerStatus {
  name: string;
  /** ISO 8601 datetime string if this signer has signed; null if pending. */
  signed_at: string | null;
}

export interface GetDocumentStatusResult {
  /** Overall document status derived from signer completion. */
  status: "pending" | "completed";
  signers: AutentiqueSignerStatus[];
}

/**
 * Query an Autentique document for its current signing status and per-signer
 * signed_at timestamps.
 *
 * Returns `{ status: "completed" }` only when all signers have signed.
 * Returns `{ status: "pending" }` if any signer has not yet signed.
 *
 * Throws on network or GraphQL errors.
 */
export async function getDocumentStatus(
  apiKey: string,
  documentId: string,
): Promise<GetDocumentStatusResult> {
  const key = sanitiseApiKey(apiKey);
  if (!key) throw new Error("autentique_invalid_api_key");
  if (!documentId || typeof documentId !== "string") {
    throw new Error("autentique_invalid_document_id");
  }

  const query = `
    query GetDocument($id: UUID!) {
      document(id: $id) {
        name
        signatures {
          name
          signed {
            created_at
          }
        }
      }
    }
  `;

  const json = await graphqlRequest(key, {
    query,
    variables: { id: documentId },
  }) as {
    data?: {
      document?: {
        signatures?: Array<{
          name: string;
          signed?: { created_at: string } | null;
        }>;
      } | null;
    } | null;
    errors?: unknown;
  };

  if (json.errors) {
    throw new Error("autentique_graphql_error");
  }

  const signatures = json.data?.document?.signatures ?? [];

  const signers: AutentiqueSignerStatus[] = signatures.map((s) => ({
    name: s.name,
    signed_at: s.signed?.created_at ?? null,
  }));

  const allSigned = signers.length > 0 &&
    signers.every((s) => s.signed_at !== null);

  return {
    status: allSigned ? "completed" : "pending",
    signers,
  };
}

// ─── updateReminderFrequency ──────────────────────────────────────────────

/**
 * Update the signing reminder frequency for an existing Autentique document.
 *
 * @param frequency  "DAILY" or "WEEKLY"
 *
 * Throws on network or GraphQL errors.
 */
export async function updateReminderFrequency(
  apiKey: string,
  documentId: string,
  frequency: "DAILY" | "WEEKLY",
): Promise<void> {
  const key = sanitiseApiKey(apiKey);
  if (!key) throw new Error("autentique_invalid_api_key");
  if (!documentId || typeof documentId !== "string") {
    throw new Error("autentique_invalid_document_id");
  }
  if (frequency !== "DAILY" && frequency !== "WEEKLY") {
    throw new Error("autentique_invalid_frequency");
  }

  const mutation = `
    mutation UpdateDocument($id: UUID!, $reminderFrequency: ReminderFrequency) {
      updateDocument(
        id: $id
        document: { reminder_frequency: $reminderFrequency }
      ) {
        id
      }
    }
  `;

  const json = await graphqlRequest(key, {
    query: mutation,
    variables: { id: documentId, reminderFrequency: frequency },
  }) as {
    data?: { updateDocument?: { id?: string } | null } | null;
    errors?: unknown;
  };

  if (json.errors) {
    throw new Error("autentique_graphql_error");
  }
}
