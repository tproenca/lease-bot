// POST /payments/remind — GPT-triggered ad-hoc WhatsApp payment reminder.
//
// Sends a WhatsApp template message to the tenant's stored number, then records
// the attempt in `payment_reminders` with:
//   - sent_at = now()  if WhatsApp send succeeded
//   - sent_at = null   if WhatsApp send failed (records failure without throwing)
//
// Auth: Bearer JWT verified via Supabase Auth — returns 401 if missing/invalid.
// Uses userClient(jwt) for all DB ops — RLS enforces landlord isolation.
// landlord_id is always taken from the verified JWT, never from the request body.
//
// Error contract:
//   - Never returns 5xx for a WhatsApp failure — records with sent_at=null and
//     returns 422 WHATSAPP_SEND_FAILED so the GPT can surface a helpful message.
//   - All other errors follow the standard structured error format.

import { corsHeaders } from "../../_shared/cors.ts";
import { errorResponse } from "../../_shared/errors.ts";
import {
  extractBearer,
  getAuthenticatedUser,
  userClient,
} from "../../_shared/supabase.ts";
import { isNonEmptyString } from "../../_shared/validation.ts";
import { sendWhatsAppTemplate } from "../../_shared/whatsapp.ts";

// ─── UUID validation ──────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

// ─── reference_month normalization (same rules as POST /payments) ─────────

const MONTH_ONLY_RE = /^\d{4}-\d{2}$/;
const FULL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function normalizeReferenceMonth(value: string): string | null {
  if (MONTH_ONLY_RE.test(value)) return `${value}-01`;
  if (FULL_DATE_RE.test(value)) return value;
  return null;
}

// ─── Handler ──────────────────────────────────────────────────────────────

export async function handleRemind(req: Request): Promise<Response> {
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

  // 2. Parse and validate request body.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, "INVALID_JSON", "Corpo da requisição inválido.");
  }

  const { tenant_id, reference_month } = (body ?? {}) as Record<
    string,
    unknown
  >;

  if (!isUuid(tenant_id)) {
    return errorResponse(
      400,
      "INVALID_TENANT_ID",
      "O campo 'tenant_id' é obrigatório e deve ser um UUID válido.",
    );
  }

  if (!isNonEmptyString(reference_month)) {
    return errorResponse(
      400,
      "INVALID_REFERENCE_MONTH",
      "O campo 'reference_month' é obrigatório e deve estar no formato YYYY-MM ou YYYY-MM-DD.",
    );
  }

  const referenceMonth = normalizeReferenceMonth(reference_month);
  if (!referenceMonth) {
    return errorResponse(
      400,
      "INVALID_REFERENCE_MONTH",
      "O campo 'reference_month' deve estar no formato YYYY-MM ou YYYY-MM-DD.",
    );
  }

  const db = userClient(jwt);

  // 3. Load tenant record — verifies it belongs to this landlord via RLS.
  const { data: tenant, error: tenantError } = await db
    .from("tenants")
    .select("id, name, whatsapp")
    .eq("id", tenant_id)
    .maybeSingle();

  if (tenantError || !tenant) {
    return errorResponse(404, "TENANT_NOT_FOUND", "Inquilino não encontrado.");
  }

  const ten = tenant as { id: string; name: string; whatsapp: string | null };

  if (!ten.whatsapp) {
    return errorResponse(
      422,
      "TENANT_WHATSAPP_MISSING",
      "O inquilino não possui número de WhatsApp cadastrado. Atualize o cadastro antes de enviar o lembrete.",
    );
  }

  // 4. Send WhatsApp message — never throws; returns { ok, error? }.
  const sendResult = await sendWhatsAppTemplate({
    to: ten.whatsapp,
    templateName: "payment_reminder",
    languageCode: "pt_BR",
  });

  // 5. Record the reminder attempt regardless of send outcome.
  //    sent_at = now() on success; sent_at = null on failure (per spec).
  const reminderPayload: Record<string, unknown> = {
    landlord_id: user.id,
    tenant_id: ten.id,
    reference_month: referenceMonth,
  };

  if (sendResult.ok) {
    reminderPayload.sent_at = new Date().toISOString();
  }
  // When sendResult.ok is false, sent_at is omitted (null in DB).

  const { error: insertError } = await db
    .from("payment_reminders")
    .insert(reminderPayload);

  if (insertError) {
    return errorResponse(
      500,
      "DB_ERROR",
      "Erro ao registrar o lembrete. Tente novamente.",
    );
  }

  // 6. Return result — 422 (not 500) when WhatsApp send failed.
  if (!sendResult.ok) {
    return errorResponse(
      422,
      "WHATSAPP_SEND_FAILED",
      `Falha ao enviar o lembrete via WhatsApp (${
        sendResult.error ?? "unknown"
      }). O registro foi salvo sem data de envio.`,
    );
  }

  return new Response(null, {
    status: 200,
    headers: corsHeaders,
  });
}

if (import.meta.main) Deno.serve(handleRemind);
