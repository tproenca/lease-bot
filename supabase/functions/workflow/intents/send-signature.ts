// SEND_SIGNATURE FlowDefinition — selects an active tenant and sends their
// contract for e-signature via Autentique.

import { ERROR_MAP } from "../../_shared/error-map.ts";
import type { ContextPayload, WorkflowOption } from "../index.ts";
import type { ExecuteResult, FlowDefinition } from "../flow-engine.ts";

// ─── Context tenant type (matches context handler response) ───────────────────

interface ContextTenant {
  id: string;
  property_id: string;
  name: string;
  [key: string]: unknown;
}

// ─── SEND_SIGNATURE flow definition ──────────────────────────────────────────

export const SEND_SIGNATURE: FlowDefinition = {
  intent: "send_signature",
  confirmationTitle: "Enviar para assinatura",
  steps: [
    {
      key: "tenant_id",
      stepName: "tenant",
      label: "Inquilino",
      confirmDisplayKey: "tenant_name",
      prompt: (
        _values: Record<string, unknown>,
        ctx: ContextPayload,
      ): string => {
        const tenants = (ctx.tenants ?? []) as ContextTenant[];
        if (tenants.length === 0) {
          return "Nenhum inquilino ativo encontrado.";
        }
        return "Para qual inquilino deseja enviar o contrato para assinatura?";
      },
      options: (
        _values: Record<string, unknown>,
        ctx: ContextPayload,
      ): WorkflowOption[] => {
        const tenants = (ctx.tenants ?? []) as ContextTenant[];
        return tenants.map((t, i) => ({
          label: `${i + 1}. ${t.name}`,
          value: t.id,
        }));
      },
      validate: (
        input: string,
        _values: Record<string, unknown>,
        ctx: ContextPayload,
      ) => {
        const tenants = (ctx.tenants ?? []) as ContextTenant[];

        // No-tenants guard: if tenants is empty, the prompt already returned
        // the early-exit message. Any reply here should not advance the flow.
        if (tenants.length === 0) {
          return {
            ok: false,
            error: "Nenhum inquilino ativo encontrado.",
          };
        }

        const trimmed = input.trim();
        const asNumber = parseInt(trimmed, 10);
        let selected: ContextTenant | undefined = undefined;

        if (!isNaN(asNumber) && asNumber >= 1 && asNumber <= tenants.length) {
          selected = tenants[asNumber - 1];
        } else {
          selected = tenants.find((t) => t.id === trimmed);
        }

        if (!selected) {
          return {
            ok: false,
            error: "Não entendi. Por favor, escolha o número do inquilino:",
          };
        }

        // Inject display-only value for confirm summary.
        // deno-lint-ignore no-explicit-any
        (_values as any).tenant_name = selected.name;

        return { ok: true, value: selected.id };
      },
    },
  ],
  execute: async (values, jwt, deps): Promise<ExecuteResult> => {
    const result = await deps.sendSignature(jwt, {
      tenant_id: values.tenant_id as string,
    });

    if (result.status === 201) {
      return {
        ok: true,
        message: "Contrato enviado para assinatura.",
      };
    }

    // Map error codes to friendly messages.
    const errorBody = result.body as
      | { error?: { code?: string } }
      | null
      | undefined;
    const code = errorBody?.error?.code ?? "";

    const friendlyMessage = ERROR_MAP[code];
    if (!friendlyMessage) {
      console.error(
        `[send-signature] sendSignature failed with unmapped error code: ${
          JSON.stringify(code)
        } (status ${result.status})`,
      );
    }

    return {
      ok: false,
      step: "confirm",
      message: friendlyMessage ??
        "Erro ao enviar contrato para assinatura. Por favor, tente novamente.",
    };
  },
};
