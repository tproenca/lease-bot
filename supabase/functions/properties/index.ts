// GET /properties + POST /properties
//
// GET  — returns all properties for the authenticated landlord.
// POST — creates a new property:
//   1. Validates inputs: type (apartment|house|commercial), name required.
//      address required for house/commercial; NOT required for apartment
//      (the apartment's building already has an address).
//      building_id required when type=apartment.
//   2. If type=apartment, verifies building_id belongs to this landlord.
//   3. Creates a Drive folder:
//      - apartment  → Root/{BuildingName}/{PropertyName}/
//      - house      → Root/{PropertyName}/
//      - commercial → Root/{PropertyName}/
//   4. Inserts a properties row and returns 201 { id, drive_folder_id }.
//      For apartments, address is stored as NULL in the DB.
//
// Auth: Bearer JWT verified via Supabase Auth — returns 401 if missing/invalid.
// Uses userClient(jwt) for all DB reads and writes — RLS enforces landlord
// isolation on every query automatically.

import { corsHeaders } from "../_shared/cors.ts";
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
} from "../_shared/google.ts";
import { isNonEmptyString } from "../_shared/validation.ts";

const VALID_PROPERTY_TYPES = ["apartment", "house", "commercial"] as const;
type PropertyType = typeof VALID_PROPERTY_TYPES[number];

function isValidPropertyType(v: unknown): v is PropertyType {
  return typeof v === "string" &&
    (VALID_PROPERTY_TYPES as readonly string[]).includes(v);
}

export async function handleProperties(req: Request): Promise<Response> {
  // Handle CORS preflight.
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method === "GET") {
    return handleGetProperties(req);
  }

  if (req.method === "POST") {
    return handleCreateProperty(req);
  }

  return errorResponse(405, "METHOD_NOT_ALLOWED", "Método não permitido.");
}

async function handleGetProperties(req: Request): Promise<Response> {
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

  // 2. Fetch all properties via user client (RLS enforces landlord isolation).
  const db = userClient(jwt);
  const { data, error } = await db
    .from("properties")
    .select("id, type, name, address, building_id, current_tenant_folder_id")
    .order("name");

  if (error) {
    return errorResponse(
      500,
      "DB_ERROR",
      "Erro ao carregar imóveis. Tente novamente.",
    );
  }

  return new Response(JSON.stringify(data ?? []), {
    status: 200,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

async function handleCreateProperty(req: Request): Promise<Response> {
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
    type,
    building_id,
    name,
    address,
  } = (body ?? {}) as Record<string, unknown>;

  if (!isValidPropertyType(type)) {
    return errorResponse(
      400,
      "MISSING_TYPE",
      "O campo 'type' é obrigatório e deve ser apartment, house ou commercial.",
    );
  }

  if (!isNonEmptyString(name)) {
    return errorResponse(
      400,
      "MISSING_NAME",
      "O campo 'name' é obrigatório.",
    );
  }

  // address is required for house and commercial, but not for apartments
  // (their building already has an address stored in the buildings table).
  if (type !== "apartment" && !isNonEmptyString(address)) {
    return errorResponse(
      400,
      "MISSING_ADDRESS",
      "O campo 'address' é obrigatório.",
    );
  }

  // apartment requires building_id
  if (type === "apartment" && !isNonEmptyString(building_id)) {
    return errorResponse(
      400,
      "MISSING_BUILDING_ID",
      "O campo 'building_id' é obrigatório para imóveis do tipo apartment.",
    );
  }

  // 3. Load landlord credentials via userClient — RLS (id = auth.uid()) scopes
  //    the SELECT to the authenticated landlord's own row only.
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

  // 4. For apartments: verify the building exists and belongs to this landlord.
  //    RLS on buildings (landlord_id = auth.uid()) automatically prevents
  //    accessing another landlord's buildings.
  let buildingFolderId: string | null = null;

  if (type === "apartment") {
    const { data: building, error: buildingError } = await db
      .from("buildings")
      .select("id, drive_folder_id")
      .eq("id", building_id as string)
      .maybeSingle();

    if (buildingError || !building) {
      return errorResponse(
        404,
        "BUILDING_NOT_FOUND",
        "Edifício não encontrado.",
      );
    }

    buildingFolderId = (building as Record<string, unknown>)
      .drive_folder_id as string;
  }

  // 5. Obtain a fresh Google access token.
  let accessToken: string;
  try {
    accessToken = await refreshGoogleAccessToken(
      landlord.google_refresh_token as string,
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

  // 6. Create the Drive folder in the appropriate parent.
  //    - apartment  → inside building folder (Root/{BuildingName}/{PropertyName}/)
  //    - house/commercial → under root       (Root/{PropertyName}/)
  const parentFolderId = type === "apartment"
    ? buildingFolderId!
    : (landlord.root_folder_id as string);

  let driveFolderId: string;
  try {
    driveFolderId = await createDriveFolder({
      accessToken,
      name: name as string,
      parentFolderId,
    });
  } catch {
    return errorResponse(
      502,
      "DRIVE_CREATE_FOLDER_FAILED",
      "Falha ao criar pasta no Google Drive. Tente novamente.",
    );
  }

  // 7. Insert the properties row using userClient (RLS enforced).
  //    Apartments store address as NULL — their building already has an address.
  const { data: property, error: insertError } = await db
    .from("properties")
    .insert({
      landlord_id: user.id,
      type: type as string,
      building_id: type === "apartment" ? (building_id as string) : null,
      name: name as string,
      address: type === "apartment" ? null : (address as string),
      drive_folder_id: driveFolderId,
    })
    .select("id, drive_folder_id")
    .single();

  if (insertError || !property) {
    return errorResponse(
      500,
      "DB_ERROR",
      "Erro ao salvar o imóvel. Tente novamente.",
    );
  }

  return new Response(
    JSON.stringify({
      id: (property as Record<string, unknown>).id,
      drive_folder_id: (property as Record<string, unknown>).drive_folder_id,
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

if (import.meta.main) Deno.serve(handleProperties);
