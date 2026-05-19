// PATCH /account/config — updates landlord account configuration.
//
// Currently supported fields:
//   payment_reminder_frequency: "daily" | "weekly" | "disabled"
//
// Auth: Bearer JWT verified via Supabase Auth — returns 401 if missing/invalid.
// Uses userClient(jwt) for all DB ops — RLS enforces landlord isolation.
// landlord_id is always taken from the verified JWT, never from the request body.

import { corsHeaders } from "../../_shared/cors.ts";
import { errorResponse } from "../../_shared/errors.ts";
import {
  extractBearer,
  getAuthenticatedUser,
  userClient,
} from "../../_shared/supabase.ts";

const VALID_FREQUENCIES = ["daily", "weekly", "disabled"] as const;
type ReminderFrequency = typeof VALID_FREQUENCIES[number];

export async function handleAccountConfig(req: Request): Promise<Response> {
  // Handle CORS preflight.
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "PATCH") {
    return errorResponse(405, "METHOD_NOT_ALLOWED", "Método não permitido.");
  }

  return handlePatchConfig(req);
}

// ─── PATCH /account/config ─────────────────────────────────────────────────

async function handlePatchConfig(req: Request): Promise<Response> {
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

  const { payment_reminder_frequency } = (body ?? {}) as Record<
    string,
    unknown
  >;

  if (
    typeof payment_reminder_frequency !== "string" ||
    !(VALID_FREQUENCIES as readonly string[]).includes(
      payment_reminder_frequency,
    )
  ) {
    return errorResponse(
      400,
      "INVALID_FREQUENCY",
      "O campo 'payment_reminder_frequency' deve ser 'daily', 'weekly' ou 'disabled'.",
    );
  }

  const frequency = payment_reminder_frequency as ReminderFrequency;

  // 3. Update the landlords row (RLS ensures only the authenticated landlord's
  //    row is updated — no additional WHERE clause needed beyond eq("id")).
  const db = userClient(jwt);
  const { error: updateError } = await db
    .from("landlords")
    .update({ payment_reminder_frequency: frequency })
    .eq("id", user.id);

  if (updateError) {
    return errorResponse(
      500,
      "DB_ERROR",
      "Erro ao atualizar a configuração. Tente novamente.",
    );
  }

  return new Response(
    JSON.stringify({ payment_reminder_frequency: frequency }),
    {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
}

if (import.meta.main) Deno.serve(handleAccountConfig);
