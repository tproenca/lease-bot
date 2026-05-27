// POST /signatures/send — export tenant documents to PDF, detect signature
// positions, submit to Autentique, and record the signing request.
//
// Auth: Bearer JWT verified via Supabase Auth — returns 401 if missing/invalid.
// Uses userClient(jwt) for all DB ops — RLS enforces landlord isolation.
// Drive: uses the landlord's stored Google OAuth refresh token.
//
// Steps:
//   1. Validate JWT and extract landlord_id
//   2. Parse and validate body: { tenant_id: uuid }
//   3. Load tenant record (RLS-scoped to landlord)
//   4. Load landlord record (autentique_api_key, whatsapp, google_refresh_token)
//   5. Load witnesses for this landlord
//   6. List Google Doc files in the tenant's Drive folder
//   7. exportAndMergePdfs() → merged PDF bytes
//   8. detectSignaturePositions() → per-signer (x, y, page)
//   9. If detection fails → 422 with structured error
//  10. Submit to Autentique (retry up to 3× with exponential backoff)
//      → on final failure → 502 with drive_urls so landlord can retry
//  11. Insert row into signature_requests
//  12. Return 201 { id, autentique_document_id }
//
// Security: tenant_id validated as UUID before any DB query; autentique_api_key
// read from DB, never from request body; no hardcoded secrets.

import { corsHeaders } from "../../_shared/cors.ts";
import { errorResponse } from "../../_shared/errors.ts";
import {
  extractBearer,
  getAuthenticatedUser,
  userClient,
} from "../../_shared/supabase.ts";
import {
  GoogleReauthRequiredError,
  listDriveFilesInFolder,
  refreshGoogleAccessToken,
} from "../../_shared/google.ts";
import { submitDocument } from "../../_shared/autentique.ts";
import type { AutentiqueSigner } from "../../_shared/autentique.ts";
import { exportAndMergePdfs } from "../../documents/export/index.ts";
import { detectSignaturePositions } from "../../documents/signatures/detect.ts";

// ─── UUID validation ──────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

// ─── Autentique retry ─────────────────────────────────────────────────────

const AUTENTIQUE_MAX_ATTEMPTS = 3;

async function submitWithRetry(
  apiKey: string,
  params: Parameters<typeof submitDocument>[1],
): Promise<{ documentId: string }> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < AUTENTIQUE_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
    }
    try {
      return await submitDocument(apiKey, params);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastError ?? new Error("autentique_submission_failed");
}

// ─── Role to signer mapping ───────────────────────────────────────────────

/**
 * Map a detect role token to the matching signer from the DB records.
 * Returns null when the role cannot be satisfied by available signers
 * (which is unexpected — detection only returns roles present in the PDF).
 */
function resolveSignerForRole(
  role: string,
  tenant: { name: string; whatsapp: string | null },
  landlord: { name: string; whatsapp: string },
  witnesses: Array<{ name: string; whatsapp: string }>,
): { name: string; whatsapp: string } | null {
  switch (role) {
    case "LOCATARIO":
      if (!tenant.whatsapp) return null;
      return { name: tenant.name, whatsapp: tenant.whatsapp };
    case "LOCADOR":
      return { name: landlord.name, whatsapp: landlord.whatsapp };
    case "TESTEMUNHA_1":
      return witnesses[0] ?? null;
    case "TESTEMUNHA_2":
      return witnesses[1] ?? null;
    default:
      return null;
  }
}

// ─── Handler ──────────────────────────────────────────────────────────────

