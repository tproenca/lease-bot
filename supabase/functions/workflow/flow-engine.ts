// Generic flow engine — drives any FlowDefinition through collect → confirm → execute.
//
// The engine is stateless: the caller passes the full values map (echoed back by
// the GPT each turn) and the current user message. The engine advances the flow
// by inspecting which keys are already present in values.
//
// Step naming:
//   ask_{step.key}  — waiting for the user to supply that step's value
//   confirm         — all steps collected; awaiting "Sim"
//   done            — execute() succeeded

import type {
  ContextPayload,
  WorkflowDeps,
  WorkflowOption,
  WorkflowRequest,
  WorkflowResponse,
} from "./index.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ExecuteResult =
  | { ok: true; message: string; values?: Record<string, unknown> }
  | { ok: false; step: string; message: string };

export interface FlowStep {
  key: string;
  /** Overrides the step name in responses. Defaults to `ask_{key}`. */
  stepName?: string;
  prompt:
    | string
    | ((values: Record<string, unknown>, context: ContextPayload) => string);
  validate?: (
    input: string,
    values: Record<string, unknown>,
    context: ContextPayload,
  ) => { ok: true; value: unknown } | { ok: false; error: string };
  optional?: boolean; // "pular"/"skip" → null
  options?: (
    values: Record<string, unknown>,
    context: ContextPayload,
  ) => WorkflowOption[];
}

export interface FlowDefinition {
  intent: string;
  confirmationTitle: string;
  steps: FlowStep[];
  execute: (
    values: Record<string, unknown>,
    jwt: string,
    deps: WorkflowDeps,
  ) => Promise<ExecuteResult>;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Keys that the engine manages internally — stripped before execute() and confirmation display. */
const ENGINE_KEYS = new Set(["_confirmed"]);

/** Returns true for display-only keys: _-prefixed or property_name convention. */
function isDisplayOnly(key: string): boolean {
  return key.startsWith("_") || key === "property_name";
}

/** Strip display-only and engine-private keys from values before execute(). */
function stripInternalKeys(
  values: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).filter(([k]) =>
      !isDisplayOnly(k) && !ENGINE_KEYS.has(k)
    ),
  );
}

/** Find the first step whose key is not yet present in values. */
function findPendingStep(
  steps: FlowStep[],
  values: Record<string, unknown>,
): FlowStep | undefined {
  return steps.find((s) => !(s.key in values));
}

/** Build the step string for a given step. */
function stepName(step: FlowStep): string {
  return step.stepName ? `ask_${step.stepName}` : `ask_${step.key}`;
}

/** Resolve the prompt string (handles string | function). */
function resolvePrompt(
  step: FlowStep,
  values: Record<string, unknown>,
  context: ContextPayload,
): string {
  return typeof step.prompt === "function"
    ? step.prompt(values, context)
    : step.prompt;
}

/** Build options for the current step, appended to the prompt. */
function resolveOptions(
  step: FlowStep,
  values: Record<string, unknown>,
  context: ContextPayload,
): WorkflowOption[] | undefined {
  return step.options ? step.options(values, context) : undefined;
}

/** Build confirmation message from current values (display-only and engine keys excluded). */
function buildConfirmationMessage(
  def: FlowDefinition,
  values: Record<string, unknown>,
  steps: FlowStep[],
): string {
  const lines: string[] = [`**${def.confirmationTitle}**`];

  // Only include data steps (not display-only), in order.
  for (const step of steps) {
    if (isDisplayOnly(step.key)) continue;
    const val = values[step.key];
    const display = val === null || val === undefined
      ? "(não informado)"
      : String(val);
    lines.push(`- ${step.key}: ${display}`);
  }
  lines.push("");
  lines.push("Confirma? (Sim para continuar)");
  return lines.join("\n");
}

// ─── Engine ───────────────────────────────────────────────────────────────────

