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
//
// GET /context/health/cron
//
// Health check endpoint for external uptime monitors (e.g. UptimeRobot).
// Returns 200 { status: "ok" } when no cron_errors exist in the last 25 hours,
// or 503 { status: "error", errors: [...] } when one or more errors exist.
//
// Auth: Bearer service-role key — not a landlord JWT. Not intended for GPT use.

import { corsHeaders } from "../_shared/cors.ts";
import { requireEnv } from "../_shared/env.ts";
import { errorResponse } from "../_shared/errors.ts";
import {
  extractBearer,
  getAuthenticatedUser,
  serviceClient,
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

  // 3. Fetch all required tables in parallel (tenants depend on properties,
  //    so they are queried separately after properties resolve).
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
      .select("id, name, use_case")
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

  // 4. Surface any DB errors from the parallel queries.
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

  // 4b. Fetch only active tenants — those whose drive_folder_id matches one of
  //     the properties' current_tenant_folder_id values. This avoids returning
  //     historical tenants that the GPT doesn't need.
  const activeFolderIds = (propertiesResult.data ?? [])
    .map((p: Record<string, unknown>) => p.current_tenant_folder_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);

  let tenantsResult: { data: unknown[] | null; error: unknown };
  if (activeFolderIds.length === 0) {
    tenantsResult = { data: [], error: null };
  } else {
    tenantsResult = await db
      .from("tenants")
      .select("id, property_id, name, cpf, whatsapp, drive_folder_id")
      .in("drive_folder_id", activeFolderIds)
      .order("name");
  }

  if (tenantsResult.error) {
    return errorResponse(
      500,
      "DB_ERROR",
      "Erro ao carregar dados. Tente novamente.",
    );
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
    (templatesResult.data ?? []) as Array<{
      id: string;
      name: string;
      use_case: string | null;
    }>
  ).map((t) => ({
    id: t.id,
    name: t.name,
    use_case: t.use_case,
    property_types: typesByTemplate.get(t.id) ?? [],
  }));

  // Build a lookup map from building ID to building address so we can
  // compose the display address for apartments whose own address is NULL.
  const buildings = (buildingsResult.data ?? []) as Array<{
    id: string;
    name: string;
    address: string;
  }>;
  const buildingAddressById = new Map(buildings.map((b) => [b.id, b.address]));
  const buildingNameById = new Map(buildings.map((b) => [b.id, b.name]));

  // For apartments, derive the display address from the building's address:
  //   "{building.address}, {property.name}"
  // For house/commercial, the address is stored directly on the property.
  // Also add display_name for apartments: "{building.name} - {property.name}"
  const properties = (
    (propertiesResult.data ?? []) as Array<{
      id: string;
      type: string;
      name: string;
      address: string | null;
      building_id: string | null;
      current_tenant_folder_id: string | null;
    }>
  ).map((p) => {
    if (p.type === "apartment" && p.building_id) {
      const bldgAddress = buildingAddressById.get(p.building_id) ?? "";
      const bldgName = buildingNameById.get(p.building_id) ?? "";
      return {
        ...p,
        address: p.address ??
          (bldgAddress ? `${bldgAddress}, ${p.name}` : p.name),
        display_name: bldgName ? `${bldgName} - ${p.name}` : p.name,
      };
    }
    return p;
  });

  const body = {
    landlord: {
      name: landlord.name,
      whatsapp: landlord.whatsapp,
    },
    properties,
    buildings,
    templates,
    placeholders: placeholdersResult.data ?? [],
    witnesses: witnessesResult.data ?? [],
    tenants: tenantsResult.data ?? [],
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

// ─── GET /context/health/cron ─────────────────────────────────────────────

export async function handleHealthCron(req: Request): Promise<Response> {
  // Handle CORS preflight.
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Only GET is accepted.
  if (req.method !== "GET") {
    return errorResponse(405, "METHOD_NOT_ALLOWED", "Método não permitido.");
  }

  // Require service-role key for authentication. The caller must send:
  //   Authorization: Bearer <service_role_key>
  // This endpoint is not intended for GPT use — it is called by external
  // uptime monitors that cannot obtain a landlord JWT.
  const bearer = extractBearer(req);
  if (!bearer || bearer !== requireEnv("SUPABASE_SERVICE_ROLE_KEY")) {
    return errorResponse(
      401,
      "UNAUTHORIZED",
      "Token de autorização inválido.",
    );
  }

  // Query cron_errors from the last 25 hours using the service client.
  const db = serviceClient();
  const { data: errors, error } = await db
    .from("cron_errors")
    .select("job_name, error, occurred_at")
    .gte(
      "occurred_at",
      new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    )
    .order("occurred_at", { ascending: false });

  if (error) {
    return errorResponse(500, "DB_ERROR", "Erro ao verificar cron_errors.");
  }

  const rows = errors ?? [];

  if (rows.length === 0) {
    return new Response(JSON.stringify({ status: "ok" }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ status: "error", errors: rows }), {
    status: 503,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─── Entry point ─────────────────────────────────────────────────────────────

function serve(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname.endsWith("/health/cron")) {
    return handleHealthCron(req);
  }
  return handleContext(req);
}

if (import.meta.main) Deno.serve(serve);
