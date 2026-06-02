// POST /workflow/next — stateless backend workflow orchestrator.
//
// The backend owns startup (context loading, menu) and intent routing.
// The GPT is a thin relay: it sends { intent, values, message } each turn
// and displays the response verbatim.
//
// Startup (intent: null):
//   1. Load context internally (getContext).
//   2. If landlord not found → onboarding response.
//   3. If GOOGLE_REAUTH_REQUIRED → reauth response.
//   4. If message is a menu option number (1-6) → route to that workflow.
//   5. Otherwise → return main menu.
//
// Stateless round-trip design:
//   Request:  { intent, values, message }
//   Response: { message, intent, values, step, options?, error? }
//
// The GPT echoes back the intent/values the backend returned last turn.
// The backend infers the current step from the values present (no _machine_stage).
// No session_id or server-side session table needed.
//
// Auth: Bearer JWT verified via Supabase Auth — returns 401 if missing/invalid.

import { corsHeaders } from "../_shared/cors.ts";
import { errorResponse } from "../_shared/errors.ts";
import { publicFunctionsBaseUrl } from "../_shared/env.ts";
import { extractBearer, getAuthenticatedUser } from "../_shared/supabase.ts";
import { handleContext } from "../context/index.ts";
import { handleTemplatesDiff } from "../templates/diff/index.ts";
import { handleTenants } from "../tenants/index.ts";
import { invokeHandler } from "../_shared/internal.ts";
import {
  isValidCpf,
  normalizeBrazilianWhatsapp,
} from "../_shared/validation.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface WorkflowOption {
  label: string;
  value: string;
}

export interface WorkflowRequest {
  intent: string | null;
  values: Record<string, unknown>;
  message: string;
}

export interface WorkflowResponse {
  message: string;
  intent: string | null;
  values: Record<string, unknown>;
  step: string;
  options?: WorkflowOption[];
  error?: { code: string; message: string };
}

// ─── Step inference ───────────────────────────────────────────────────────────

export function inferStep(values: Record<string, unknown>): string {
  if (!values.property_id) return "ask_property";
  if (!values.name) return "ask_name";
  if (!values.cpf) return "ask_cpf";
  if (!("whatsapp" in values)) return "ask_whatsapp";
  return "confirm";
}

// ─── Dependency injection types (for testability) ────────────────────────────

export interface ContextProperty {
  id: string;
  name: string;
  display_name?: string;
  current_tenant_folder_id: string | null;
  [key: string]: unknown;
}

export interface ContextPayload {
  landlord?: { name: string; [key: string]: unknown };
  properties: ContextProperty[];
  [key: string]: unknown;
}

export interface CreateTenantResult {
  id: string;
  drive_folder_id: string;
}

export interface CreateTenantError {
  code: string;
  message: string;
}

export interface WorkflowDeps {
  /** Load full context for the authenticated landlord. Returns raw { status, body }. */
  loadContext: (jwt: string) => Promise<{ status: number; body: unknown }>;
  /** Load templates diff for the authenticated landlord. Returns raw { status, body }. */
  loadTemplatesDiff: (
    jwt: string,
  ) => Promise<{ status: number; body: unknown }>;
  /** Create a new tenant via the tenants handler. */
  createTenant: (
    jwt: string,
    payload: {
      property_id: string;
      name: string;
      cpf: string;
      whatsapp: string | null;
    },
  ) => Promise<{ status: number; body: unknown }>;
}

// ─── Default deps (real internal-invoke wrappers) ────────────────────────────

function makeDefaultDeps(): WorkflowDeps {
  return {
    loadContext: async (jwt) => {
      return await invokeHandler(handleContext, {
        method: "GET",
        path: "/context",
        jwt,
      });
    },

    loadTemplatesDiff: async (jwt) => {
      return await invokeHandler(handleTemplatesDiff, {
        method: "GET",
        path: "/templates/diff",
        jwt,
      });
    },

    createTenant: async (jwt, payload) => {
      return await invokeHandler(handleTenants, {
        method: "POST",
        path: "/tenants",
        jwt,
        body: payload,
      });
    },
  };
}

// ─── Menu helpers ─────────────────────────────────────────────────────────────

// Maps menu option number (1-6) to intent string.
const MENU_MAP: Record<string, string> = {
  "1": "record_payment",
  "2": "view_overdue",
  "3": "generate_document",
  "4": "send_signature",
  "5": "add_tenant",
  "6": "add_property",
};

