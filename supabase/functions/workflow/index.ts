// POST /workflow/next — stateless backend workflow orchestrator.
//
// Pilot implementation for the "Adicionar inquilino" (add_tenant) flow.
// The GPT becomes a thin relay; the backend owns sequencing, validation,
// confirmation, and error mapping.
//
// Stateless round-trip design:
//   Request:  { intent, collected, stage, message }
//   Response: { assistant_message, intent, collected, stage, status,
//               options?, error? }
//
// The GPT echoes back the intent/collected/stage the backend returned last
// turn. The backend re-validates and returns the canonical `collected` each
// turn. No session_id or server-side session table needed.
//
// Auth: Bearer JWT verified via Supabase Auth — returns 401 if missing/invalid.

import { corsHeaders } from "../_shared/cors.ts";
import { errorResponse } from "../_shared/errors.ts";
import { extractBearer, getAuthenticatedUser } from "../_shared/supabase.ts";
import { handleContext } from "../context/index.ts";
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
  collected: Record<string, unknown> | null;
  stage: "collect" | "confirm" | null;
  message: string;
}

export interface WorkflowResponse {
  assistant_message: string;
  intent: string;
  collected: Record<string, unknown>;
  stage: "collect" | "confirm";
  status: "collecting" | "confirming" | "done";
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
  /** Load full context for the authenticated landlord. */
  loadContext: (jwt: string) => Promise<ContextPayload>;
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
      const { status, body } = await invokeHandler(handleContext, {
        method: "GET",
        path: "/context",
        jwt,
      });
      if (status !== 200) {
        throw new Error(`loadContext failed with status ${status}`);
      }
      return body as ContextPayload;
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

// ─── State machine ────────────────────────────────────────────────────────────

// Stages in order:
//   start → ask_property → ask_name → ask_cpf → ask_whatsapp → confirm → done

type MachineStage =
  | "ask_property"
  | "ask_name"
  | "ask_cpf"
  | "ask_whatsapp"
  | "confirm";

function isAddTenantIntent(message: string): boolean {
  const lower = message.toLowerCase().trim();
  return (
    lower === "add_tenant" ||
    lower.includes("adicionar inquilino") ||
    lower === "5"
  );
}

async function runAddTenantMachine(
  jwt: string,
  req: WorkflowRequest,
  deps: WorkflowDeps,
): Promise<WorkflowResponse> {
  const intent = "add_tenant";
  const collected: Record<string, unknown> = req.collected ?? {};
  const message = (req.message ?? "").trim();

  // ── Start: intent not yet set → route intent ──────────────────────────────
  if (!req.intent) {
    if (!isAddTenantIntent(message)) {
      // Unknown intent — ask for clarification (should not happen in normal flow)
      return {
        assistant_message:
          "Não entendi. Você deseja adicionar um inquilino? (Sim/Não)",
        intent,
        collected: {},
        stage: "collect",
        status: "collecting",
      };
    }

    // Load context to get property list
    const ctx = await deps.loadContext(jwt);
    const properties = ctx.properties ?? [];

    if (properties.length === 0) {
      return {
        assistant_message:
          "Nenhum imóvel cadastrado. Adicione um imóvel primeiro (opção 6 do menu).",
        intent,
        collected: {},
        stage: "collect",
        status: "collecting",
      };
    }

    const options: WorkflowOption[] = properties.map((p, i) => ({
      label: `${i + 1}. ${p.display_name ?? p.name}`,
      value: p.id,
    }));

    const optionsList = options.map((o) => o.label).join("\n");

    return {
      assistant_message:
        `Para qual imóvel deseja adicionar o inquilino?\n${optionsList}`,
      intent,
      collected: { _properties: properties },
      stage: "collect",
      status: "collecting",
      options,
    };
  }

  // ── Already in the machine: determine current stage ───────────────────────
  const currentStage = collected._machine_stage as MachineStage | undefined;

  // ── ask_property: user just replied with a property selection ─────────────
  if (!currentStage || currentStage === "ask_property") {
    // The collected object should have _properties from the previous turn,
    // OR we need to reload context if transitioning from a fresh intent.
    let properties = (collected._properties as ContextProperty[] | undefined) ??
      [];

    if (properties.length === 0) {
      // Reload context (may happen on the first real turn after intent routing)
      const ctx = await deps.loadContext(jwt);
      properties = ctx.properties ?? [];
    }

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
      return {
        assistant_message:
          `Não entendi. Por favor, escolha o número do imóvel:\n${optionsList}`,
        intent,
        collected: { ...collected, _machine_stage: "ask_property" },
        stage: "collect",
        status: "collecting",
        options,
      };
    }

    // Property selected — advance to ask_name
    const newCollected: Record<string, unknown> = {
      property_id: selectedProperty.id,
      property_name: selectedProperty.display_name ?? selectedProperty.name,
      _machine_stage: "ask_name",
    };

    return {
      assistant_message: "Qual é o nome completo do inquilino?",
      intent,
      collected: newCollected,
      stage: "collect",
      status: "collecting",
    };
  }

