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
//
// Dynamic steps:
//   FlowDefinition.steps may be a function (values) => FlowStep[] resolved on
//   every engine entry point (find, next, confirm). This allows the step list to
//   depend on previously collected values (e.g. placeholder-union-driven steps).
//
// Load hook:
//   Each FlowStep may declare an optional async load(values, deps) hook that fires
//   after validate() on the same step succeeds. The hook returns a
//   Record<string, unknown> whose keys are merged into values before resolving the
//   next step. Use this to lazily fetch data needed by subsequent steps without
//   calling the full /context snapshot.

import type {
  ContextPayload,
  EngineResponse,
  WorkflowDeps,
  WorkflowOption,
  WorkflowRequest,
} from "./index.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ExecuteResult =
  | { ok: true; message: string; values?: Record<string, unknown> }
  | { ok: false; step: string; message: string };

export interface FlowStep {
  key: string;
  /** Overrides the step name in responses. Defaults to `ask_{key}`. */
  stepName?: string;
  /** Displayed label in confirm summary. Defaults to `step.key`. */
  label?: string;
  /** Which values key to read for display in confirm summary. Defaults to `step.key`. */
  confirmDisplayKey?: string;
  prompt:
    | string
    | ((values: Record<string, unknown>, context: ContextPayload) => string);
  validate?: (
    input: string,
    values: Record<string, unknown>,
    context: ContextPayload,
  ) => { ok: true; value: unknown } | { ok: false; error: string };
  /**
   * Optional async hook fired after validate() succeeds for this step.
   * The returned record is merged into values before the engine resolves the
   * next step. Use this to lazily fetch data needed by downstream steps
   * (e.g. load the placeholder union after a property is selected).
   *
   * Contract:
   * - Fires exactly once per step, immediately after validate() returns ok.
   * - Receives the *post-validate* values (the step's own key already set).
   * - Must return a plain Record<string, unknown>; keys are shallow-merged into values.
   * - Must not duplicate keys that are FlowStep keys — only carry-through/display data.
   * - Errors thrown here propagate as engine errors and surface to the caller.
   */
  load?: (
    values: Record<string, unknown>,
    deps: WorkflowDeps,
  ) => Promise<Record<string, unknown>>;
  optional?: boolean; // "pular"/"skip" → null
  /** When this returns true the step is skipped automatically (value stays absent in values). */
  skip?: (values: Record<string, unknown>) => boolean;
  options?: (
    values: Record<string, unknown>,
    context: ContextPayload,
  ) => WorkflowOption[];
}