function mainMenu(name: string): WorkflowResponse {
  const greeting = name
    ? `Olá, ${name}! O que você quer fazer?`
    : "O que você quer fazer?";
  return {
    message: greeting,
    intent: null,
    values: {},
    step: "menu",
    options: [
      { label: "1. Registrar pagamento", value: "record_payment" },
      { label: "2. Ver inadimplentes", value: "view_overdue" },
      { label: "3. Gerar documento", value: "generate_document" },
      { label: "4. Enviar para assinatura", value: "send_signature" },
      { label: "5. Adicionar inquilino", value: "add_tenant" },
      { label: "6. Adicionar imóvel", value: "add_property" },
    ],
  };
}

// ─── Error mapping ────────────────────────────────────────────────────────────

const WRITE_ERROR_MESSAGES: Record<string, string> = {
  GOOGLE_REAUTH_REQUIRED:
    "Sua conexão com o Google Drive expirou. Reconecte sua conta Google nas configurações do ChatGPT → Apps conectados → Lease Assistant → desconectar e reconectar.",
  INVALID_CPF:
    "O CPF informado não é válido. Por favor, informe o CPF no formato XXX.XXX.XXX-XX.",
  PROPERTY_NOT_FOUND:
    "Imóvel não encontrado. Por favor, selecione um imóvel válido.",
  LANDLORD_NOT_FOUND:
    "Cadastro do proprietário não encontrado. Conclua o processo de configuração.",
};

function mapWriteError(errorBody: unknown): string {
  if (
    errorBody &&
    typeof errorBody === "object" &&
    "error" in errorBody
  ) {
    const err = (errorBody as { error: { code?: string } }).error;
    if (err?.code && WRITE_ERROR_MESSAGES[err.code]) {
      return WRITE_ERROR_MESSAGES[err.code];
    }
  }
  return "Erro ao criar inquilino. Por favor, tente novamente.";
}

// ─── Startup sequence (intent: null) ─────────────────────────────────────────

async function handleStartup(
  jwt: string,
  req: WorkflowRequest,
  deps: WorkflowDeps,
): Promise<WorkflowResponse> {
  // Load context internally.
  const ctxResult = await deps.loadContext(jwt);

  // Handle GOOGLE_REAUTH_REQUIRED.
  if (
    ctxResult.status === 401 &&
    (ctxResult.body as { error?: { code?: string } } | null)?.error?.code ===
      "GOOGLE_REAUTH_REQUIRED"
  ) {
    return {
      message:
        "Sua conexão com o Google Drive expirou. Reconecte em Configurações do ChatGPT → Apps conectados → Lease Assistant → desconectar e reconectar.",
      intent: null,
      values: {},
      step: "reauth_required",
    };
  }

  // Handle landlord not found (404 or LANDLORD_NOT_FOUND error code).
  const bodyAsObj = ctxResult.body as
    | { error?: { code?: string } }
    | null
    | undefined;
  if (
    ctxResult.status === 404 ||
    (ctxResult.status === 401 &&
      bodyAsObj?.error?.code === "LANDLORD_NOT_FOUND") ||
    bodyAsObj?.error?.code === "LANDLORD_NOT_FOUND"
  ) {
    const setupUrl = `${publicFunctionsBaseUrl()}/setup`;
    return {
      message:
        "Você ainda não está cadastrado. Abra a configuração, faça login com Google e volte aqui.",
      intent: "onboarding",
      values: {},
      step: "awaiting_setup",
      options: [{ label: "Abrir configuração", value: setupUrl }],
    };
  }

  // Any other non-200 error.
  if (ctxResult.status !== 200) {
    return {
      message: "Erro ao carregar seus dados. Por favor, tente novamente.",
      intent: null,
      values: {},
      step: "error",
    };
  }

  const context = ctxResult.body as ContextPayload;

  // Check for template changes — if detected, note them but proceed to menu
  // (full template_sync workflow is a future milestone — tracked in #149).
  // We call loadTemplatesDiff here so the dep is exercised and the stub is testable.
  await deps.loadTemplatesDiff(jwt);

  // Check if message is a menu option selection.
  const selectedIntent = MENU_MAP[req.message.trim()];

  if (selectedIntent === "add_tenant") {
    return startAddTenantFlow(context);
  }

  if (selectedIntent) {
    // Other intents not yet implemented — return menu with note.
    const menu = mainMenu(context.landlord?.name ?? "");
    return {
      ...menu,
      message:
        `O fluxo "${selectedIntent}" ainda não está disponível via workflow. ${menu.message}`,
    };
  }

  // No valid selection — return menu (first message or invalid input).
  return mainMenu(context.landlord?.name ?? "");
}

// ─── Add tenant: initial turn (show property list) ───────────────────────────

