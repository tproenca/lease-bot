// POST /workflow/next — stateless backend workflow orchestrator.
//
// Contract redesign (issue #169):
//   Request:  { intent?, state?, message }
//   Response: { message, intent?, state, step, options? }
//
// state is an opaque base64-encoded JSON token carrying all flow state.
// The GPT echoes it verbatim each turn — it never decodes or inspects it.
//
// Enter/Process split:
//   state absent → Enter phase: engine renders first prompt (no validation)
//   state present → Process phase: engine validates user message
//
// Session boundaries (menu, onboarding, reauth, error) → state: null
//
// Intent router (when intent is absent):
//   Try MENU_MAP by number: "5" → add_tenant
//   Try text match (case-insensitive): "Adicionar inquilino" → add_tenant
//   Match found → Enter phase → start flow
//   No match → load context → return menu
//
// step: done auto-transition → return menu response with success message prepended
//
// Auth: Bearer JWT verified via Supabase Auth — returns 401 if missing/invalid.

import { corsHeaders } from "../_shared/cors.ts";
import { errorResponse } from "../_shared/errors.ts";
import { publicFunctionsBaseUrl } from "../_shared/env.ts";
import { extractBearer, getAuthenticatedUser } from "../_shared/supabase.ts";
import { handleContext } from "../context/index.ts";
import { handleTemplatesDiff } from "../templates/diff/index.ts";
import { handleTenants } from "../tenants/index.ts";
import { handleGenerateDocuments } from "../documents/generate/index.ts";
import { handleProperties } from "../properties/index.ts";
import { handleSend } from "../signatures/send/index.ts";
import { invokeHandler } from "../_shared/internal.ts";
import { ADD_TENANT } from "./intents/add-tenant.ts";
import { ADD_PROPERTY } from "./intents/add-property.ts";
import { GENERATE_DOCUMENT } from "./intents/generate-document.ts";
import { SEND_SIGNATURE } from "./intents/send-signature.ts";
import { type FlowDefinition, runFlowEngine } from "./flow-engine.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface WorkflowOption {
  label: string;
  value: string;
}

/** Wire request shape sent by GPT. */
export interface WorkflowRawRequest {
  intent?: string | null;
  state?: string | null;
  message: string;
}

/**
 * Internal request type used by the flow engine.
 * values is decoded from the opaque state token.
 */
export interface WorkflowRequest {
  intent: string | null;
  values: Record<string, unknown>;
  message: string;
}

/** Wire response shape returned to GPT. */
export interface WorkflowResponse {
  message: string;
  intent: string | null;
  /** Opaque state token. null = session boundary (menu, onboarding, reauth, error). */
  state: string | null;
  step: string;
  options?: WorkflowOption[];
  error?: { code: string; message: string };
}

/** Internal engine response (uses values, not state). */
export interface EngineResponse {
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
  /** Generate documents for a tenant via POST /documents/generate. */
  generateDocument: (
    jwt: string,
    payload: {
      property_id: string;
      tenant_id: string;
    },
  ) => Promise<{ status: number; body: unknown }>;
  /** Create a new property via POST /properties. */
  createProperty: (
    jwt: string,
    payload: {
      type: string;
      name: string;
      building_id: string | null;
      address: string | null;
    },
  ) => Promise<{ status: number; body: unknown }>;
  /** Send a tenant's contract for e-signature via POST /signatures/send. */
  sendSignature: (
    jwt: string,
    payload: {
      tenant_id: string;
    },
  ) => Promise<{ status: number; body: unknown }>;
}

// ─── Flow registry ────────────────────────────────────────────────────────────

const FLOWS: Record<string, FlowDefinition> = {
  add_tenant: ADD_TENANT,
  generate_document: GENERATE_DOCUMENT,
  add_property: ADD_PROPERTY,
  send_signature: SEND_SIGNATURE,
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

    generateDocument: async (jwt, payload) => {
      return await invokeHandler(handleGenerateDocuments, {
        method: "POST",
        path: "/documents/generate",
        jwt,
        body: payload,
      });
    },

    createProperty: async (jwt, payload) => {
      return await invokeHandler(handleProperties, {
        method: "POST",
        path: "/properties",
        jwt,
        body: payload,
      });
    },

    sendSignature: async (jwt, payload) => {
      return await invokeHandler(handleSend, {
        method: "POST",
        path: "/signatures/send",
        jwt,
        body: payload,
      });
    },
  };
}

