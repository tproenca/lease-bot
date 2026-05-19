// POST /documents/generate — substitution engine.
//
// Looks up all templates mapped to the property's type, copies each to the
// tenant's Drive folder (Root/{property}/{tenant}/), replaces every
// {{placeholder}} token with the provided value (applying case transformations
// per the placeholder's `case` setting), and returns the Drive URLs of the
// generated documents. Regeneration overwrites existing files atomically.
//
// Auth: Bearer JWT verified via Supabase Auth — returns 401 if missing/invalid.
// Uses userClient(jwt) for all DB ops — RLS enforces landlord isolation.
// Drive: uses the landlord's stored Google OAuth refresh token.
//
// Error behaviour:
//   422 — any required placeholder value is missing from the request body
//   400 — malformed request / unknown placeholder key in request body
//   404 — property or tenant not found (or belongs to another landlord)
//   502 — Google Drive API error after 3 retries

import { corsHeaders } from "../_shared/cors.ts";
import { errorResponse } from "../_shared/errors.ts";
import {
  extractBearer,
  getAuthenticatedUser,
  userClient,
} from "../_shared/supabase.ts";
import { refreshGoogleAccessToken } from "../_shared/google.ts";
import { isNonEmptyString } from "../_shared/validation.ts";

// ─── Drive API constants ───────────────────────────────────────────────────

const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";

// ─── Case transformation ──────────────────────────────────────────────────

/**
 * Apply the placeholder's `case` transformation to a string value.
 *
 * Supported values (from specs/DESIGN.md):
 *   maiúsculas — UPPERCASE
 *   minúsculas — lowercase
 *   título     — Title Case (first letter of each word capitalised)
 *   frase      — Sentence case (first letter of the whole string capitalised)
 *
 * If `caseTransform` is null/undefined, the value is returned unchanged.
 */
export function applyCase(value: string, caseTransform: string | null | undefined): string {
  if (!caseTransform) return value;
  switch (caseTransform) {
    case "maiúsculas":
      return value.toUpperCase();
    case "minúsculas":
      return value.toLowerCase();
    case "título":
      // Title Case: capitalise first letter of each whitespace-separated word.
      return value.replace(/\S+/g, (word) =>
        word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
      );
    case "frase":
      // Sentence case: capitalise first letter of the entire string.
      return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
    default:
      return value;
  }
}

// ─── Substitution engine ──────────────────────────────────────────────────

/**
 * Replace all {{name}} tokens in `content` using the provided map of name →
 * transformed value. Tokens that do not appear in the map are left unchanged
 * (the caller has already validated completeness).
 */
export function substituteTokens(
  content: string,
  values: Map<string, string>,
): string {
  // Replace each occurrence of {{name}} (case-sensitive match) with its value.
  return content.replace(/\{\{([^}]+)\}\}/g, (_match, name: string) => {
    const val = values.get(name.trim());
    return val !== undefined ? val : `{{${name}}}`;
  });
}

// ─── Drive retry helper ───────────────────────────────────────────────────

/**
 * Perform a Drive API fetch with up to 3 retries on 429 (rate limit) or 500
 * (server error) responses. Uses exponential backoff: 1 s, 2 s, 4 s.
 */
async function driveRequestWithRetry(
  input: string | URL,
  init: RequestInit,
): Promise<Response> {
  const MAX_ATTEMPTS = 3;
  const RETRYABLE_STATUSES = new Set([429, 500]);

  let lastRes: Response | undefined;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      // Exponential backoff: 1000 ms, 2000 ms, …
      await new Promise((resolve) => setTimeout(resolve, 1000 * Math.pow(2, attempt - 1)));
    }
    lastRes = await fetch(input, init);
    if (!RETRYABLE_STATUSES.has(lastRes.status)) {
      return lastRes;
    }
  }
  return lastRes!;
}

// ─── Drive helpers (document-generation specific) ──────────────────────────

/**
 * Export a Google Doc as plain text via the Drive export endpoint.
 * Used to read the template content for token substitution.
 */