export interface FlowDefinition {
  intent: string;
  confirmationTitle: string;
  /**
   * The step list for this flow.
   *
   * - Static form (backward-compatible): `FlowStep[]` — the same steps are used on
   *   every engine pass. All existing flows (add_tenant, add_property, send_signature,
   *   generate_document) use this form.
   * - Dynamic form: `(values: Record<string, unknown>) => FlowStep[]` — resolved on
   *   every engine entry point (find, next, confirm). Enables flows whose step list
   *   depends on previously collected values (e.g. a variable-length placeholder
   *   collection phase). The function must be pure and fast — it is called multiple
   *   times per turn.
   */
  steps: FlowStep[] | ((values: Record<string, unknown>) => FlowStep[]);
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

/**
 * Resolve the step list from a FlowDefinition.
 * Handles both the static (FlowStep[]) and dynamic ((values) => FlowStep[]) forms.
 * Called on every engine entry point so that dynamic flows can change the step set
 * between turns as values are collected.
 *
 * Exported so that callers (e.g. unit tests inspecting intent definitions) can
 * resolve the step list without type-narrowing the union themselves.
 */
export function resolveFlowSteps(
  def: FlowDefinition,
  values: Record<string, unknown> = {},
): FlowStep[] {
  return typeof def.steps === "function" ? def.steps(values) : def.steps;
}

// Internal alias — avoids passing an unused `values` arg at every call site inside
// the engine where `values` is always available.
function resolveSteps(
  def: FlowDefinition,
  values: Record<string, unknown>,
): FlowStep[] {
  return resolveFlowSteps(def, values);
}

/** Find the first step whose key is not yet present in values and is not skipped. */
function findPendingStep(
  steps: FlowStep[],
  values: Record<string, unknown>,
): FlowStep | undefined {
  return steps.find((s) => !(s.key in values) && !s.skip?.(values));
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

  // Only include data steps (not display-only and not skipped), in order.
  for (const step of steps) {
    if (isDisplayOnly(step.key)) continue;
    if (step.skip?.(values)) continue;
    const displayKey = step.confirmDisplayKey ?? step.key;
    const label = step.label ?? step.key;
    const val = values[displayKey];
    const display = val === null || val === undefined
      ? "(não informado)"
      : String(val);
    lines.push(`- ${label}: ${display}`);
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
): Promise<EngineResponse> {
  const intent = def.intent;
  const values: Record<string, unknown> = req.values ?? {};
  const message = (req.message ?? "").trim();

  // Resolve steps dynamically on every engine entry — handles both static arrays
  // and dynamic (values) => FlowStep[] functions.
  const steps = resolveSteps(def, values);
  const pending = findPendingStep(steps, values);

  // ── Collect phase ──────────────────────────────────────────────────────────
  if (pending) {
    const options = resolveOptions(pending, values, context);
    const promptText = resolvePrompt(pending, values, context);

    // The options array carries the list — no need to append labels to the prompt.
    const fullPrompt = promptText;

    // If this is the very first call (Enter phase — no message yet), just ask
    // the prompt. The handler passes message: "" when state is absent (Enter
    // phase), so the engine knows not to validate anything.
    const isFirstPrompt = !message;

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
        const skippedValues = { ...values, [pending.key]: null };
        // Re-resolve steps after skip (dynamic flows may change the set).
        const nextSteps = resolveSteps(def, skippedValues);
        const nextPending = findPendingStep(nextSteps, skippedValues);
        return nextStep(def, intent, skippedValues, nextPending, context);
      }
    }

    // Validate input.
    if (pending.validate) {
      const result = pending.validate(message, values, context);
      if (!result.ok) {
        // Re-ask with error prepended.
        const errorPrompt = `${result.error}\n${fullPrompt}`;
        return {
          message: errorPrompt,
          intent,
          values,
          step: stepName(pending),
          ...(options ? { options } : {}),
        };
      }
      // Valid — store the validated value.
      let updatedValues = { ...values, [pending.key]: result.value };

      // Fire load hook if declared on this step.
      if (pending.load) {
        const loaded = await pending.load(updatedValues, deps);
        updatedValues = { ...updatedValues, ...loaded };
      }

      // Re-resolve steps after the value (and any load data) is recorded.
      const nextSteps = resolveSteps(def, updatedValues);
      const nextPending = findPendingStep(nextSteps, updatedValues);
      return nextStep(def, intent, updatedValues, nextPending, context);
    }

    // No validator — store raw and advance.
    let rawValues = { ...values, [pending.key]: message };

    // Fire load hook even when there is no validator.
    if (pending.load) {
      const loaded = await pending.load(rawValues, deps);
      rawValues = { ...rawValues, ...loaded };
    }

    // Re-resolve steps after storing the raw value and any load data.
    const nextStepsRaw = resolveSteps(def, rawValues);
    const nextPendingRaw = findPendingStep(nextStepsRaw, rawValues);
    return nextStep(def, intent, rawValues, nextPendingRaw, context);
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
): EngineResponse {
  if (nextPending) {
    const options = resolveOptions(nextPending, values, context);
    const promptText = resolvePrompt(nextPending, values, context);
    return {
      message: promptText,
      intent,
      values,
      step: stepName(nextPending),
      ...(options ? { options } : {}),
    };
  }

  // All steps collected — show confirmation.
  // Re-resolve steps with the current values so dynamic flows produce the correct
  // summary (includes all steps that were active when values were collected).
  const resolvedSteps = resolveSteps(def, values);
  const confirmMsg = buildConfirmationMessage(def, values, resolvedSteps);
  return {
    message: confirmMsg,
    intent,
    values,
    step: "confirm",
  };
}