export async function handleSend(req: Request): Promise<Response> {
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

  // 2. Parse and validate body.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, "INVALID_JSON", "Corpo da requisição inválido.");
  }

  const { tenant_id } = (body ?? {}) as Record<string, unknown>;

  if (!isUuid(tenant_id)) {
    return errorResponse(
      400,
      "INVALID_TENANT_ID",
      "O campo 'tenant_id' é obrigatório e deve ser um UUID válido.",
    );
  }

  const db = userClient(jwt);

  // 3. Load tenant record (RLS ensures belongs to this landlord).
  const { data: tenant, error: tenantError } = await db
    .from("tenants")
    .select("id, name, whatsapp, drive_folder_id, landlord_id, property_id")
    .eq("id", tenant_id)
    .maybeSingle();

  if (tenantError || !tenant) {
    return errorResponse(404, "TENANT_NOT_FOUND", "Inquilino não encontrado.");
  }

  const ten = tenant as {
    id: string;
    name: string;
    whatsapp: string | null;
    drive_folder_id: string;
    landlord_id: string;
    property_id: string;
  };

  // 4. Load landlord record.
  const { data: landlord, error: landlordError } = await db
    .from("landlords")
    .select("id, name, whatsapp, autentique_api_key, google_refresh_token")
    .eq("id", user.id)
    .maybeSingle();

  if (landlordError || !landlord) {
    return errorResponse(
      404,
      "LANDLORD_NOT_FOUND",
      "Cadastro do proprietário não encontrado. Conclua o processo de configuração.",
    );
  }

  const land = landlord as {
    id: string;
    name: string;
    whatsapp: string;
    autentique_api_key: string;
    google_refresh_token: string;
  };

  // 5. Load witnesses for this landlord.
  const { data: witnessRows, error: witnessError } = await db
    .from("witnesses")
    .select("name, whatsapp")
    .eq("landlord_id", user.id)
    .order("name", { ascending: true });

  if (witnessError) {
    return errorResponse(
      500,
      "DB_ERROR",
      "Erro ao carregar as testemunhas. Tente novamente.",
    );
  }

  const witnesses = (witnessRows ?? []) as Array<{
    name: string;
    whatsapp: string;
  }>;

  // 6. List Google Doc files in the tenant's Drive folder.
  let accessToken: string;
  try {
    accessToken = await refreshGoogleAccessToken(land.google_refresh_token);
  } catch (err) {
    if (err instanceof GoogleReauthRequiredError) {
      return errorResponse(
        401,
        "GOOGLE_REAUTH_REQUIRED",
        "Sua conexão com o Google Drive expirou. Reconecte sua conta para continuar.",
      );
    }
    return errorResponse(
      502,
      "GOOGLE_AUTH_FAILED",
      "Falha ao autenticar com o Google Drive. Tente novamente.",
    );
  }

  let driveFiles: Array<{ id: string; name: string; modifiedTime: string }>;
  try {
    driveFiles = await listDriveFilesInFolder({
      accessToken,
      folderId: ten.drive_folder_id,
    });
  } catch {
    return errorResponse(
      502,
      "DRIVE_LIST_FAILED",
      "Falha ao listar os documentos no Google Drive. Tente novamente.",
    );
  }

  if (driveFiles.length === 0) {
    return errorResponse(
      422,
      "NO_DOCUMENTS_FOUND",
      "Nenhum documento encontrado na pasta do inquilino. Gere os documentos antes de enviar para assinatura.",
    );
  }

  // Build drive URLs for the 502 fallback error (before export attempt).
  const driveUrls = driveFiles.map(
    (f) => `https://docs.google.com/document/d/${f.id}/edit`,
  );

  // 7. Export and merge PDFs.
  const exportResult = await exportAndMergePdfs({
    refreshToken: land.google_refresh_token,
    docs: driveFiles.map((f) => ({ fileId: f.id, label: f.name })),
  });

  if (!exportResult.ok) {
    return errorResponse(
      502,
      "PDF_EXPORT_FAILED",
      `Falha ao exportar o documento '${exportResult.driveUrl}'. Tente novamente ou acesse o link manualmente.`,
    );
  }

  // 8. Detect signature positions.
  const detectResult = await detectSignaturePositions(exportResult.pdf);

  if (!detectResult.ok) {
    return errorResponse(
      422,
      "SIGNATURE_MARKERS_NOT_FOUND",
      `Marcadores de assinatura não encontrados no PDF (${detectResult.error}). Verifique se os marcadores [[LOCADOR]] e [[LOCATARIO]] estão presentes nos documentos.`,
    );
  }

  // 9. Validate tenant has a WhatsApp number (required for signing delivery).
  if (!ten.whatsapp) {
    return errorResponse(
      422,
      "TENANT_WHATSAPP_MISSING",
      "O inquilino não possui número de WhatsApp cadastrado. Atualize o cadastro antes de enviar para assinatura.",
    );
  }

  // 10. Build signers list from detected positions.
  const pdfBase64 = btoa(
    String.fromCharCode(...exportResult.pdf),
  );

  const signers: AutentiqueSigner[] = [];
  for (const pos of detectResult.positions) {
    const resolved = resolveSignerForRole(
      pos.role,
      ten,
      land,
      witnesses,
    );
    if (!resolved) {
      // Skip positions for which we have no signer data (e.g. TESTEMUNHA_2 but
      // only 1 witness registered). Do not fail — partial witness coverage is
      // acceptable per the spec.
      continue;
    }
    signers.push({
      name: resolved.name,
      whatsapp: resolved.whatsapp,
      role: pos.role,
      x: pos.x,
      y: pos.y,
      page: pos.page,
    });
  }

  if (signers.length === 0) {
    return errorResponse(
      422,
      "NO_SIGNERS_RESOLVED",
      "Nenhum assinante pôde ser associado aos marcadores encontrados no PDF.",
    );
  }

  // 11. Submit to Autentique with retry.
  let autentiqueDocumentId: string;
  try {
    const result = await submitWithRetry(land.autentique_api_key, {
      pdfBase64,
      signers,
      reminderFrequency: "WEEKLY",
    });
    autentiqueDocumentId = result.documentId;
  } catch {
    return new Response(
      JSON.stringify({
        error: {
          code: "AUTENTIQUE_SUBMISSION_FAILED",
          message:
            "Falha ao enviar para o Autentique após 3 tentativas. Tente novamente ou acesse os documentos diretamente.",
          drive_urls: driveUrls,
        },
      }),
      {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  // 12. Insert row into signature_requests.
  const { data: sigRequest, error: insertError } = await db
    .from("signature_requests")
    .insert({
      landlord_id: user.id,
      tenant_id: ten.id,
      autentique_document_id: autentiqueDocumentId,
      status: "pending",
    })
    .select("id")
    .single();

  if (insertError || !sigRequest) {
    return errorResponse(
      500,
      "DB_ERROR",
      "Documento enviado ao Autentique, mas falhou ao registrar a solicitação. Verifique o status manualmente.",
    );
  }

  return new Response(
    JSON.stringify({
      id: (sigRequest as Record<string, unknown>).id,
      autentique_document_id: autentiqueDocumentId,
    }),
    {
      status: 201,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
}

if (import.meta.main) Deno.serve(handleSend);
