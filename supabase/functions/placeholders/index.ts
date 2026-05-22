// POST /placeholders — adds a placeholder definition for this landlord.
// DELETE /placeholders/:name — removes a placeholder definition (idempotent).
//
// After any successful insert or delete, regenerates the "Guia de Placeholders"
// Google Doc in the landlord's Templates Drive folder.
//
// Auth: Bearer JWT verified via Supabase Auth — returns 401 if missing/invalid.
// Uses userClient(jwt) for all DB ops — RLS enforces landlord isolation.

import { corsHeaders as baseCorsHeaders } from "../_shared/cors.ts";
import { errorResponse } from "../_shared/errors.ts";
import {
  extractBearer,
  getAuthenticatedUser,
  userClient,
} from "../_shared/supabase.ts";
import {
  refreshGoogleAccessToken,
  upsertPlaceholderList,
} from "../_shared/google.ts";

// Allow DELETE in addition to the default methods.
const corsHeaders: Record<string, string> = {
  ...baseCorsHeaders,
  "Access-Control-Allow-Methods": "POST, DELETE, OPTIONS",
};

const VALID_FORMATS = new Set(["text", "date", "cpf", "integer", "currency"]);

export async function handlePlaceholders(req: Request): Promise<Response> {
  // Handle CORS preflight.
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const pathParts = url.pathname.replace(/^\/+/, "").split("/").filter(Boolean);
  const lastPart = pathParts[pathParts.length - 1];
  const hasName = lastPart !== "placeholders" && lastPart !== "" &&
    pathParts.length >= 2;

  if (req.method === "POST") {
    return handleCreatePlaceholder(req);
  }

  if (req.method === "DELETE" && hasName) {
    return handleDeletePlaceholder(req, lastPart);
  }

  return errorResponse(405, "METHOD_NOT_ALLOWED", "Método não permitido.");
}

// ─── POST /placeholders ─────────────────────────────────────────────────────

async function handleCreatePlaceholder(req: Request): Promise<Response> {
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

  // 2. Parse body — always an array.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, "INVALID_JSON", "Corpo da requisição inválido.");
  }

  if (!Array.isArray(body) || body.length === 0) {
    return errorResponse(
      400,
      "INVALID_REQUEST",
      "Envie um array com pelo menos um placeholder.",
    );
  }

  // 3. Validate each item and build rows.
  const rows: Array<{
    landlord_id: string;
    name: string;
    required: boolean;
    format: string;
    case: string | null;
    default: string | null;
    derived_from: string | null;
    derived_formula: string | null;
  }> = [];

  for (const item of body) {
    const {
      name,
      required,
      format,
      case: caseField,
      default: defaultField,
      derived_from,
      derived_formula,
    } = (item ?? {}) as Record<string, unknown>;

    if (typeof name !== "string" || name.trim() === "") {
      return errorResponse(
        400,
        "INVALID_REQUEST",
        "O campo 'name' é obrigatório em todos os placeholders.",
      );
    }
    if (!VALID_FORMATS.has(format as string)) {
      return errorResponse(
        400,
        "INVALID_FORMAT",
        `Formato inválido: '${
          String(format)
        }'. Use text, date, cpf, integer ou currency.`,
      );
    }

    rows.push({
      landlord_id: user.id,
      name: name.trim(),
      required: required === true || required === undefined
        ? true
        : Boolean(required),
      format: format as string,
      case: (caseField ?? null) as string | null,
      default: (defaultField ?? null) as string | null,
      derived_from: (derived_from ?? null) as string | null,
      derived_formula: (derived_formula ?? null) as string | null,
    });
  }

  // 4. Bulk insert.
  const db = userClient(jwt);
  const { data: inserted, error: insertError } = await db
    .from("placeholders")
    .insert(rows)
    .select("id");

  if (insertError) {
    if (
      (insertError as unknown as Record<string, unknown>).code === "23505"
    ) {
      return errorResponse(
        409,
        "DUPLICATE_PLACEHOLDER",
        "Um ou mais placeholders já existem com esse nome.",
      );
    }
    return errorResponse(
      500,
      "DB_ERROR",
      "Erro ao salvar os placeholders. Tente novamente.",
    );
  }
  if (!inserted) {
    return errorResponse(
      500,
      "DB_ERROR",
      "Erro ao salvar os placeholders. Tente novamente.",
    );
  }

  const ids = (inserted as Array<{ id: string }>).map((r) => r.id);

  // 5. Create Lista if absent (best-effort).
  await regeneratePlaceholderList(db, user.id);

  return new Response(JSON.stringify({ ids }), {
    status: 201,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─── DELETE /placeholders/:name ─────────────────────────────────────────────

async function handleDeletePlaceholder(
  req: Request,
  encodedName: string,
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

  const name = decodeURIComponent(encodedName);

  const db = userClient(jwt);

  // 2. Delete (RLS scopes to this landlord; idempotent — 204 even if not found).
  const { error: deleteError } = await db
    .from("placeholders")
    .delete()
    .eq("name", name);

  if (deleteError) {
    return errorResponse(
      500,
      "DB_ERROR",
      "Erro ao remover o placeholder. Tente novamente.",
    );
  }

  // 3. Regenerate Lista (best-effort).
  await regeneratePlaceholderList(db, user.id);

  return new Response(null, {
    status: 204,
    headers: corsHeaders,
  });
}

// ─── Lista regeneration helper ───────────────────────────────────────────────

async function regeneratePlaceholderList(
  // deno-lint-ignore no-explicit-any
  db: any,
  userId: string,
): Promise<void> {
  try {
    const { data: landlord } = await db
      .from("landlords")
      .select("google_refresh_token, templates_folder_id")
      .eq("id", userId)
      .maybeSingle();

    if (!landlord) return;

    const accessToken = await refreshGoogleAccessToken(
      (landlord as Record<string, unknown>).google_refresh_token as string,
    );

    const { data: placeholders } = await db
      .from("placeholders")
      .select(
        "name, required, format, case, default, derived_from, derived_formula",
      )
      .order("name");

    await upsertPlaceholderList({
      accessToken,
      templatesFolderId: (landlord as Record<string, unknown>)
        .templates_folder_id as string,
      placeholders: (placeholders ?? []) as Array<{
        name: string;
        required: boolean;
        format: string;
        case?: string | null;
        default?: string | null;
        derived_from?: string | null;
        derived_formula?: string | null;
      }>,
    });
  } catch {
    // Best-effort: Lista regeneration failure does not fail the API response.
  }
}

if (import.meta.main) Deno.serve(handlePlaceholders);
