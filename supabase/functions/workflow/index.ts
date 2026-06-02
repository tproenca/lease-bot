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
import { ADD_TENANT } from "./intents/add-tenant.ts";
import { type FlowDefinition, runFlowEngine } from "./flow-engine.ts";

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

// ─── Flow registry ────────────────────────────────────────────────────────────

const FLOWS: Record<string, FlowDefinition> = {
  add_tenant: ADD_TENANT,
};

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
  // (full template_sync workflow is a future milestone).
  // We call loadTemplatesDiff here so the dep is exercised and the stub is testable.
  await deps.loadTemplatesDiff(jwt);

  // Check if message is a menu option selection.
  const selectedIntent = MENU_MAP[req.message.trim()];

  if (selectedIntent && FLOWS[selectedIntent]) {
    // Route to the flow engine — pass an empty-message initial request so the
    // engine shows the first prompt without trying to interpret the menu number
    // as a flow answer.
    const flow = FLOWS[selectedIntent];
    const initialReq: WorkflowRequest = {
      intent: selectedIntent,
      values: {},
      message: "",
    };
    return runFlowEngine(flow, initialReq, context, deps, jwt);
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

// Helper: load context or throw on error.
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
      } else {
        const flow = body.intent ? FLOWS[body.intent] : undefined;
        if (flow) {
          // Load context for the flow engine (needed for steps that use context).
          const context = await loadContextOrThrow(jwt, deps);
          machineResult = await runFlowEngine(flow, body, context, deps, jwt);
        } else {
          return errorResponse(
            400,
            "UNKNOWN_INTENT",
            "Intenção não reconhecida. Por favor, selecione uma opção do menu.",
          );
        }
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
