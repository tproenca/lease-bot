// POST /templates — registers a new template and its property-type mappings.
// DELETE /templates/:id — removes a template and its property-type mappings.
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
import { handleTemplatesDiff } from "./diff/index.ts";

// Allow DELETE in addition to the default methods.
const corsHeaders: Record<string, string> = {
  ...baseCorsHeaders,
  "Access-Control-Allow-Methods": "POST, DELETE, OPTIONS",
};

const VALID_PROPERTY_TYPES = new Set(["apartment", "house", "commercial"]);

export async function handleTemplates(req: Request): Promise<Response> {
  // Handle CORS preflight.
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const pathParts = url.pathname.replace(/^\/+/, "").split("/").filter(Boolean);
  // pathParts: ["templates"] → POST, ["templates", ":id"] → DELETE
  const lastPart = pathParts[pathParts.length - 1];
  const hasId = lastPart !== "templates" && lastPart !== "" &&
    pathParts.length >= 2;

  // Delegate GET /templates/diff to the diff handler (handles both direct
  // routing and cases where Supabase routes /templates/diff to this function).
  if (req.method === "GET" && lastPart === "diff") {
    return handleTemplatesDiff(req);
  }

  if (req.method === "POST" && !hasId) {
    return handleCreateTemplate(req);
  }

  if (req.method === "DELETE" && hasId) {
    return handleDeleteTemplate(req, lastPart);
  }

  return errorResponse(405, "METHOD_NOT_ALLOWED", "Método não permitido.");
}

// ─── POST /templates ────────────────────────────────────────────────────────

async function handleCreateTemplate(req: Request): Promise<Response> {
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

  // 2. Parse body.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, "INVALID_JSON", "Corpo da requisição inválido.");
  }

  const {
    drive_file_id,
    name,
    placeholder_names,
    property_types,
    last_modified_at,
  } = (body ?? {}) as Record<string, unknown>;

  // 3. Validate inputs.
  if (typeof drive_file_id !== "string" || drive_file_id.trim() === "") {
    return errorResponse(
      400,
      "INVALID_REQUEST",
      "O campo 'drive_file_id' é obrigatório.",
    );
  }
  if (typeof name !== "string" || name.trim() === "") {
    return errorResponse(
      400,
      "INVALID_REQUEST",
      "O campo 'name' é obrigatório.",
    );
  }
  if (!Array.isArray(placeholder_names)) {
    return errorResponse(
      400,
      "INVALID_REQUEST",
      "O campo 'placeholder_names' deve ser um array de strings.",
    );
  }
  if (!Array.isArray(property_types) || property_types.length === 0) {
    return errorResponse(
      400,
      "INVALID_REQUEST",
      "O campo 'property_types' deve ser um array não vazio.",
    );
  }
  for (const pt of property_types) {
    if (!VALID_PROPERTY_TYPES.has(pt as string)) {
      return errorResponse(
        400,
        "INVALID_REQUEST",
        `Tipo de imóvel inválido: '${
          String(pt)
        }'. Use apartment, house ou commercial.`,
      );
    }
  }

  // 4. Insert template row.
  const db = userClient(jwt);
  const { data: template, error: insertError } = await db
    .from("templates")
    .insert({
      landlord_id: user.id,
      drive_file_id: drive_file_id.trim(),
      name: name.trim(),
      placeholder_names: placeholder_names as string[],
      last_modified_at: typeof last_modified_at === "string" &&
          last_modified_at.trim() !== ""
        ? last_modified_at.trim()
        : new Date().toISOString(),
    })
    .select("id")
    .single();

  if (insertError || !template) {
    return errorResponse(
      500,
      "DB_ERROR",
      "Erro ao salvar o template. Tente novamente.",
    );
  }

  const templateId = (template as Record<string, unknown>).id as string;

  // 5. Insert property_type_templates rows.
  const mappings = (property_types as string[]).map((pt) => ({
    landlord_id: user.id,
    property_type: pt,
    template_id: templateId,
  }));

  const { error: mappingError } = await db
    .from("property_type_templates")
    .insert(mappings);

  if (mappingError) {
    return errorResponse(
      500,
      "DB_ERROR",
      "Erro ao salvar os tipos de imóvel do template. Tente novamente.",
    );
  }

  return new Response(JSON.stringify({ id: templateId }), {
    status: 201,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─── DELETE /templates/:id ──────────────────────────────────────────────────

async function handleDeleteTemplate(
  req: Request,
  templateId: string,
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

  const db = userClient(jwt);

  // 2. Verify the template exists (RLS scopes to this landlord).
  const { data: existing, error: fetchError } = await db
    .from("templates")
    .select("id")
    .eq("id", templateId)
    .maybeSingle();

  if (fetchError || !existing) {
    return errorResponse(404, "TEMPLATE_NOT_FOUND", "Template não encontrado.");
  }

  // 3. Delete property_type_templates rows.
  const { error: mappingDeleteError } = await db
    .from("property_type_templates")
    .delete()
    .eq("template_id", templateId);

  if (mappingDeleteError) {
    return errorResponse(
      500,
      "DB_ERROR",
      "Erro ao remover os tipos de imóvel do template. Tente novamente.",
    );
  }

  // 4. Delete template row.
  const { error: deleteError } = await db
    .from("templates")
    .delete()
    .eq("id", templateId);

  if (deleteError) {
    return errorResponse(
      500,
      "DB_ERROR",
      "Erro ao remover o template. Tente novamente.",
    );
  }

  return new Response(null, {
    status: 204,
    headers: corsHeaders,
  });
}

if (import.meta.main) Deno.serve(handleTemplates);
