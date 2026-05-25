// GET /context
//
// Primary data-loading endpoint called by the GPT at conversation start.
// Returns all landlord data needed to power the assistant:
//   landlord info, properties, buildings, templates (with property type
//   mappings), placeholder definitions, witnesses, account config, and
//   cron errors from the last 24 hours.
//
// Auth: Bearer JWT verified via Supabase Auth — returns 401 if missing or
//       invalid. The user client carries the JWT so RLS enforces landlord
//       isolation automatically on every query.
//
// No service-role key is used here — all queries run under the landlord's own
// JWT, which means RLS policies on all tables restrict results to the
// authenticated landlord's rows without any additional WHERE clause needed.

import { corsHeaders } from "../_shared/cors.ts";
import { errorResponse } from "../_shared/errors.ts";
import {
  extractBearer,
  getAuthenticatedUser,
  userClient,
} from "../_shared/supabase.ts";

export async function handleContext(req: Request): Promise<Response> {
  // Handle CORS preflight.
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Only GET is accepted.
  if (req.method !== "GET") {
    return errorResponse(405, "METHOD_NOT_ALLOWED", "Método não permitido.");
  }

  // 1. Verify JWT — extract from Authorization: Bearer header.
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

  // 2. Build a user-scoped Supabase client. RLS policies on every table
  //    automatically restrict results to rows owned by auth.uid() — i.e. this
  //    landlord's rows only. No service-role key is needed or used.
  const db = userClient(jwt);

  // 3. Fetch all required tables in parallel.
  const [
    landlordResult,
    propertiesResult,
    buildingsResult,
    templatesResult,
    pttResult,
    placeholdersResult,
    witnessesResult,
    cronErrorsResult,
  ] = await Promise.all([
    db
      .from("landlords")
      .select("name, whatsapp, payment_reminder_frequency")
      .eq("id", user.id)
      .maybeSingle(),
    db
      .from("properties")
      .select("id, type, name, address, building_id, current_tenant_folder_id")
      .order("name"),
    db
      .from("buildings")
      .select("id, name, address")
      .order("name"),
    db
      .from("templates")
      .select("id, name")
      .order("name"),
    db
      .from("property_type_templates")
      .select("template_id, property_type"),
    db
      .from("placeholders")
      .select(
        "name, required, format, case, default, derived_from, derived_formula, options",
      )
      .order("name"),
    db
      .from("witnesses")
      .select("name, whatsapp")
      .order("name"),
    db
      .from("cron_errors")
      .select("id, job_name, error, occurred_at")
      .gte(
        "occurred_at",
        new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      )
      .order("occurred_at", { ascending: false }),
  ]);

  // 4. Surface any DB errors.
  for (
    const result of [
      landlordResult,
      propertiesResult,
      buildingsResult,
      templatesResult,
      pttResult,
      placeholdersResult,
      witnessesResult,
      cronErrorsResult,
    ]
  ) {
    if (result.error) {
      return errorResponse(
        500,
        "DB_ERROR",
        "Erro ao carregar dados. Tente novamente.",
      );
    }
  }

  // 5. Validate that the landlord row exists (setup may not be complete).
  if (!landlordResult.data) {
    return errorResponse(
      404,
      "LANDLORD_NOT_FOUND",
      "Cadastro do proprietário não encontrado. Conclua o processo de configuração.",
    );
  }

  // 6. Build the template → property_types mapping from the join table.
  //    Group property_type rows by template_id so we can attach them below.
  const pttRows = (pttResult.data ?? []) as Array<{
    template_id: string;
    property_type: string;
  }>;
  const typesByTemplate = new Map<string, string[]>();
  for (const row of pttRows) {
    const list = typesByTemplate.get(row.template_id) ?? [];
    list.push(row.property_type);
    typesByTemplate.set(row.template_id, list);
  }

  // 7. Shape the response.
  const landlord = landlordResult.data as {
    name: string;
    whatsapp: string;
    payment_reminder_frequency: string;
  };

  const templates = (
    (templatesResult.data ?? []) as Array<{ id: string; name: string }>
  ).map((t) => ({
    id: t.id,
    name: t.name,
    property_types: typesByTemplate.get(t.id) ?? [],
  }));

  const body = {
    landlord: {
      name: landlord.name,
      whatsapp: landlord.whatsapp,
    },
    properties: propertiesResult.data ?? [],
    buildings: buildingsResult.data ?? [],
    templates,
    placeholders: placeholdersResult.data ?? [],
    witnesses: witnessesResult.data ?? [],
    account_config: {
      payment_reminder_frequency: landlord.payment_reminder_frequency,
    },
    cron_errors: cronErrorsResult.data ?? [],
  };

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

if (import.meta.main) Deno.serve(handleContext);
