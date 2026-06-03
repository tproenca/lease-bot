// ADD_PROPERTY FlowDefinition — collects property type, building or address, and name, then creates a property.
//
// Flow steps:
//   ask_type      → select: Apartamento / Casa / Sala comercial
//   ask_building  → (apartment only) select from ctx.buildings
//   ask_address   → (house/office unit only) free text
//   ask_name      → free text (property name / identifier)
//   confirm       → summary + "Sim para confirmar"
//   done          → "Imóvel adicionado." → menu

import { ERROR_MAP } from "../../_shared/error-map.ts";
import type { ContextPayload, WorkflowOption } from "../index.ts";
import type { ExecuteResult, FlowDefinition } from "../flow-engine.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

type Building = { id: string; name: string; address: string };

function getBuildings(ctx: ContextPayload): Building[] {
  return (ctx.buildings ?? []) as Building[];
}

// ─── ADD_PROPERTY flow definition ────────────────────────────────────────────

export const ADD_PROPERTY: FlowDefinition = {
  intent: "add_property",
  confirmationTitle: "Novo imóvel",
  steps: [
    // Step 1: Property type
    {
      key: "type",
      label: "Tipo",
      prompt: "Qual é o tipo do imóvel?",
      options: (): WorkflowOption[] => [
        { label: "1. Apartamento", value: "apartment" },
        { label: "2. Casa", value: "house" },
        { label: "3. Sala comercial", value: "office_unit" },
      ],
      validate: (input: string) => {
        const trimmed = input.trim().toLowerCase();
        const byValue: Record<string, string> = {
          apartment: "apartment",
          house: "house",
          office_unit: "office_unit",
          "office unit": "office_unit",
          apartamento: "apartment",
          casa: "house",
          comercial: "office_unit",
          "sala comercial": "office_unit",
        };
        // Accept numeric selection
        const byNumber: Record<string, string> = {
          "1": "apartment",
          "2": "house",
          "3": "office_unit",
        };
        const resolved = byNumber[trimmed] ?? byValue[trimmed];
        if (!resolved) {
          return {
            ok: false,
            error:
              "Tipo inválido. Escolha 1 (Apartamento), 2 (Casa) ou 3 (Sala comercial):",
          };
        }
        return { ok: true, value: resolved };
      },
    },

    // Step 2: Building selection (apartment only — skipped for house/office unit)
    {
      key: "building_id",
      stepName: "building",
      label: "Edifício",
      confirmDisplayKey: "_building_name",
      prompt: (
        _values: Record<string, unknown>,
        ctx: ContextPayload,
      ): string => {
        const buildings = getBuildings(ctx);
        if (buildings.length === 0) {
          return "Nenhum edifício cadastrado. Cadastre um edifício primeiro.";
        }
        return "Em qual edifício fica o apartamento?";
      },
      options: (
        _values: Record<string, unknown>,
        ctx: ContextPayload,
      ): WorkflowOption[] => {
        return getBuildings(ctx).map((b, i) => ({
          label: `${i + 1}. ${b.name}`,
          value: b.id,
        }));
      },
      skip: (values: Record<string, unknown>): boolean => {
        return values.type !== "apartment";
      },
      validate: (
        input: string,
        values: Record<string, unknown>,
        ctx: ContextPayload,
      ) => {
        const buildings = getBuildings(ctx);
        const trimmed = input.trim();
        const asNumber = parseInt(trimmed, 10);
        let selected: Building | undefined;

        if (!isNaN(asNumber) && asNumber >= 1 && asNumber <= buildings.length) {
          selected = buildings[asNumber - 1];
        } else {
          selected = buildings.find((b) => b.id === trimmed);
        }

        if (!selected) {
          return {
            ok: false,
            error: "Não entendi. Por favor, escolha o número do edifício:",
          };
        }

        // Store building name as a display-only side value.
        // deno-lint-ignore no-explicit-any
        (values as any)._building_name = selected.name;

        return { ok: true, value: selected.id };
      },
    },

    // Step 3: Address (house/office unit only — skipped for apartment)
    {
      key: "address",
      label: "Endereço",
      prompt: "Qual é o endereço do imóvel?",
      skip: (values: Record<string, unknown>): boolean => {
        return values.type === "apartment";
      },
      validate: (input: string) => {
        const trimmed = input.trim();
        return trimmed.length > 0
          ? { ok: true, value: trimmed }
          : { ok: false, error: "Endereço não pode ser vazio." };
      },
    },

    // Step 4: Property name / identifier
    {
      key: "name",
      label: "Nome / identificador",
      prompt:
        "Qual é o nome ou identificador do imóvel? (ex: Apto 101, Casa dos fundos)",
      validate: (input: string) => {
        const trimmed = input.trim();
        return trimmed.length > 0
          ? { ok: true, value: trimmed }
          : { ok: false, error: "Nome não pode ser vazio." };
      },
    },
  ],

  execute: async (values, jwt, deps): Promise<ExecuteResult> => {
    const result = await deps.createProperty(jwt, {
      type: values.type as string,
      name: values.name as string,
      building_id: (values.building_id as string | null | undefined) ?? null,
      address: (values.address as string | null | undefined) ?? null,
    });

    if (result.status === 201) {
      return {
        ok: true,
        message: "Imóvel adicionado.",
        values: {
          property_id: (result.body as Record<string, unknown>).id,
          drive_folder_id:
            (result.body as Record<string, unknown>).drive_folder_id,
        },
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
        `[add-property] createProperty failed with unmapped error code: ${
          JSON.stringify(code)
        } (status ${result.status})`,
      );
    }
    return {
      ok: false,
      step: "confirm",
      message: friendlyMessage ??
        "Erro ao criar imóvel. Por favor, tente novamente.",
    };
  },
};