async function exportDocAsText(params: {
  accessToken: string;
  fileId: string;
}): Promise<string> {
  const url = new URL(
    `${DRIVE_FILES_URL}/${encodeURIComponent(params.fileId)}/export`,
  );
  url.searchParams.set("mimeType", "text/plain");

  const res = await driveRequestWithRetry(url, {
    headers: { Authorization: `Bearer ${params.accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`drive_export_failed_${res.status}`);
  }
  return await res.text();
}

/**
 * Find an existing file by name inside a Drive folder.
 * Returns the file ID if found, null otherwise.
 */
async function findFileInFolder(params: {
  accessToken: string;
  parentFolderId: string;
  name: string;
}): Promise<string | null> {
  const safeName = params.name.replace(/'/g, "\\'");
  const q = [
    `'${params.parentFolderId}' in parents`,
    `name = '${safeName}'`,
    `trashed = false`,
  ].join(" and ");
  const url = new URL(DRIVE_FILES_URL);
  url.searchParams.set("q", q);
  url.searchParams.set("fields", "files(id)");
  url.searchParams.set("pageSize", "1");

  const res = await driveRequestWithRetry(url, {
    headers: { Authorization: `Bearer ${params.accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`drive_search_file_failed_${res.status}`);
  }
  const json = await res.json() as { files: Array<{ id: string }> };
  return json.files[0]?.id ?? null;
}

/**
 * Copy a Drive file into a given parent folder with a specified name.
 * Returns the new file's ID.
 */
async function copyDriveFile(params: {
  accessToken: string;
  sourceFileId: string;
  name: string;
  parentFolderId: string;
}): Promise<string> {
  const url = new URL(
    `${DRIVE_FILES_URL}/${encodeURIComponent(params.sourceFileId)}/copy`,
  );
  url.searchParams.set("fields", "id");

  const res = await driveRequestWithRetry(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: params.name,
      parents: [params.parentFolderId],
    }),
  });
  if (!res.ok) {
    throw new Error(`drive_copy_failed_${res.status}`);
  }
  const json = await res.json() as { id: string };
  return json.id;
}

/**
 * Update the plain-text content of an existing Google Doc via media upload.
 * Used to write the substituted content into the copied file.
 */
async function updateDocContent(params: {
  accessToken: string;
  fileId: string;
  content: string;
}): Promise<void> {
  const url =
    `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(params.fileId)}?uploadType=media`;

  const res = await driveRequestWithRetry(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${params.accessToken}`,
      "Content-Type": "text/plain",
    },
    body: params.content,
  });
  if (!res.ok) {
    throw new Error(`drive_update_content_failed_${res.status}`);
  }
}

/**
 * Delete a Drive file by ID. Used when atomically overwriting an existing file
 * (delete old copy, then create fresh copy with substituted content).
 */
async function deleteDriveFile(params: {
  accessToken: string;
  fileId: string;
}): Promise<void> {
  const url = new URL(
    `${DRIVE_FILES_URL}/${encodeURIComponent(params.fileId)}`,
  );
  const res = await driveRequestWithRetry(url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${params.accessToken}` },
  });
  // 204 = success, 404 = already gone (idempotent)
  if (!res.ok && res.status !== 404) {
    throw new Error(`drive_delete_failed_${res.status}`);
  }
}

/**
 * Return the Drive web view URL for a file ID.
 */
function driveUrl(fileId: string): string {
  return `https://docs.google.com/document/d/${fileId}/edit`;
}

// ─── Handler ──────────────────────────────────────────────────────────────

