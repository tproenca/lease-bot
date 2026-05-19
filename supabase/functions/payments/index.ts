// POST /payments — records a received payment and computes whether it was
//   on_time (paid on or before the 5th of the reference month).
//
// GET /payments?month=YYYY-MM — returns paid and overdue tenants for the
//   given month, including the last reminder timestamp for overdue tenants.
//
// Auth: Bearer JWT verified via Supabase Auth — returns 401 if missing/invalid.
// Uses userClient(jwt) for all DB ops — RLS enforces landlord isolation.
// landlord_id is always taken from the verified JWT, never from the request body.

import { corsHeaders } from "../_shared/cors.ts";
import { errorResponse } from "../_shared/errors.ts";
import {
  extractBearer,
  getAuthenticatedUser,
  userClient,
} from "../_shared/supabase.ts";
import { isNonEmptyString } from "../_shared/validation.ts";

export async function handlePayments(req: Request): Promise<Response> {
  // Handle CORS preflight.
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method === "POST") {
    return handleRecordPayment(req);
  }

  if (req.method === "GET") {
    return handleGetPayments(req);
  }

  return errorResponse(405, "METHOD_NOT_ALLOWED", "Método não permitido.");
}

// ─── POST /payments ────────────────────────────────────────────────────────

async function handleRecordPayment(req: Request): Promise<Response> {
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
    tenant_id,
    amount,
    reference_month,
    paid_at,
  } = (body ?? {}) as Record<string, unknown>;

  if (!isNonEmptyString(tenant_id)) {
    return errorResponse(
      400,
      "MISSING_TENANT_ID",
      "O campo 'tenant_id' é obrigatório.",
    );
  }

  if (typeof amount !== "number" || amount <= 0) {
    return errorResponse(
      400,
      "INVALID_AMOUNT",
      "O campo 'amount' deve ser um número positivo.",
    );
  }

  if (!isNonEmptyString(reference_month)) {
    return errorResponse(
      400,
      "INVALID_REFERENCE_MONTH",
      "O campo 'reference_month' é obrigatório e deve estar no formato YYYY-MM ou YYYY-MM-DD.",
    );
  }

  // Normalize reference_month: accept YYYY-MM or YYYY-MM-DD.
  const MONTH_ONLY_RE = /^\d{4}-\d{2}$/;
  const FULL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  let referenceMonth: string;
  if (MONTH_ONLY_RE.test(reference_month)) {
    referenceMonth = `${reference_month}-01`;
  } else if (FULL_DATE_RE.test(reference_month)) {
    referenceMonth = reference_month;
  } else {
    return errorResponse(
      400,
      "INVALID_REFERENCE_MONTH",
      "O campo 'reference_month' deve estar no formato YYYY-MM ou YYYY-MM-DD.",
    );
  }

  if (!isNonEmptyString(paid_at)) {
    return errorResponse(
      400,
      "MISSING_PAID_AT",
      "O campo 'paid_at' é obrigatório.",
    );
  }

  const paidDate = new Date(paid_at as string);
  if (isNaN(paidDate.getTime())) {
    return errorResponse(
      400,
      "INVALID_PAID_AT",
      "O campo 'paid_at' deve ser uma data/hora ISO 8601 válida.",
    );
  }

  // 3. Compute on_time: paid on or before the 5th of the reference month.
  const dueDate = new Date(`${referenceMonth.substring(0, 7)}-05T23:59:59Z`);
  const on_time = paidDate <= dueDate;

  // 4. Insert into payments table using userClient (RLS enforces landlord isolation).
  const db = userClient(jwt);
  const { data: payment, error: insertError } = await db
    .from("payments")
    .insert({
      landlord_id: user.id,
      tenant_id: tenant_id as string,
      amount,
      reference_month: referenceMonth,
      paid_at: paid_at as string,
      on_time,
    })
    .select("id")
    .single();

  if (insertError || !payment) {
    return errorResponse(
      500,
      "DB_ERROR",
      "Erro ao registrar o pagamento. Tente novamente.",
    );
  }

  return new Response(
    JSON.stringify({
      id: (payment as Record<string, unknown>).id,
      on_time,
    }),
    {
      status: 201,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
}

// ─── GET /payments?month=YYYY-MM ──────────────────────────────────────────

async function handleGetPayments(req: Request): Promise<Response> {
  // 1. Validate query param.
  const url = new URL(req.url);
  const month = url.searchParams.get("month");

  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return errorResponse(
      400,
      "INVALID_MONTH",
      "O parâmetro 'month' é obrigatório e deve estar no formato YYYY-MM.",
    );
  }

  const referenceMonthDate = `${month}-01`;

  // 2. Verify JWT.
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

  // 3. Query payments for this month (RLS enforces landlord isolation).
  const { data: payments, error: paymentsError } = await db
    .from("payments")
    .select("id, tenant_id, amount, paid_at, on_time, tenants(name)")
    .eq("reference_month", referenceMonthDate);

  if (paymentsError) {
    return errorResponse(
      500,
      "DB_ERROR",
      "Erro ao consultar pagamentos. Tente novamente.",
    );
  }

  // 4. Query active tenants (currently assigned to a property).
  const { data: properties, error: propertiesError } = await db
    .from("properties")
    .select("current_tenant_folder_id")
    .not("current_tenant_folder_id", "is", null);

  if (propertiesError) {
    return errorResponse(
      500,
      "DB_ERROR",
      "Erro ao consultar imóveis. Tente novamente.",
    );
  }

  const activeFolderIds = properties?.map(
    (p: { current_tenant_folder_id: string }) => p.current_tenant_folder_id,
  ) ?? [];

  // Only query tenants if there are active folder IDs to avoid an empty .in() call.
  let activeTenants: Array<{ id: string; name: string }> = [];
  if (activeFolderIds.length > 0) {
    const { data: tenants, error: tenantsError } = await db
      .from("tenants")
      .select("id, name")
      .in("drive_folder_id", activeFolderIds);

    if (tenantsError) {
      return errorResponse(
        500,
        "DB_ERROR",
        "Erro ao consultar inquilinos ativos. Tente novamente.",
      );
    }
    activeTenants = (tenants ?? []) as Array<{ id: string; name: string }>;
  }

  // 5. Query reminders sent for this month.
  const { data: reminders, error: remindersError } = await db
    .from("payment_reminders")
    .select("tenant_id, sent_at")
    .eq("reference_month", referenceMonthDate)
    .order("sent_at", { ascending: false });

  if (remindersError) {
    return errorResponse(
      500,
      "DB_ERROR",
      "Erro ao consultar lembretes. Tente novamente.",
    );
  }

  // 6. Build the response.
  const paidTenantIds = new Set(
    (payments ?? []).map((p: { tenant_id: string }) => p.tenant_id),
  );

  type PaymentWithTenant = {
    tenant_id: string;
    amount: number;
    paid_at: string;
    on_time: boolean;
    tenants: { name: string } | Array<{ name: string }> | null;
  };

  const paid = ((payments ?? []) as Array<PaymentWithTenant>).map((p) => {
    const tenant = Array.isArray(p.tenants) ? p.tenants[0] : p.tenants;
    return {
      tenant_id: p.tenant_id,
      name: tenant?.name ?? null,
      amount: p.amount,
      paid_at: p.paid_at,
      on_time: p.on_time,
    };
  });

  // Build map of last reminder per tenant (already ordered desc by sent_at).
  const lastReminderMap = new Map<string, string>();
  for (
    const r of (reminders ?? []) as Array<{
      tenant_id: string;
      sent_at: string;
    }>
  ) {
    if (!lastReminderMap.has(r.tenant_id)) {
      lastReminderMap.set(r.tenant_id, r.sent_at);
    }
  }

  const overdue = activeTenants
    .filter((t) => !paidTenantIds.has(t.id))
    .map((t) => ({
      tenant_id: t.id,
      name: t.name,
      last_reminder_sent_at: lastReminderMap.get(t.id) ?? null,
    }));

  return new Response(JSON.stringify({ paid, overdue }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

if (import.meta.main) Deno.serve(handlePayments);
