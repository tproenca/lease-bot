// POST /setup/complete
//
// Routed from `supabase/functions/setup/index.ts` when the request path ends
// in `/setup/complete`. Kept in its own file per the issue 1.2 spec.
//
// Steps:
//   1. Verify JWT (from Authorization header or session cookie).
//   2. Validate request body shape and field formats.
//   3. Validate the Autentique API key against the real Autentique GraphQL API.
//   4. Refresh the landlord's Google access token from their stored refresh
//      token (set during /auth/callback in auth user metadata).
//   5. Verify the selected root folder exists in their Drive.
//   6. Create (or reuse) the templates folder inside the root folder.
//   7. Insert the landlord row via the service-role client.
//
// Returns: { templates_folder_id }
// Errors follow { error: { code, message } } and never echo raw input back.

import { corsHeaders } from "../../_shared/cors.ts";
import { errorResponse } from "../../_shared/errors.ts";
import {
  createDriveFolder,
  getDriveFolder,
  refreshGoogleAccessToken,
} from "../../_shared/google.ts";
import { validateAutentiqueApiKey } from "../../_shared/autentique.ts";
import {
  extractBearer,
  getAuthenticatedUser,
  serviceClient,
} from "../../_shared/supabase.ts";
import {
  looksLikeDriveId,
  normalizeBrazilianWhatsapp,
  normalizeTemplatesFolderName,
} from "../../_shared/validation.ts";
import { COOKIE_SESSION, parseCookies } from "../../_shared/cookies.ts";

interface SetupCompleteBody {
  root_folder_id?: unknown;
  templates_folder_name?: unknown;
  whatsapp?: unknown;
  autentique_api_key?: unknown;
}

export async function handleSetupComplete(req: Request): Promise<Response> {
  // 1. JWT verification — accept either Authorization: Bearer or session cookie.
  const cookies = parseCookies(req.headers.get("cookie"));
  const jwt = extractBearer(req) ?? cookies[COOKIE_SESSION];
  if (!jwt) {
    return errorResponse(
      401,
      "UNAUTHORIZED",
      "Sessão não encontrada. Faça login novamente.",
    );
  }
  const user = await getAuthenticatedUser(jwt);
  if (!user) {
    return errorResponse(
      401,
      "UNAUTHORIZED",
      "Sessão inválida. Faça login novamente.",
    );
  }

  // 2. Parse + validate body.
  let body: SetupCompleteBody;
  try {
    body = await req.json() as SetupCompleteBody;
  } catch {
    return errorResponse(400, "INVALID_JSON", "Corpo da requisição inválido.");
  }

  const rootFolderId = body.root_folder_id;
  const templatesFolderName = normalizeTemplatesFolderName(
    body.templates_folder_name,
  );
  const whatsapp = normalizeBrazilianWhatsapp(body.whatsapp);
  const apiKey = typeof body.autentique_api_key === "string"
    ? body.autentique_api_key.trim()
    : "";

  if (!looksLikeDriveId(rootFolderId)) {
    return errorResponse(
      400,
      "INVALID_ROOT_FOLDER",
      "Selecione a pasta raiz do Google Drive.",
    );
  }
  if (!templatesFolderName) {
    return errorResponse(
      400,
      "INVALID_TEMPLATES_FOLDER_NAME",
      "Nome da pasta de modelos inválido.",
    );
  }
  if (!whatsapp) {
    return errorResponse(
      400,
      "INVALID_WHATSAPP",
      "Número de WhatsApp inválido. Use o formato +55 seguido do DDD e número.",
    );
  }
  if (!apiKey) {
    return errorResponse(
      400,
      "MISSING_AUTENTIQUE_KEY",
      "Informe sua chave de API da Autentique.",
    );
  }

  // 3. Validate Autentique API key.
  const autentique = await validateAutentiqueApiKey(apiKey);
  if (!autentique.ok) {
    return errorResponse(
      400,
      "INVALID_AUTENTIQUE_KEY",
      "Chave de API da Autentique inválida. Verifique em autentique.com.br → Configurações → Tokens de API.",
    );
  }

  // 4. Refresh Google access token from stored refresh token.
  const refreshToken =
    (user.user_metadata.google_refresh_token as string | undefined) ??
      undefined;
  if (!refreshToken) {
    return errorResponse(
      400,
      "MISSING_GOOGLE_TOKEN",
      "Conexão com o Google não encontrada. Refaça o login com o Google.",
    );
  }
  let accessToken: string;
  try {
    accessToken = await refreshGoogleAccessToken(refreshToken);
  } catch {
    return errorResponse(
      502,
      "GOOGLE_TOKEN_REFRESH_FAILED",
      "Não foi possível renovar o acesso ao Google Drive. Tente novamente.",
    );
  }

  // 5. Verify root folder exists in Drive.
  let rootFolder: { id: string; name: string } | null;
  try {
    rootFolder = await getDriveFolder({
      accessToken,
      folderId: rootFolderId as string,
    });
  } catch {
    return errorResponse(
      502,
      "DRIVE_LOOKUP_FAILED",
      "Não foi possível consultar o Google Drive. Tente novamente.",
    );
  }
  if (!rootFolder) {
    return errorResponse(
      400,
      "ROOT_FOLDER_NOT_FOUND",
      "Pasta raiz não encontrada no seu Google Drive.",
    );
  }

  // 6. Create (or reuse) templates folder.
  let templatesFolderId: string;
  try {
    templatesFolderId = await createDriveFolder({
      accessToken,
      name: templatesFolderName,
      parentFolderId: rootFolderId as string,
    });
  } catch {
    return errorResponse(
      502,
      "DRIVE_CREATE_FAILED",
      "Não foi possível criar a pasta de modelos no Google Drive.",
    );
  }

  // 7. Insert landlord row. Uses service-role client to bypass RLS for the
  //    first-time insert; landlord_id is bound to user.id (auth.uid()) so the
  //    row is owned by the authenticated user from this point on.
  const svc = serviceClient();
  const { error: insertError } = await svc.from("landlords").insert({
    id: user.id,
    email: user.email,
    name: (user.user_metadata.full_name as string | undefined) ??
      (user.user_metadata.name as string | undefined) ??
      user.email,
    whatsapp,
    google_refresh_token: refreshToken,
    autentique_api_key: apiKey,
    root_folder_id: rootFolderId,
    templates_folder_id: templatesFolderId,
  });
  if (insertError) {
    // Unique violation on primary key — onboarding already complete.
    // Make the endpoint idempotent: return the existing templates_folder_id.
    if ((insertError as { code?: string }).code === "23505") {
      const { data: existing } = await svc
        .from("landlords")
        .select("templates_folder_id")
        .eq("id", user.id)
        .maybeSingle();
      if (existing) {
        return jsonResponse(200, {
          templates_folder_id: existing.templates_folder_id,
        });
      }
    }
    return errorResponse(
      500,
      "LANDLORD_INSERT_FAILED",
      "Não foi possível concluir o cadastro. Tente novamente.",
    );
  }

  return jsonResponse(200, { templates_folder_id: templatesFolderId });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