async function startAddTenantFlow(
  context: ContextPayload,
): Promise<WorkflowResponse> {
  const intent = "add_tenant";
  const properties = context.properties ?? [];

  if (properties.length === 0) {
    return {
      message:
        "Nenhum imóvel cadastrado. Adicione um imóvel primeiro (opção 6 do menu).",
      intent,
      values: {},
      step: inferStep({}),
    };
  }

  const options: WorkflowOption[] = properties.map((p, i) => ({
    label: `${i + 1}. ${p.display_name ?? p.name}`,
    value: p.id,
  }));

  const optionsList = options.map((o) => o.label).join("\n");

  return {
    message: `Para qual imóvel deseja adicionar o inquilino?\n${optionsList}`,
    intent,
    values: {},
    step: inferStep({}),
    options,
  };
}

// ─── State machine ────────────────────────────────────────────────────────────

// Steps in order (machine starts at ask_property after the initial turn):
//   [startAddTenantFlow] → ask_property → ask_name → ask_cpf → ask_whatsapp → confirm → done

async function runAddTenantMachine(
  jwt: string,
  req: WorkflowRequest,
  deps: WorkflowDeps,
): Promise<WorkflowResponse> {
  const intent = "add_tenant";
  const values: Record<string, unknown> = req.values ?? {};
  const message = (req.message ?? "").trim();

  // ── Determine current step from values ────────────────────────────────────
  const currentStep = inferStep(values);

  // ── ask_property: user just replied with a property selection ─────────────
  if (currentStep === "ask_property") {
    // Reload context to get the property list (stateless — not stored in values)
    const ctx = await loadContextOrThrow(jwt, deps);
    const properties = ctx.properties ?? [];

    // Try to match user reply to a property (number or id)
    const trimmed = message.trim();
    const asNumber = parseInt(trimmed, 10);
    let selectedProperty: ContextProperty | undefined;

    if (!isNaN(asNumber) && asNumber >= 1 && asNumber <= properties.length) {
      selectedProperty = properties[asNumber - 1];
    } else {
      // Try exact ID match
      selectedProperty = properties.find((p) => p.id === trimmed);
    }

    if (!selectedProperty) {
      // Re-ask
      const options: WorkflowOption[] = properties.map((p, i) => ({
        label: `${i + 1}. ${p.display_name ?? p.name}`,
        value: p.id,
      }));
      const optionsList = options.map((o) => o.label).join("\n");
      const updatedValues: Record<string, unknown> = { ...values };
      return {
        message:
          `Não entendi. Por favor, escolha o número do imóvel:\n${optionsList}`,
        intent,
        values: updatedValues,
        step: inferStep(updatedValues),
        options,
      };
    }

    // Property selected — advance to ask_name (store only property_id and property_name)
    const updatedValues: Record<string, unknown> = {
      property_id: selectedProperty.id,
      property_name: selectedProperty.display_name ?? selectedProperty.name,
    };

    return {
      message: "Qual é o nome completo do inquilino?",
      intent,
      values: updatedValues,
      step: inferStep(updatedValues),
    };
  }

  // ── ask_name: user just replied with a name ───────────────────────────────
  if (currentStep === "ask_name") {
    if (!message) {
      return {
        message: "Por favor, informe o nome completo do inquilino.",
        intent,
        values,
        step: inferStep(values),
      };
    }

    const updatedValues = {
      ...values,
      name: message,
    };

    return {
      message: "Qual é o CPF do inquilino? (formato: XXX.XXX.XXX-XX)",
      intent,
      values: updatedValues,
      step: inferStep(updatedValues),
    };
  }

  // ── ask_cpf: user just replied with a CPF ─────────────────────────────────
  if (currentStep === "ask_cpf") {
    if (!isValidCpf(message)) {
      // Invalid CPF — re-ask, do not advance
      return {
        message: "CPF inválido. Por favor, informe no formato XXX.XXX.XXX-XX.",
        intent,
        values,
        step: inferStep(values),
      };
    }

    const updatedValues = {
      ...values,
      cpf: message.trim(),
    };

    return {
      message:
        "Qual é o WhatsApp do inquilino? (opcional — diga 'pular' para deixar em branco)",
      intent,
      values: updatedValues,
      step: inferStep(updatedValues),
    };
  }

  // ── ask_whatsapp: user just replied with a WhatsApp or "pular" ────────────
  if (currentStep === "ask_whatsapp") {
    const lower = message.toLowerCase();
    let whatsapp: string | null = null;

    if (lower !== "pular" && message !== "") {
      const normalized = normalizeBrazilianWhatsapp(message);
      if (normalized === null) {
        // Invalid WhatsApp — re-ask
        return {
          message:
            "Número de WhatsApp inválido. Informe no formato +55 (XX) XXXXX-XXXX ou diga 'pular' para deixar em branco.",
          intent,
          values,
          step: inferStep(values),
        };
      }
      whatsapp = normalized;
    }

    const updatedValues: Record<string, unknown> = {
      ...values,
      whatsapp,
    };

    // Build confirmation message (read from values, where name/cpf were stored)
    const propertyName = (values.property_name as string | undefined) ?? "";
    const tenantName = (values.name as string | undefined) ?? "";
    const cpf = (values.cpf as string | undefined) ?? "";
    const waDisplay = whatsapp ?? "(não informado)";

    const confirmMsg = [
      "**Novo inquilino**",
      `- Imóvel: ${propertyName}`,
      `- Nome: ${tenantName}`,
      `- CPF: ${cpf}`,
      `- WhatsApp: ${waDisplay}`,
      "",
      "Confirma? (Sim para continuar)",
    ].join("\n");

    return {
      message: confirmMsg,
      intent,
      values: updatedValues,
      step: inferStep(updatedValues),
    };
  }

  // ── confirm: user replied to the confirmation message ─────────────────────
  if (currentStep === "confirm") {
    if (message !== "Sim") {
      // Re-open collection
      return {
        message: "O que deseja alterar?",
        intent,
        values,
        step: inferStep(values),
      };
    }

    // Write: create tenant
    const property_id = values.property_id as string;
    const name = values.name as string;
    const cpf = values.cpf as string;
    const whatsapp = (values.whatsapp as string | null) ?? null;

    const result = await deps.createTenant(jwt, {
      property_id,
      name,
      cpf,
      whatsapp,
    });

    if (result.status !== 201) {
      const friendlyMessage = mapWriteError(result.body);
      return {
        message: friendlyMessage,
        intent,
        values,
        step: inferStep(values),
        error: {
          code: "CREATE_TENANT_FAILED",
          message: friendlyMessage,
        },
      };
    }

    const updatedValues = {
      ...values,
      tenant_id: (result.body as Record<string, unknown>).id,
      drive_folder_id: (result.body as Record<string, unknown>)
        .drive_folder_id,
    };

    return {
      message:
        "Inquilino adicionado! Vamos gerar o contrato agora? (Diga 'não' para fazer isso depois)",
      intent,
      values: updatedValues,
      step: "done",
    };
  }

  // Fallback — unknown step
  return {
    message: "Ocorreu um erro inesperado. Por favor, tente novamente.",
    intent,
    values: {},
    step: inferStep({}),
  };
}

