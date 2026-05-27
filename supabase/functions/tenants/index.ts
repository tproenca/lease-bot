// POST /tenants — creates a new tenant folder in Drive, stars it, unstars the
//   previous tenant folder if one exists, inserts the tenant row, and updates
//   properties.current_tenant_folder_id atomically.
//
// GET /tenants/:id — returns tenant data; 404 if not found or belongs to
//   another landlord.
//
// PATCH /tenants/:id — updates `whatsapp` only; ignores other fields.
//
// Auth: Bearer JWT verified via Supabase Auth — returns 401 if missing/invalid.
// Uses userClient(jwt) for all DB ops — RLS enforces landlord isolation.
// Drive: uses the landlord's stored Google OAuth refresh token.
//
// Atomicity contract: Drive operations (star/unstar) and DB writes are ordered
// so that a failure at any step leaves the system consistent:
//   1. Create Drive folder (pure creation — always safe to retry)
//   2. Star new folder
//   3. Insert tenant row
//   4. Update properties.current_tenant_folder_id
//   5. Unstar previous folder (best-effort last — not critical)
// If steps 3–4 fail after Drive operations have already run, the Drive folder
// is orphaned but DB state remains unchanged (no partial update). The landlord
// can re-run POST /tenants; createDriveFolder is idempotent for duplicate names.

import { corsHeaders as baseCorsHeaders } from "../_shared/cors.ts";
import { errorResponse } from "../_shared/errors.ts";
import {
  extractBearer,
  getAuthenticatedUser,
  userClient,
} from "../_shared/supabase.ts";
import {
  createDriveFolder,
  GoogleReauthRequiredError,
  refreshGoogleAccessToken,
  starDriveFile,
  unstarDriveFile,
} from "../_shared/google.ts";
import {
  isNonEmptyString,
  normalizeBrazilianWhatsapp,
} from "../_shared/validation.ts";

// Extend CORS headers to also allow PATCH (needed for PATCH /tenants/:id).
const corsHeaders: Record<string, string> = {
  ...baseCorsHeaders,
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
};

// CPF format: XXX.XXX.XXX-XX
const CPF_RE = /^\d{3}\.\d{3}\.\d{3}-\d{2}$/;

function isValidCpf(v: unknown): v is string {
  return typeof v === "string" && CPF_RE.test(v.trim());
}

export async function handleTenants(req: Request): Promise<Response> {
  // Handle CORS preflight.
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(req.url);
  // Extract :id from path suffix (/tenants/:id)
  const pathParts = url.pathname.replace(/^\/+/, "").split("/");
  // pathParts may be ["tenants", ":id"] or ["tenants"] depending on deployment
  // We look for a UUID segment after the last meaningful part.
  const tenantId = pathParts.length >= 2
    ? pathParts[pathParts.length - 1]
    : null;
  const hasId = tenantId != null && tenantId !== "" && tenantId !== "tenants";

  if (req.method === "POST" && !hasId) {
    return handleCreateTenant(req);
  }

  if (req.method === "GET" && hasId) {
    return handleGetTenant(req, tenantId);
  }

  if (req.method === "PATCH" && hasId) {
    return handleUpdateTenant(req, tenantId);
  }

  return errorResponse(405, "METHOD_NOT_ALLOWED", "Método não permitido.");
}

// ─── POST /tenants ─────────────────────────────────────────────────────────