// ─── State token helpers ──────────────────────────────────────────────────────

/** Encode values as opaque base64 state token. */
function encodeState(values: Record<string, unknown>): string {
  return btoa(JSON.stringify(values));
}

/** Decode opaque state token into values. Returns {} on failure. */
function decodeState(state: string): Record<string, unknown> {
  try {
    return JSON.parse(atob(state)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// ─── Response builder ─────────────────────────────────────────────────────────

/**
 * Convert an engine response to the wire response.
 * state: null for session boundaries (menu, onboarding, reauth, error).
 * state: encoded values for flows in progress.
 */
function toWireResponse(
  eng: EngineResponse,
  isBoundary: boolean,
): WorkflowResponse {
  return {
    message: eng.message,
    intent: eng.intent ?? null,
    state: isBoundary ? null : encodeState(eng.values),
    step: eng.step,
    ...(eng.options ? { options: eng.options } : {}),
    ...(eng.error ? { error: eng.error } : {}),
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

// Maps text labels (lowercase) to intent string for natural language routing.
const LABEL_MAP: Record<string, string> = {
  "registrar pagamento": "record_payment",
  "ver inadimplentes": "view_overdue",
  "gerar documento": "generate_document",
  "enviar para assinatura": "send_signature",
  "adicionar inquilino": "add_tenant",
  "adicionar imóvel": "add_property",
  "adicionar imovel": "add_property",
};

function mainMenuResponse(name: string): WorkflowResponse {
  const firstName = name.split(/\s+/)[0];
  const greeting = firstName
    ? `Olá, ${firstName}! O que você quer fazer?`
    : "O que você quer fazer?";
  return {
    message: greeting,
    intent: null,
    state: null,
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

// ─── Intent router ─────────────────────────────────────────────────────────────

/**
 * Resolve an intent from a user message (when no intent is provided by GPT).
 * Tries numeric MENU_MAP first, then case-insensitive text label match.
 * Returns null if no match.
 */
function resolveIntentFromMessage(message: string): string | null {
  const trimmed = message.trim();

  // Try numeric match.
  const byNumber = MENU_MAP[trimmed];
  if (byNumber) return byNumber;

  // Try text label match (case-insensitive).
  const byLabel = LABEL_MAP[trimmed.toLowerCase()];
  if (byLabel) return byLabel;

  return null;
}

// ─── Context loader ────────────────────────────────────────────────────────────

async function loadContext(
  jwt: string,
  deps: WorkflowDeps,
): Promise<
  | { ok: true; context: ContextPayload }
  | { ok: false; response: WorkflowResponse }
> {
  const ctxResult = await deps.loadContext(jwt);

  // Handle GOOGLE_REAUTH_REQUIRED.
  if (
    ctxResult.status === 401 &&
    (ctxResult.body as { error?: { code?: string } } | null)?.error?.code ===
      "GOOGLE_REAUTH_REQUIRED"
  ) {
    return {
      ok: false,
      response: {
        message:
          "Sua conexão com o Google Drive expirou. Reconecte em Configurações do ChatGPT → Apps conectados → Lease Assistant → desconectar e reconectar.",
        intent: null,
        state: null,
        step: "reauth_required",
      },
    };
  }

  // Handle landlord not found.
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
      ok: false,
      response: {
        message:
          "Você ainda não está cadastrado. Abra a configuração, faça login com Google e volte aqui.",
        intent: "onboarding",
        state: null,
        step: "awaiting_setup",
        options: [{ label: "Abrir configuração", value: setupUrl }],
      },
    };
  }

  // Any other non-200 error.
  if (ctxResult.status !== 200) {
    return {
      ok: false,
      response: {
        message: "Erro ao carregar seus dados. Por favor, tente novamente.",
        intent: null,
        state: null,
        step: "error",
      },
    };
  }

  return { ok: true, context: ctxResult.body as ContextPayload };
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
    let raw: WorkflowRawRequest;
    try {
      const parsed = await req.json();
      raw = parsed as WorkflowRawRequest;
    } catch {
      return errorResponse(
        400,
        "INVALID_JSON",
        "Corpo da requisição inválido.",
      );
    }

    if (typeof raw.message !== "string") {
      return errorResponse(
        400,
        "MISSING_MESSAGE",
        "O campo 'message' é obrigatório.",
      );
    }

    // 3. Route by intent + state.
    let wireResult: WorkflowResponse;
    try {
      const intent = raw.intent ?? null;
      const statePresent = raw.state != null;

      if (!intent) {
        // ── No intent: intent router or startup ─────────────────────────
        const resolved = resolveIntentFromMessage(raw.message);

        if (resolved && FLOWS[resolved]) {
          // Match found — Enter phase: start the flow (no validation).
          const ctxResult = await loadContext(jwt, deps);
          if (!ctxResult.ok) {
            wireResult = ctxResult.response;
          } else {
            const engReq: WorkflowRequest = {
              intent: resolved,
              values: {},
              message: "", // Enter phase — no message to validate
            };
            const engResp = await runFlowEngine(
              FLOWS[resolved],
              engReq,
              ctxResult.context,
              deps,
              jwt,
            );
            wireResult = toWireResponse(engResp, false);
          }
        } else if (resolved) {
          // Intent matched but flow not yet implemented — load context for
          // the menu, showing a note.
          const ctxResult = await loadContext(jwt, deps);
          if (!ctxResult.ok) {
            wireResult = ctxResult.response;
          } else {
            await deps.loadTemplatesDiff(jwt);
            const menu = mainMenuResponse(
              ctxResult.context.landlord?.name ?? "",
            );
            wireResult = {
              ...menu,
              message:
                `O fluxo "${resolved}" ainda não está disponível via workflow. ${menu.message}`,
            };
          }
        } else {
          // No match — load context and show menu.
          const ctxResult = await loadContext(jwt, deps);
          if (!ctxResult.ok) {
            wireResult = ctxResult.response;
          } else {
            await deps.loadTemplatesDiff(jwt);
            wireResult = mainMenuResponse(
              ctxResult.context.landlord?.name ?? "",
            );
          }
        }
      } else {
        // ── Intent present: Enter or Process phase ────────────────────────
        const flow = FLOWS[intent];
        if (!flow) {
          return errorResponse(
            400,
            "UNKNOWN_INTENT",
            "Intenção não reconhecida. Por favor, selecione uma opção do menu.",
          );
        }

        // Load context (needed for steps that use context).
        const ctxResult = await loadContext(jwt, deps);
        if (!ctxResult.ok) {
          wireResult = ctxResult.response;
        } else {
          // Decode state or use empty values for Enter phase.
          const values = statePresent ? decodeState(raw.state!) : {};
          // Enter phase: state absent → pass empty message (no validation).
          // Process phase: state present → pass actual message (validate input).
          const messageToEngine = statePresent ? raw.message : "";

          const engReq: WorkflowRequest = {
            intent,
            values,
            message: messageToEngine,
          };

          const engResp = await runFlowEngine(
            flow,
            engReq,
            ctxResult.context,
            deps,
            jwt,
          );

          // step: done auto-transition — return menu with success message prepended.
          if (engResp.step === "done") {
            const ctxMenu = await loadContext(jwt, deps);
            const name = ctxMenu.ok ? ctxMenu.context.landlord?.name ?? "" : "";
            const menu = mainMenuResponse(name);
            wireResult = {
              ...menu,
              message: `${engResp.message}\n\nO que mais posso te ajudar?`,
            };
          } else {
            wireResult = toWireResponse(engResp, false);
          }
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

    return new Response(JSON.stringify(wireResult), {
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
