// POST /buildings
//
// Creates a new building for the authenticated landlord:
//   1. Validates inputs (name, address — both required non-empty strings).
//   2. Loads the landlord's Google refresh token and root folder ID from DB.
//   3. Creates a Drive subfolder under Root/{BuildingName}/.
//   4. Inserts a buildings row with the new drive_folder_id.
//   5. Returns 201 { id, drive_folder_id }.
//
// Auth: Bearer JWT verified via Supabase Auth — returns 401 if missing or
//       invalid. Uses userClient(jwt) so RLS enforces landlord isolation.
// Drive: uses the landlord's stored Google OAuth refresh token.
// Returns 400 for missing required fields.

import { corsHeaders } from "../_shared/cors.ts";
import { errorResponse } from "../_shared/errors.ts";
import {
  extractBearer,
  getAuthenticatedUser,
  userClient,
} from "../_shared/supabase.ts";
import {
  createDriveFolder,
  refreshGoogleAccessToken,
} from "../_shared/google.ts";
import { isNonEmptyString } from "../_shared/validation.ts";

export async function handleBuildings(req: Request): Promise<Response> {
  // Handle CORS preflight.
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Only POST is accepted.
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

  const { name, address } = (body ?? {}) as Record<string, unknown>;

  if (!isNonEmptyString(name)) {
    return errorResponse(
      400,
      "MISSING_NAME",
      "O campo 'name' é obrigatório.",
    );
  }

  if (!isNonEmptyString(address)) {
    return errorResponse(
      400,
      "MISSING_ADDRESS",
      "O campo 'address' é obrigatório.",
    );
  }

  // 3. Load the landlord's Google refresh token and root folder ID.
  //    Use userClient so RLS applies — the landlord policy (id = auth.uid())
  //    scopes this SELECT to the authenticated landlord's own row only.
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

  // 4. Obtain a fresh Google access token.
  let accessToken: string;
  try {
    accessToken = await refreshGoogleAccessToken(
      landlord.google_refresh_token as string,
    );
  } catch {
    return errorResponse(
      502,
      "GOOGLE_AUTH_FAILED",
      "Falha ao autenticar com o Google Drive. Tente novamente.",
    );
  }

  // 5. Create the Drive folder under Root/{BuildingName}/.
  let driveFolderId: string;
  try {
    driveFolderId = await createDriveFolder({
      accessToken,
      name: name as string,
      parentFolderId: landlord.root_folder_id as string,
    });
  } catch {
    return errorResponse(
      502,
      "DRIVE_CREATE_FOLDER_FAILED",
      "Falha ao criar pasta no Google Drive. Tente novamente.",
    );
  }

  // 6. Insert the buildings row (reuse the same userClient instance).
  const { data: building, error: insertError } = await db
    .from("buildings")
    .insert({
      landlord_id: user.id,
      name: name as string,
      address: address as string,
      drive_folder_id: driveFolderId,
    })
    .select("id, drive_folder_id")
    .single();

  if (insertError || !building) {
    return errorResponse(
      500,
      "DB_ERROR",
      "Erro ao salvar o edifício. Tente novamente.",
    );
  }

  return new Response(
    JSON.stringify({
      id: (building as Record<string, unknown>).id,
      drive_folder_id: (building as Record<string, unknown>).drive_folder_id,
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

Deno.serve(handleBuildings);