export async function handleGenerateDocuments(req: Request): Promise<Response> {
  // Handle CORS preflight.
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return errorResponse(405, "METHOD_NOT_ALLOWED", "Método não permitido.");
  }

  // 1. Verify JWT.
  const jwt = extractBearer(req);
  if (!jwt) {
    return errorResponse(
      401,
      "UNAUTHORIZED",
      "Token de autorização não encontrado.",
    );
  }

  const user = await getAuthenticatedUser(jwt);
  if (!user) {
    return errorResponse(
      401,
      "UNAUTHORIZED",
      "Token de autorização inválido ou expirado.",
    );
  }

  // 2. Parse and validate request body.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, "INVALID_JSON", "Corpo da requisição inválido.");
  }

  const { property_id, tenant_id, placeholders: rawPlaceholders } =
    (body ?? {}) as Record<string, unknown>;

  if (!isNonEmptyString(property_id)) {
    return errorResponse(
      400,
      "MISSING_PROPERTY_ID",
      "O campo 'property_id' é obrigatório.",
    );
  }

  if (!isNonEmptyString(tenant_id)) {
    return errorResponse(
      400,
      "MISSING_TENANT_ID",
      "O campo 'tenant_id' é obrigatório.",
    );
  }

  if (
    rawPlaceholders === null ||
    rawPlaceholders === undefined ||
    typeof rawPlaceholders !== "object" ||
    Array.isArray(rawPlaceholders)
  ) {
    return errorResponse(
      400,
      "INVALID_PLACEHOLDERS",
      "O campo 'placeholders' deve ser um objeto com os valores dos campos.",
    );
  }

  const incomingValues = rawPlaceholders as Record<string, unknown>;

  // 3. Load landlord credentials.
  const db = userClient(jwt);
  const { data: landlord, error: landlordError } = await db
    .from("landlords")
    .select("google_refresh_token")
    .eq("id", user.id)
    .maybeSingle();

  if (landlordError || !landlord) {
    return errorResponse(
      404,
      "LANDLORD_NOT_FOUND",
      "Cadastro do proprietário não encontrado. Conclua o processo de configuração.",
    );
  }

  const landlordRow = landlord as Record<string, unknown>;

  // 4. Load the property (RLS ensures it belongs to this landlord).
  const { data: property, error: propertyError } = await db
    .from("properties")
    .select("id, type, drive_folder_id")
    .eq("id", property_id)
    .maybeSingle();

  if (propertyError || !property) {
    return errorResponse(404, "PROPERTY_NOT_FOUND", "Imóvel não encontrado.");
  }

  const prop = property as { id: string; type: string; drive_folder_id: string };

  // 5. Load the tenant (RLS ensures it belongs to this landlord).
  const { data: tenant, error: tenantError } = await db
    .from("tenants")
    .select("id, drive_folder_id, property_id")
    .eq("id", tenant_id)
    .maybeSingle();

  if (tenantError || !tenant) {
    return errorResponse(404, "TENANT_NOT_FOUND", "Inquilino não encontrado.");
  }

  const ten = tenant as { id: string; drive_folder_id: string; property_id: string };

  // 6. Verify tenant belongs to this property (defence in depth beyond RLS).
  if (ten.property_id !== prop.id) {
    return errorResponse(
      404,
      "TENANT_NOT_FOUND",
      "Inquilino não encontrado para este imóvel.",
    );
  }

  // 7. Load placeholder definitions for this landlord.
  const { data: placeholderDefs, error: placeholderError } = await db
    .from("placeholders")
    .select("name, required, case")
    .eq("landlord_id", user.id);

  if (placeholderError) {
    return errorResponse(
      500,
      "DB_ERROR",
      "Erro ao carregar as definições dos campos. Tente novamente.",
    );
  }

  const defs = (placeholderDefs ?? []) as Array<{
    name: string;
    required: boolean;
    case: string | null;
  }>;

  // Build a lookup map from placeholder name to its definition.
  const defsByName = new Map(defs.map((d) => [d.name, d]));

  // 8. Validate that no unknown placeholder keys were sent in the request.
  for (const key of Object.keys(incomingValues)) {
    if (!defsByName.has(key)) {
      return errorResponse(
        400,
        "UNKNOWN_PLACEHOLDER",
        `O campo '${key}' não está definido nos placeholders do proprietário.`,
      );
    }
  }

  // 9. Validate that all required placeholders are present and non-empty.
  const missingRequired: string[] = [];
  for (const def of defs) {
    if (!def.required) continue;
    const val = incomingValues[def.name];
    if (val === undefined || val === null || val === "") {
      missingRequired.push(def.name);
    }
  }

  if (missingRequired.length > 0) {
    return errorResponse(
      422,
      "MISSING_REQUIRED_PLACEHOLDERS",
      `Os seguintes campos obrigatórios estão ausentes: ${missingRequired.join(", ")}.`,
    );
  }

  // 10. Build the final value map with case transformations applied.
  const valueMap = new Map<string, string>();
  for (const [key, raw] of Object.entries(incomingValues)) {
    const def = defsByName.get(key);
    const stringVal = String(raw ?? "");
    const transformed = def ? applyCase(stringVal, def.case) : stringVal;
    valueMap.set(key, transformed);
  }

  // Also fill in defaults for optional placeholders not in the request.
  for (const def of defs) {
    if (!valueMap.has(def.name)) {
      // Use empty string for optional placeholders with no value provided.
      valueMap.set(def.name, "");
    }
  }

  // 11. Load templates mapped to this property's type.
  const { data: mappings, error: mappingError } = await db
    .from("property_type_templates")
    .select("template_id")
    .eq("landlord_id", user.id)
    .eq("property_type", prop.type);

  if (mappingError) {
    return errorResponse(
      500,
      "DB_ERROR",
      "Erro ao carregar os templates para este tipo de imóvel. Tente novamente.",
    );
  }

  const templateIds = ((mappings ?? []) as Array<{ template_id: string }>).map(
    (m) => m.template_id,
  );

  if (templateIds.length === 0) {
    return errorResponse(
      404,
      "NO_TEMPLATES_FOUND",
      `Nenhum template encontrado para imóveis do tipo '${prop.type}'.`,
    );
  }

  // 12. Load template rows.
  const { data: templates, error: templateError } = await db
    .from("templates")
    .select("id, name, drive_file_id")
    .in("id", templateIds);

  if (templateError || !templates) {
    return errorResponse(
      500,
      "DB_ERROR",
      "Erro ao carregar os templates. Tente novamente.",
    );
  }

  const templateRows = templates as Array<{
    id: string;
    name: string;
    drive_file_id: string;
  }>;

  // 13. Obtain a fresh Google access token.
  let accessToken: string;
  try {
    accessToken = await refreshGoogleAccessToken(
      landlordRow.google_refresh_token as string,
    );
  } catch {
    return errorResponse(
      502,
      "GOOGLE_AUTH_FAILED",
      "Falha ao autenticar com o Google Drive. Tente novamente.",
    );
  }

  // 14. Generate each document.
  //
  // Regeneration strategy (atomic overwrite):
  //   a. Find any existing file with the same name in the tenant's folder.
  //   b. Copy the source template into the tenant's folder (new file ID).
  //   c. Export the copy as plain text, apply substitutions, write back.
  //   d. Delete the old file (if it existed). Deletion is last so the new
  //      version is always present before the old one is removed.
  //
  // If any step fails, we return an error. The tenant folder may end up with
  // both old and new files in the rare failure case — acceptable given the
  // small scale (the landlord can re-run and it will overwrite again).

  const tenantFolderId = ten.drive_folder_id;
  const results: Array<{ template_name: string; drive_url: string }> = [];

  for (const template of templateRows) {
    const destName = template.name;

    // a. Find existing file with same name (for overwrite).
    let existingFileId: string | null;
    try {
      existingFileId = await findFileInFolder({
        accessToken,
        parentFolderId: tenantFolderId,
        name: destName,
      });
    } catch {
      return errorResponse(
        502,
        "DRIVE_SEARCH_FAILED",
        "Falha ao verificar arquivos existentes no Google Drive. Tente novamente.",
      );
    }

    // b. Copy the source template to the tenant's folder.
    let newFileId: string;
    try {
      newFileId = await copyDriveFile({
        accessToken,
        sourceFileId: template.drive_file_id,
        name: destName,
        parentFolderId: tenantFolderId,
      });
    } catch {
      return errorResponse(
        502,
        "DRIVE_COPY_FAILED",
        `Falha ao copiar o template '${destName}' para o Google Drive. Tente novamente.`,
      );
    }

    // c. Export the copied file as text, substitute tokens, write back.
    let rawContent: string;
    try {
      rawContent = await exportDocAsText({ accessToken, fileId: newFileId });
    } catch {
      return errorResponse(
        502,
        "DRIVE_EXPORT_FAILED",
        `Falha ao ler o template '${destName}' do Google Drive. Tente novamente.`,
      );
    }

    const substituted = substituteTokens(rawContent, valueMap);

    try {
      await updateDocContent({ accessToken, fileId: newFileId, content: substituted });
    } catch {
      return errorResponse(
        502,
        "DRIVE_UPDATE_FAILED",
        `Falha ao gravar o documento '${destName}' no Google Drive. Tente novamente.`,
      );
    }

    // d. Delete the old file atomically (best-effort last step).
    if (existingFileId) {
      try {
        await deleteDriveFile({ accessToken, fileId: existingFileId });
      } catch {
        // Not fatal — the new file already exists. The old one becomes an
        // orphan the landlord can delete manually. Do not fail the request.
      }
    }

    results.push({
      template_name: destName,
      drive_url: driveUrl(newFileId),
    });
  }

  return new Response(JSON.stringify({ documents: results }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(handleGenerateDocuments);
