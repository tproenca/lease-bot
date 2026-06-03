// GENERATE_DOCUMENT FlowDefinition — selects an active tenant and regenerates
// their contract documents via POST /documents/generate.

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

// ─── GENERATE_DOCUMENT flow definition ────────────────────────────────────────

export const GENERATE_DOCUMENT: FlowDefinition = {
  intent: "generate_document",
  confirmationTitle: "Gerar documento",
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
        return "Para qual inquilino deseja gerar os documentos?";
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

        // Inject display-only and carry-through values into values by reference.
        // tenant_name is used in the confirm summary display.
        // property_id is needed for the execute() API call.
        // property_name is looked up from ctx.properties for display.
        // deno-lint-ignore no-explicit-any
        (_values as any).tenant_name = selected.name;
        // deno-lint-ignore no-explicit-any
        (_values as any).property_id = selected.property_id;

        // Look up property_name for display (same pattern as add-tenant.ts).
        const properties = ctx.properties ?? [];
        const prop = properties.find((p) => p.id === selected!.property_id);
        // deno-lint-ignore no-explicit-any
        (_values as any).property_name = prop
          ? (prop.display_name ?? prop.name)
          : selected.property_id;

        return { ok: true, value: selected.id };
      },
    },
  ],
  execute: async (values, jwt, deps): Promise<ExecuteResult> => {
    const result = await deps.generateDocument(jwt, {
      property_id: values.property_id as string,
      tenant_id: values.tenant_id as string,
    });

    if (result.status === 200) {
      return {
        ok: true,
        message: "Documentos gerados.",
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
        `[generate-document] generateDocument failed with unmapped error code: ${
          JSON.stringify(code)
        } (status ${result.status})`,
      );
    }

    return {
      ok: false,
      step: "confirm",
      message: friendlyMessage ??
        "Erro ao gerar documentos. Por favor, tente novamente.",
    };
  },
};