// Helper: load context or throw on error (used when context is not preloaded).
async function loadContextOrThrow(
  jwt: string,
  deps: WorkflowDeps,
): Promise<ContextPayload> {
  const result = await deps.loadContext(jwt);
  if (result.status !== 200) {
    throw new Error(`loadContext failed with status ${result.status}`);
  }
  return result.body as ContextPayload;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export function handleWorkflowNext(
  deps: WorkflowDeps = makeDefaultDeps(),
) {
  return async (req: Request): Promise<Response> => {
    // Handle CORS preflight.
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

    // 2. Parse body.
    let body: WorkflowRequest;
    try {
      const raw = await req.json();
      body = raw as WorkflowRequest;
    } catch {
      return errorResponse(
        400,
        "INVALID_JSON",
        "Corpo da requisição inválido.",
      );
    }

    if (typeof body.message !== "string") {
      return errorResponse(
        400,
        "MISSING_MESSAGE",
        "O campo 'message' é obrigatório.",
      );
    }

    // 3. Route by intent.
    let machineResult: WorkflowResponse;
    try {
      if (!body.intent) {
        // Startup sequence: load context, handle errors, show menu or route.
        machineResult = await handleStartup(jwt, body, deps);
      } else if (body.intent === "add_tenant") {
        machineResult = await runAddTenantMachine(jwt, body, deps);
      } else {
        return errorResponse(
          400,
          "UNKNOWN_INTENT",
          "Intenção não reconhecida. Por favor, selecione uma opção do menu.",
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResponse(
        500,
        "INTERNAL_ERROR",
        `Erro interno: ${message}`,
      );
    }

    return new Response(JSON.stringify(machineResult), {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  };
}

// ─── Entry point ──────────────────────────────────────────────────────────────

const handleNext = handleWorkflowNext();

function serve(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname.replace(/\/+$/, "");

  if (pathname.endsWith("/workflow/next")) {
    return handleNext(req);
  }

  return Promise.resolve(
    errorResponse(404, "NOT_FOUND", "Rota não encontrada."),
  );
}

if (import.meta.main) Deno.serve(serve);