async function handleCreateTenant(req: Request): Promise<Response> {
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

  const {
    property_id,
    name,
    cpf,
    whatsapp,
  } = (body ?? {}) as Record<string, unknown>;

  if (!isNonEmptyString(property_id)) {
    return errorResponse(
      400,
      "MISSING_PROPERTY_ID",
      "O campo 'property_id' é obrigatório.",
    );
  }

  if (!isNonEmptyString(name)) {
    return errorResponse(400, "MISSING_NAME", "O campo 'name' é obrigatório.");
  }

  if (!isValidCpf(cpf)) {
    return errorResponse(
      400,
      "INVALID_CPF",
      "O campo 'cpf' é obrigatório e deve estar no formato XXX.XXX.XXX-XX.",
    );
  }

  // whatsapp is optional but must be valid Brazilian E.164 if provided.
  let normalizedWhatsapp: string | null = null;
  if (whatsapp !== undefined && whatsapp !== null) {
    normalizedWhatsapp = normalizeBrazilianWhatsapp(whatsapp);
    if (normalizedWhatsapp === null) {
      return errorResponse(
        400,
        "INVALID_WHATSAPP",
        "O campo 'whatsapp' deve ser um número brasileiro no formato E.164 (+55...).",
      );
    }
  }

  // 3. Load landlord credentials.
  const db = userClient(jwt);
  const { data: landlord, error: landlordError } = await db
    .from("landlords")
    .select("google_refresh_token, root_folder_id")
    .eq("id", user.id)
    .maybeSingle();

  if (landlordError || !landlord) {
    return errorResponse(
      404,
      "LANDLORD_NOT_FOUND",
      "Cadastro do proprietário não encontrado. Conclua o processo de configuração.",
    );
  }

  // 4. Load the property (RLS ensures it belongs to this landlord).
  const { data: property, error: propertyError } = await db
    .from("properties")
    .select("id, type, building_id, drive_folder_id, current_tenant_folder_id")
    .eq("id", property_id as string)
    .maybeSingle();

  if (propertyError || !property) {
    return errorResponse(
      404,
      "PROPERTY_NOT_FOUND",
      "Imóvel não encontrado.",
    );
  }

  const prop = property as {
    id: string;
    type: string;
    building_id: string | null;
    drive_folder_id: string;
    current_tenant_folder_id: string | null;
  };

  // 5. Obtain a fresh Google access token.
  let accessToken: string;
  try {
    accessToken = await refreshGoogleAccessToken(
      (landlord as Record<string, unknown>).google_refresh_token as string,
    );
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

  // 6. Create the tenant Drive folder inside the property's Drive folder.
  //    Folder location:
  //      apartment  → Root/{Building}/{Property}/{TenantName}/
  //      house/commercial → Root/{Property}/{TenantName}/
  //    In practice this means the parent is always property.drive_folder_id,
  //    regardless of property type — the properties endpoint already handles
  //    placing the property folder in the right place.
  let driveFolderId: string;
  try {
    driveFolderId = await createDriveFolder({
      accessToken,
      name: name as string,
      parentFolderId: prop.drive_folder_id,
    });
  } catch {
    return errorResponse(
      502,
      "DRIVE_CREATE_FOLDER_FAILED",
      "Falha ao criar pasta no Google Drive. Tente novamente.",
    );
  }

  // 7. Star the new tenant folder.
  try {
    await starDriveFile({ accessToken, fileId: driveFolderId });
  } catch {
    return errorResponse(
      502,
      "DRIVE_STAR_FAILED",
      "Falha ao destacar pasta do inquilino no Google Drive. Tente novamente.",
    );
  }

  // 8. Insert tenant row.
  const { data: tenant, error: insertError } = await db
    .from("tenants")
    .insert({
      landlord_id: user.id,
      property_id: property_id as string,
      name: name as string,
      cpf: (cpf as string).trim(),
      whatsapp: normalizedWhatsapp,
      drive_folder_id: driveFolderId,
    })
    .select("id, drive_folder_id")
    .single();

  if (insertError || !tenant) {
    return errorResponse(
      500,
      "DB_ERROR",
      "Erro ao salvar o inquilino. Tente novamente.",
    );
  }

  // 9. Update properties.current_tenant_folder_id.
  //    If this fails, roll back by deleting the just-inserted tenant row so
  //    DB state remains consistent (no orphaned tenant without a linked property).
  const { error: updateError } = await db
    .from("properties")
    .update({ current_tenant_folder_id: driveFolderId })
    .eq("id", property_id as string);

  if (updateError) {
    // Best-effort rollback of the tenant insert.
    await db
      .from("tenants")
      .delete()
      .eq("id", (tenant as Record<string, unknown>).id as string);

    return errorResponse(
      500,
      "DB_ERROR",
      "Erro ao atualizar o imóvel com a pasta do inquilino. Tente novamente.",
    );
  }

  // 10. Unstar previous tenant folder if one existed (best-effort).
  //     This runs last: a failure here does not affect the DB state or the
  //     new tenant's folder. Errors are swallowed intentionally.
  if (prop.current_tenant_folder_id) {
    try {
      await unstarDriveFile({
        accessToken,
        fileId: prop.current_tenant_folder_id,
      });
    } catch {
      // Swallow — unstar is cosmetic; archived tenant folder remains accessible.
    }
  }

  return new Response(
    JSON.stringify({
      id: (tenant as Record<string, unknown>).id,
      drive_folder_id: (tenant as Record<string, unknown>).drive_folder_id,
    }),
    {
      status: 201,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    },
  );
}

// ─── GET /tenants/:id ──────────────────────────────────────────────────────

async function handleGetTenant(
  req: Request,
  tenantId: string,
): Promise<Response> {
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

  // 2. Fetch tenant — RLS (landlord_id = auth.uid()) enforces ownership.
  const db = userClient(jwt);
  const { data: tenant, error } = await db
    .from("tenants")
    .select("id, name, cpf, whatsapp, property_id, drive_folder_id, created_at")
    .eq("id", tenantId)
    .maybeSingle();

  if (error || !tenant) {
    return errorResponse(
      404,
      "TENANT_NOT_FOUND",
      "Inquilino não encontrado.",
    );
  }

  return new Response(JSON.stringify(tenant), {
    status: 200,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

// ─── PATCH /tenants/:id ────────────────────────────────────────────────────

async function handleUpdateTenant(
  req: Request,
  tenantId: string,
): Promise<Response> {
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

  // 2. Parse request body.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, "INVALID_JSON", "Corpo da requisição inválido.");
  }

  const { whatsapp } = (body ?? {}) as Record<string, unknown>;

  // 3. Validate whatsapp if provided.
  let normalizedWhatsapp: string | null | undefined;
  if (whatsapp !== undefined) {
    if (whatsapp === null) {
      normalizedWhatsapp = null;
    } else {
      normalizedWhatsapp = normalizeBrazilianWhatsapp(whatsapp);
      if (normalizedWhatsapp === null) {
        return errorResponse(
          400,
          "INVALID_WHATSAPP",
          "O campo 'whatsapp' deve ser um número brasileiro no formato E.164 (+55...).",
        );
      }
    }
  }

  // If no updatable field was sent, return 400.
  if (whatsapp === undefined) {
    return errorResponse(
      400,
      "MISSING_FIELDS",
      "Nenhum campo atualizável fornecido. Envie 'whatsapp'.",
    );
  }

  // 4. Verify the tenant exists and belongs to this landlord (RLS enforces).
  const db = userClient(jwt);
  const { data: existing, error: fetchError } = await db
    .from("tenants")
    .select("id")
    .eq("id", tenantId)
    .maybeSingle();

  if (fetchError || !existing) {
    return errorResponse(
      404,
      "TENANT_NOT_FOUND",
      "Inquilino não encontrado.",
    );
  }

  // 5. Update only whatsapp — ignore all other fields per spec.
  const { error: updateError } = await db
    .from("tenants")
    .update({ whatsapp: normalizedWhatsapp ?? null })
    .eq("id", tenantId);

  if (updateError) {
    return errorResponse(
      500,
      "DB_ERROR",
      "Erro ao atualizar o inquilino. Tente novamente.",
    );
  }

  return new Response(JSON.stringify({ id: tenantId }), {
    status: 200,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

if (import.meta.main) Deno.serve(handleTenants);