export async function runFlowEngine(
  def: FlowDefinition,
  req: WorkflowRequest,
  context: ContextPayload,
  deps: WorkflowDeps,
  jwt: string,
): Promise<WorkflowResponse> {
  const intent = def.intent;
  const values: Record<string, unknown> = req.values ?? {};
  const message = (req.message ?? "").trim();

  const pending = findPendingStep(def.steps, values);

  // ── Collect phase ──────────────────────────────────────────────────────────
  if (pending) {
    const options = resolveOptions(pending, values, context);
    const promptText = resolvePrompt(pending, values, context);

    // Build prompt with options list appended (same pattern as original machine)
    let fullPrompt = promptText;
    if (options && options.length > 0) {
      const optionsList = options.map((o) => o.label).join("\n");
      fullPrompt = `${promptText}\n${optionsList}`;
    }

    // If this is the very first call (no message yet or the initial routing
    // message that equals the intent name), just ask the prompt.
    // The intent router already confirmed the user selected this flow.
    // We treat an empty message or intent-name echo as "no answer yet".
    const isFirstPrompt = !message || message === intent;

    if (isFirstPrompt) {
      return {
        message: fullPrompt,
        intent,
        values,
        step: stepName(pending),
        ...(options ? { options } : {}),
      };
    }

    // Handle optional skip.
    if (pending.optional) {
      const lower = message.toLowerCase();
      if (lower === "pular" || lower === "skip" || lower === "pular") {
        const updatedValues = { ...values, [pending.key]: null };
        const nextPending = findPendingStep(def.steps, updatedValues);
        return nextStep(def, intent, updatedValues, nextPending, context);
      }
    }

    // Validate input.
    if (pending.validate) {
      const result = pending.validate(message, values, context);
      if (!result.ok) {
        // Re-ask with error prepended.
        let errorPrompt = `${result.error}\n${fullPrompt}`;
        if (options && options.length > 0) {
          // prompt already has options, just prepend error
          errorPrompt = `${result.error}\n${fullPrompt}`;
        }
        return {
          message: errorPrompt,
          intent,
          values,
          step: stepName(pending),
          ...(options ? { options } : {}),
        };
      }
      // Valid — store and advance.
      const updatedValues = { ...values, [pending.key]: result.value };
      const nextPending = findPendingStep(def.steps, updatedValues);
      return nextStep(def, intent, updatedValues, nextPending, context);
    }

    // No validator — store raw and advance.
    const updatedValues = { ...values, [pending.key]: message };
    const nextPending = findPendingStep(def.steps, updatedValues);
    return nextStep(def, intent, updatedValues, nextPending, context);
  }

  // ── Confirmation phase ────────────────────────────────────────────────────
  if (!("_confirmed" in values)) {
    // We're at the confirm step — user just replied.
    if (message !== "Sim") {
      return {
        message: "O que deseja alterar?",
        intent,
        values,
        step: "confirm",
      };
    }

    // "Sim" — execute.
    const cleanValues = stripInternalKeys(values);
    let result: ExecuteResult;
    try {
      result = await def.execute(cleanValues, jwt, deps);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        message: `Erro ao processar: ${msg}`,
        intent,
        values,
        step: "confirm",
      };
    }

    if (!result.ok) {
      return {
        message: result.message,
        intent,
        values,
        step: result.step,
      };
    }

    const doneValues: Record<string, unknown> = { ...values, _confirmed: true };
    if (result.values) {
      Object.assign(doneValues, result.values);
    }
    return {
      message: result.message,
      intent,
      values: doneValues,
      step: "done",
    };
  }

  // Already done — return done state.
  return {
    message: "Fluxo já concluído.",
    intent,
    values,
    step: "done",
  };
}

// ─── Internal: advance to next step or show confirmation ──────────────────────

function nextStep(
  def: FlowDefinition,
  intent: string,
  values: Record<string, unknown>,
  nextPending: FlowStep | undefined,
  context: ContextPayload,
): WorkflowResponse {
  if (nextPending) {
    const options = resolveOptions(nextPending, values, context);
    const promptText = resolvePrompt(nextPending, values, context);
    let fullPrompt = promptText;
    if (options && options.length > 0) {
      const optionsList = options.map((o) => o.label).join("\n");
      fullPrompt = `${promptText}\n${optionsList}`;
    }
    return {
      message: fullPrompt,
      intent,
      values,
      step: stepName(nextPending),
      ...(options ? { options } : {}),
    };
  }

  // All steps collected — show confirmation.
  const confirmMsg = buildConfirmationMessage(def, values, def.steps);
  return {
    message: confirmMsg,
    intent,
    values,
    step: "confirm",
  };
}
