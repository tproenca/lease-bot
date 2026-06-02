// ADD_TENANT FlowDefinition — collects property, name, CPF, whatsapp and creates a tenant.

import {
  isValidCpf,
  normalizeBrazilianWhatsapp,
} from "../../_shared/validation.ts";
import type { ContextPayload, WorkflowOption } from "../index.ts";
import type { ExecuteResult, FlowDefinition } from "../flow-engine.ts";

// ─── Error mapping ────────────────────────────────────────────────────────────

const ERROR_MAP: Record<string, string> = {
  GOOGLE_REAUTH_REQUIRED:
    "Sua conexão com o Google Drive expirou. Reconecte sua conta Google nas configurações do ChatGPT → Apps conectados → Lease Assistant → desconectar e reconectar.",
  INVALID_CPF:
    "O CPF informado não é válido. Por favor, informe o CPF no formato XXX.XXX.XXX-XX.",
  PROPERTY_NOT_FOUND:
    "Imóvel não encontrado. Por favor, selecione um imóvel válido.",
  LANDLORD_NOT_FOUND:
    "Cadastro do proprietário não encontrado. Conclua o processo de configuração.",
};

// ─── ADD_TENANT flow definition ───────────────────────────────────────────────

export const ADD_TENANT: FlowDefinition = {
  intent: "add_tenant",
  confirmationTitle: "Novo inquilino",
  steps: [
    {
      key: "property_id",
      stepName: "property",
      prompt: (
        _values: Record<string, unknown>,
        ctx: ContextPayload,
      ): string => {
        const properties = ctx.properties ?? [];
        if (properties.length === 0) {
          return "Nenhum imóvel cadastrado. Adicione um imóvel primeiro (opção 6 do menu).";
        }
        return "Para qual imóvel deseja adicionar o inquilino?";
      },
      options: (
        _values: Record<string, unknown>,
        ctx: ContextPayload,
      ): WorkflowOption[] => {
        return (ctx.properties ?? []).map((p, i) => ({
          label: `${i + 1}. ${p.display_name ?? p.name}`,
          value: p.id,
        }));
      },
      validate: (
        input: string,
        _values: Record<string, unknown>,
        ctx: ContextPayload,
      ) => {
        const properties = ctx.properties ?? [];
        const trimmed = input.trim();
        const asNumber = parseInt(trimmed, 10);
        let selected = undefined;

        if (
          !isNaN(asNumber) && asNumber >= 1 && asNumber <= properties.length
        ) {
          selected = properties[asNumber - 1];
        } else {
          selected = properties.find((p) => p.id === trimmed);
        }

        if (!selected) {
          return {
            ok: false,
            error: "Não entendi. Por favor, escolha o número do imóvel:",
          };
        }

        // Return property_id; the engine stores it under key "property_id".
        // We also need property_name for display — inject as a side-step value.
        // The engine does not support multi-key returns from validate, so we
        // use a composite approach: return an object that the engine stores
        // under "property_id". The separate display key "property_name" is
        // handled by the property_name step below.
        // Actually: validate can only set the value for its own key.
        // We store property_name separately in the "property_name" step.
        // But wait — property_name has no dedicated step. To keep property_name
        // in values (for display), we store it via a side-effect on the
        // incoming values object. This is a well-known pattern here.
        // The engine passes `values` by reference (it's an object). We mutate
        // it here to inject property_name alongside property_id.
        // deno-lint-ignore no-explicit-any
        (_values as any).property_name = selected.display_name ?? selected.name;

        return { ok: true, value: selected.id };
      },
    },
    {
      key: "name",
      prompt: "Qual é o nome completo do inquilino?",
      validate: (input: string) => {
        const trimmed = input.trim();
        return trimmed.length > 0
          ? { ok: true, value: trimmed }
          : { ok: false, error: "Nome não pode ser vazio." };
      },
    },
    {
      key: "cpf",
      prompt: "Qual é o CPF? (formato: XXX.XXX.XXX-XX)",
      validate: (input: string) => {
        return isValidCpf(input)
          ? { ok: true, value: input.trim() }
          : { ok: false, error: "CPF inválido. Use o formato XXX.XXX.XXX-XX." };
      },
    },
    {
      key: "whatsapp",
      prompt:
        "Qual é o WhatsApp do inquilino? (opcional — diga 'pular' para deixar em branco)",
      optional: true,
      validate: (input: string) => {
        const n = normalizeBrazilianWhatsapp(input);
        return n !== null ? { ok: true, value: n } : {
          ok: false,
          error:
            "Número de WhatsApp inválido. Informe no formato +55 (XX) XXXXX-XXXX ou diga 'pular' para deixar em branco.",
        };
      },
    },
  ],
  execute: async (values, jwt, deps): Promise<ExecuteResult> => {
    const result = await deps.createTenant(jwt, {
      property_id: values.property_id as string,
      name: values.name as string,
      cpf: values.cpf as string,
      whatsapp: (values.whatsapp as string | null) ?? null,
    });

    if (result.status === 201) {
      const body = result.body as Record<string, unknown>;
      return {
        ok: true,
        message:
          "Inquilino adicionado! Vamos gerar o contrato agora? (Diga 'não' para fazer isso depois)",
        values: {
          tenant_id: body.id,
          drive_folder_id: body.drive_folder_id,
        },
      };
    }

    // Map error codes to friendly messages.
    const errorBody = result.body as
      | { error?: { code?: string } }
      | null
      | undefined;
    const code = errorBody?.error?.code ?? "";
    return {
      ok: false,
      step: "confirm",
      message: ERROR_MAP[code] ??
        "Erro ao criar inquilino. Por favor, tente novamente.",
    };
  },
};