  // ── ask_name: user just replied with a name ───────────────────────────────
  if (currentStage === "ask_name") {
    if (!message) {
      return {
        assistant_message: "Por favor, informe o nome completo do inquilino.",
        intent,
        collected,
        stage: "collect",
        status: "collecting",
      };
    }

    const newCollected = {
      ...collected,
      name: message,
      _machine_stage: "ask_cpf",
    };

    return {
      assistant_message: "Qual é o CPF do inquilino? (formato: XXX.XXX.XXX-XX)",
      intent,
      collected: newCollected,
      stage: "collect",
      status: "collecting",
    };
  }

  // ── ask_cpf: user just replied with a CPF ─────────────────────────────────
  if (currentStage === "ask_cpf") {
    if (!isValidCpf(message)) {
      // Invalid CPF — re-ask, do not advance
      return {
        assistant_message:
          "CPF inválido. Por favor, informe no formato XXX.XXX.XXX-XX.",
        intent,
        collected,
        stage: "collect",
        status: "collecting",
      };
    }

    const newCollected = {
      ...collected,
      cpf: message.trim(),
      _machine_stage: "ask_whatsapp",
    };

    return {
      assistant_message:
        "Qual é o WhatsApp do inquilino? (opcional — diga 'pular' para deixar em branco)",
      intent,
      collected: newCollected,
      stage: "collect",
      status: "collecting",
    };
  }

  // ── ask_whatsapp: user just replied with a WhatsApp or "pular" ────────────
  if (currentStage === "ask_whatsapp") {
    const lower = message.toLowerCase();
    let whatsapp: string | null = null;

    if (lower !== "pular" && message !== "") {
      const normalized = normalizeBrazilianWhatsapp(message);
      if (normalized === null) {
        // Invalid WhatsApp — re-ask
        return {
          assistant_message:
            "Número de WhatsApp inválido. Informe no formato +55 (XX) XXXXX-XXXX ou diga 'pular' para deixar em branco.",
          intent,
          collected,
          stage: "collect",
          status: "collecting",
        };
      }
      whatsapp = normalized;
    }

    const newCollected: Record<string, unknown> = {
      ...collected,
      whatsapp,
      _machine_stage: "confirm",
    };

    // Build confirmation message (read from collected, where name/cpf were stored)
    const propertyName = (collected.property_name as string | undefined) ?? "";
    const tenantName = (collected.name as string | undefined) ?? "";
    const cpf = (collected.cpf as string | undefined) ?? "";
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
      assistant_message: confirmMsg,
      intent,
      collected: newCollected,
      stage: "confirm",
      status: "confirming",
    };
  }

  // ── confirm: user replied to the confirmation message ─────────────────────
  if (currentStage === "confirm") {
    if (message !== "Sim") {
      // Re-open collection
      return {
        assistant_message: "O que deseja alterar?",
        intent,
        collected: { ...collected, _machine_stage: "confirm" },
        stage: "confirm",
        status: "confirming",
      };
    }

    // Write: create tenant
    const property_id = collected.property_id as string;
    const name = collected.name as string;
    const cpf = collected.cpf as string;
    const whatsapp = (collected.whatsapp as string | null) ?? null;

    const result = await deps.createTenant(jwt, {
      property_id,
      name,
      cpf,
      whatsapp,
    });

    if (result.status !== 201) {
      const friendlyMessage = mapWriteError(result.body);
      return {
        assistant_message: friendlyMessage,
        intent,
        collected,
        stage: "confirm",
        status: "confirming",
        error: {
          code: "CREATE_TENANT_FAILED",
          message: friendlyMessage,
        },
      };
    }

    return {
      assistant_message:
        "Inquilino adicionado! Vamos gerar o contrato agora? (Diga 'não' para fazer isso depois)",
      intent,
      collected: {
        ...collected,
        tenant_id: (result.body as Record<string, unknown>).id,
        drive_folder_id: (result.body as Record<string, unknown>)
          .drive_folder_id,
      },
      stage: "collect",
      status: "done",
    };
  }

  // Fallback — unknown stage
  return {
    assistant_message:
      "Ocorreu um erro inesperado. Por favor, tente novamente.",
    intent,
    collected: {},
    stage: "collect",
    status: "collecting",
  };
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

    // 3. Route intent.
    const intent = body.intent ?? null;

    // Detect add_tenant intent on first turn or existing session.
    const isAddTenant = intent === "add_tenant" ||
      (!intent && isAddTenantIntent(body.message));

    if (!isAddTenant) {
      return errorResponse(
        400,
        "UNKNOWN_INTENT",
        "Intenção não reconhecida. Por favor, selecione uma opção do menu.",
      );
    }

    // 4. Run state machine.
    let machineResult: WorkflowResponse;
    try {
      machineResult = await runAddTenantMachine(jwt, body, deps);
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
