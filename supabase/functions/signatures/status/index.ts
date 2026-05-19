// GET  /signatures/:id/status  — fetch signing status from DB + Autentique.
// PATCH /signatures/:id/reminder — update reminder frequency on Autentique.
//
// Auth: Bearer JWT verified via Supabase Auth — returns 401 if missing/invalid.
// Uses userClient(jwt) for all DB ops — RLS enforces landlord isolation.
//
// GET /signatures/:id/status
//   Returns: { status, created_at, completed_at, signers: [{ name, signed_at }] }
//   - `status` read from signature_requests table
//   - `signers` fetched live from Autentique GraphQL API
//
// PATCH /signatures/:id/reminder
//   Body: { frequency: "DAILY" | "WEEKLY" }
//   Updates reminder frequency on Autentique via GraphQL mutation.
//   Returns 200 on success.
//
// Security:
//   - :id validated as UUID before any query
//   - `frequency` validated as exactly "DAILY" or "WEEKLY"
//   - autentique_api_key read from DB, never from request
//   - RLS enforces landlord_id = auth.uid() on signature_requests

import { corsHeaders } from "../../_shared/cors.ts";
import { errorResponse } from "../../_shared/errors.ts";
import {
  extractBearer,
  getAuthenticatedUser,
  userClient,
} from "../../_shared/supabase.ts";
import {
  getDocumentStatus,
  updateReminderFrequency,
} from "../../_shared/autentique.ts";

// ─── UUID validation ──────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

// ─── Router ───────────────────────────────────────────────────────────────

export async function handleStatus(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Extract :id from the URL path.
  // Expected paths (after function prefix is stripped by Supabase router):
  //   /signatures/<uuid>/status
  //   /signatures/<uuid>/reminder
  const url = new URL(req.url);
  const segments = url.pathname.replace(/^\/+/, "").split("/");
  // segments might be e.g. ["signatures", "<uuid>", "status"] or just ["<uuid>", "status"]
  // Find the UUID segment and the action segment that follows it.
  let signatureId: string | null = null;
  let action: string | null = null;
  for (let i = 0; i < segments.length; i++) {
    if (isUuid(segments[i])) {
      signatureId = segments[i];
      action = segments[i + 1] ?? null;
      break;
    }
  }

  if (!signatureId) {
    return errorResponse(
      400,
      "INVALID_ID",
      "O identificador da solicitação de assinatura é obrigatório e deve ser um UUID válido.",
    );
  }

  if (req.method === "GET" && action === "status") {
    return handleGetStatus(req, signatureId);
  }

  if (req.method === "PATCH" && action === "reminder") {
    return handlePatchReminder(req, signatureId);
  }

  return errorResponse(405, "METHOD_NOT_ALLOWED", "Método não permitido.");
}

// ─── GET /signatures/:id/status ───────────────────────────────────────────

async function handleGetStatus(
  req: Request,
  signatureId: string,
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

  // 2. Load signature_request from DB (RLS ensures it belongs to this landlord).
  const { data: sigReq, error: sigError } = await db
    .from("signature_requests")
    .select("id, autentique_document_id, status, created_at, completed_at")
    .eq("id", signatureId)
    .maybeSingle();

  if (sigError || !sigReq) {
    return errorResponse(
      404,
      "SIGNATURE_REQUEST_NOT_FOUND",
      "Solicitação de assinatura não encontrada.",
    );
  }

  const sr = sigReq as {
    id: string;
    autentique_document_id: string;
    status: string;
    created_at: string;
    completed_at: string | null;
  };

  // 3. Load landlord's Autentique API key.
  const { data: landlord, error: landlordError } = await db
    .from("landlords")
    .select("autentique_api_key")
    .eq("id", user.id)
    .maybeSingle();

  if (landlordError || !landlord) {
    return errorResponse(
      404,
      "LANDLORD_NOT_FOUND",
      "Cadastro do proprietário não encontrado.",
    );
  }

  const apiKey = (landlord as Record<string, unknown>)
    .autentique_api_key as string;

  // 4. Fetch live signer status from Autentique.
  let autentiqueStatus: Awaited<ReturnType<typeof getDocumentStatus>>;
  try {
    autentiqueStatus = await getDocumentStatus(
      apiKey,
      sr.autentique_document_id,
    );
  } catch {
    return errorResponse(
      502,
      "AUTENTIQUE_FETCH_FAILED",
      "Falha ao consultar o status no Autentique. Tente novamente.",
    );
  }

  return new Response(
    JSON.stringify({
      status: sr.status,
      created_at: sr.created_at,
      completed_at: sr.completed_at,
      signers: autentiqueStatus.signers,
    }),
    {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
}

// ─── PATCH /signatures/:id/reminder ──────────────────────────────────────

async function handlePatchReminder(
  req: Request,
  signatureId: string,
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

  // 2. Parse and validate body.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, "INVALID_JSON", "Corpo da requisição inválido.");
  }

  const { frequency } = (body ?? {}) as Record<string, unknown>;

  if (frequency !== "DAILY" && frequency !== "WEEKLY") {
    return errorResponse(
      400,
      "INVALID_FREQUENCY",
      "O campo 'frequency' deve ser 'DAILY' ou 'WEEKLY'.",
    );
  }

  const db = userClient(jwt);

  // 3. Load signature_request (RLS ensures it belongs to this landlord).
  const { data: sigReq, error: sigError } = await db
    .from("signature_requests")
    .select("id, autentique_document_id")
    .eq("id", signatureId)
    .maybeSingle();

  if (sigError || !sigReq) {
    return errorResponse(
      404,
      "SIGNATURE_REQUEST_NOT_FOUND",
      "Solicitação de assinatura não encontrada.",
    );
  }

  const sr = sigReq as { id: string; autentique_document_id: string };

  // 4. Load landlord's Autentique API key.
  const { data: landlord, error: landlordError } = await db
    .from("landlords")
    .select("autentique_api_key")
    .eq("id", user.id)
    .maybeSingle();

  if (landlordError || !landlord) {
    return errorResponse(
      404,
      "LANDLORD_NOT_FOUND",
      "Cadastro do proprietário não encontrado.",
    );
  }

  const apiKey = (landlord as Record<string, unknown>)
    .autentique_api_key as string;

  // 5. Update reminder frequency on Autentique.
  try {
    await updateReminderFrequency(apiKey, sr.autentique_document_id, frequency);
  } catch {
    return errorResponse(
      502,
      "AUTENTIQUE_UPDATE_FAILED",
      "Falha ao atualizar a frequência no Autentique. Tente novamente.",
    );
  }

  return new Response(null, {
    status: 200,
    headers: corsHeaders,
  });
}

if (import.meta.main) Deno.serve(handleStatus);
