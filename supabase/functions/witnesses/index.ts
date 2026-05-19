// POST /witnesses — adds a witness record for this landlord.
//
// Auth: Bearer JWT verified via Supabase Auth — returns 401 if missing/invalid.
// Uses userClient(jwt) for all DB ops — RLS enforces landlord isolation.

import { corsHeaders } from "../_shared/cors.ts";
import { errorResponse } from "../_shared/errors.ts";
import {
  extractBearer,
  getAuthenticatedUser,
  userClient,
} from "../_shared/supabase.ts";

export async function handleWitnesses(req: Request): Promise<Response> {
  // Handle CORS preflight.
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return errorResponse(405, "METHOD_NOT_ALLOWED", "Método não permitido.");
  }

  return handleCreateWitness(req);
}

// ─── POST /witnesses ────────────────────────────────────────────────────────

async function handleCreateWitness(req: Request): Promise<Response> {
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

  const { name, whatsapp } = (body ?? {}) as Record<string, unknown>;

  // 3. Validate.
  if (typeof name !== "string" || name.trim() === "") {
    return errorResponse(
      400,
      "INVALID_REQUEST",
      "O campo 'name' é obrigatório.",
    );
  }
  if (typeof whatsapp !== "string" || whatsapp.trim() === "") {
    return errorResponse(
      400,
      "INVALID_REQUEST",
      "O campo 'whatsapp' é obrigatório.",
    );
  }

  // 4. Insert witness row.
  const db = userClient(jwt);
  const { data: witness, error: insertError } = await db
    .from("witnesses")
    .insert({
      landlord_id: user.id,
      name: name.trim(),
      whatsapp: whatsapp.trim(),
    })
    .select("id")
    .single();

  if (insertError) {
    // Postgres unique constraint violation
    if (
      (insertError as unknown as Record<string, unknown>).code === "23505"
    ) {
      return errorResponse(
        409,
        "DUPLICATE_WITNESS",
        "Já existe uma testemunha com esse nome.",
      );
    }
    return errorResponse(
      500,
      "DB_ERROR",
      "Erro ao salvar a testemunha. Tente novamente.",
    );
  }
  if (!witness) {
    return errorResponse(
      500,
      "DB_ERROR",
      "Erro ao salvar a testemunha. Tente novamente.",
    );
  }

  return new Response(
    JSON.stringify({ id: (witness as Record<string, unknown>).id }),
    {
      status: 201,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
}

if (import.meta.main) Deno.serve(handleWitnesses);
