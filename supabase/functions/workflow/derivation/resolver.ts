// Topological resolver for derived placeholder values.
//
// Resolution order (per spec §4):
//   1. Build the placeholder union for (property_type, use_case).
//   2. Topologically sort by sibling dependencies.
//   3. Resolve asked values from collected input.
//   4. Resolve context paths from lazily loaded entity data.
//   5. Call registry functions for derived placeholders.
//   6. Apply `default` for anything still empty.
//
// Errors (structured, never silent):
//   UNKNOWN_FORMULA       — formula references a function not in the registry
//   UNRESOLVABLE_INPUT    — a required input (context path or sibling) is missing
//   CIRCULAR_DEPENDENCY   — topological sort found a cycle

import { parseFormula, siblingDeps } from "./parser.ts";
import type { Arg, ParsedFormula } from "./parser.ts";
import { FORMULA_REGISTRY } from "./registry.ts";

// ─── Error types ──────────────────────────────────────────────────────────────

export class DerivationError extends Error {
  constructor(
    public readonly code:
      | "UNKNOWN_FORMULA"
      | "UNRESOLVABLE_INPUT"
      | "CIRCULAR_DEPENDENCY",
    message: string,
  ) {
    super(message);
    this.name = "DerivationError";
  }
}

// ─── Input types ──────────────────────────────────────────────────────────────

/** A single placeholder descriptor (subset of the full DB row). */
export type PlaceholderDescriptor = {
  name: string;
  derived_formula: string | null;
  default: string | null;
};

/**
 * Context data loaded lazily by the flow.
 * Keys are namespace names (e.g. "tenant", "property"); values are
 * flat records of field → string.
 */
export type ContextData = Record<string, Record<string, string>>;

/**
 * Collected values from the user (asked placeholders).
 * Key = placeholder name, value = user-supplied string.
 */
export type CollectedValues = Record<string, string>;

// ─── Topological sort ─────────────────────────────────────────────────────────

/**
 * Topologically sort placeholder names by their sibling dependencies.
 * Returns names in resolution order (dependencies before dependents).
 * Throws DerivationError(CIRCULAR_DEPENDENCY) if a cycle is detected.
 */
export function topoSort(
  placeholders: PlaceholderDescriptor[],
): PlaceholderDescriptor[] {
  const nameToDescriptor = new Map<string, PlaceholderDescriptor>();
  for (const p of placeholders) {
    nameToDescriptor.set(p.name, p);
  }

  const parsed = new Map<string, ParsedFormula>();
  for (const p of placeholders) {
    parsed.set(p.name, parseFormula(p.derived_formula));
  }

  // Kahn's algorithm
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>(); // name → dependents

  for (const p of placeholders) {
    if (!inDegree.has(p.name)) inDegree.set(p.name, 0);
    if (!adjacency.has(p.name)) adjacency.set(p.name, []);
  }

  for (const p of placeholders) {
    const formula = parsed.get(p.name)!;
    const deps = siblingDeps(formula);
    for (const dep of deps) {
      if (!nameToDescriptor.has(dep)) {
        // Unknown sibling — will be caught during resolution; skip for sort.
        continue;
      }
      // dep must come before p.name
      adjacency.get(dep)!.push(p.name);
      inDegree.set(p.name, (inDegree.get(p.name) ?? 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const [name, degree] of inDegree) {
    if (degree === 0) queue.push(name);
  }

  const sorted: PlaceholderDescriptor[] = [];
  while (queue.length > 0) {
    const name = queue.shift()!;
    sorted.push(nameToDescriptor.get(name)!);
    for (const dependent of adjacency.get(name) ?? []) {
      const newDegree = (inDegree.get(dependent) ?? 0) - 1;
      inDegree.set(dependent, newDegree);
      if (newDegree === 0) queue.push(dependent);
    }
  }

  if (sorted.length !== placeholders.length) {
    // Find cycles for a better error message
    const remaining = placeholders
      .filter((p) => !sorted.find((s) => s.name === p.name))
      .map((p) => p.name);
    throw new DerivationError(
      "CIRCULAR_DEPENDENCY",
      `Circular dependency detected among placeholders: ${
        remaining.join(", ")
      }`,
    );
  }

  return sorted;
}

// ─── Arg resolver ─────────────────────────────────────────────────────────────

function resolveArg(
  arg: Arg,
  resolvedValues: Map<string, string>,
  contextData: ContextData,
  formulaStr: string,
): string {
  if (arg.kind === "context_path") {
    const ns = contextData[arg.namespace];
    if (ns === undefined) {
      throw new DerivationError(
        "UNRESOLVABLE_INPUT",
        `Unresolvable input: context namespace '${arg.namespace}' not found (formula: ${formulaStr})`,
      );
    }
    const value = ns[arg.field];
    if (value === undefined || value === null) {
      throw new DerivationError(
        "UNRESOLVABLE_INPUT",
        `Unresolvable input: context path '${arg.namespace}.${arg.field}' not found (formula: ${formulaStr})`,
      );
    }
    return value;
  }

  // sibling ref
  const value = resolvedValues.get(arg.name);
  if (value === undefined) {
    throw new DerivationError(
      "UNRESOLVABLE_INPUT",
      `Unresolvable input: sibling placeholder '${arg.name}' has no resolved value (formula: ${formulaStr})`,
    );
  }
  return value;
}

// ─── Main resolver ────────────────────────────────────────────────────────────

/**
 * Resolve all placeholder values in topological order.
 *
 * @param placeholders  — Ordered placeholder descriptors (will be topo-sorted internally).
 * @param collected     — User-supplied values for asked placeholders.
 * @param contextData   — Lazily loaded entity data keyed by namespace.
 * @returns A Map from placeholder name to resolved string value.
 *
 * Throws DerivationError on UNKNOWN_FORMULA, UNRESOLVABLE_INPUT, or CIRCULAR_DEPENDENCY.
 */
export function resolvePlaceholders(
  placeholders: PlaceholderDescriptor[],
  collected: CollectedValues,
  contextData: ContextData,
): Map<string, string> {
  const sorted = topoSort(placeholders);
  const resolved = new Map<string, string>();

  for (const descriptor of sorted) {
    const formula = parseFormula(descriptor.derived_formula);

    if (formula.kind === "asked") {
      // Asked: use collected value, then default.
      const userValue = collected[descriptor.name];
      if (userValue !== undefined && userValue !== "") {
        resolved.set(descriptor.name, userValue);
      } else if (descriptor.default !== null && descriptor.default !== "") {
        resolved.set(descriptor.name, descriptor.default);
      } else {
        // No value and no default — leave as empty string.
        resolved.set(descriptor.name, "");
      }
      continue;
    }

    if (formula.kind === "sibling") {
      // Bare sibling ref — identity copy.
      const formulaStr = descriptor.derived_formula ?? formula.name;
      const value = resolvedValues_get(resolved, formula.name, formulaStr);
      resolved.set(descriptor.name, value);
      continue;
    }

    if (formula.kind === "context_path") {
      // Bare context path — identity copy.
      const formulaStr = descriptor.derived_formula ??
        `${formula.namespace}.${formula.field}`;
      const ns = contextData[formula.namespace];
      if (ns === undefined) {
        throw new DerivationError(
          "UNRESOLVABLE_INPUT",
          `Unresolvable input: context namespace '${formula.namespace}' not found (formula: ${formulaStr})`,
        );
      }
      const value = ns[formula.field];
      if (value === undefined || value === null) {
        // Fall back to default if present
        if (descriptor.default !== null && descriptor.default !== "") {
          resolved.set(descriptor.name, descriptor.default);
        } else {
          throw new DerivationError(
            "UNRESOLVABLE_INPUT",
            `Unresolvable input: context path '${formula.namespace}.${formula.field}' not found (formula: ${formulaStr})`,
          );
        }
      } else {
        resolved.set(descriptor.name, value);
      }
      continue;
    }

    if (formula.kind === "fn_call") {
      // Registry function call.
      const spec = FORMULA_REGISTRY.get(formula.fn);
      if (spec === undefined) {
        throw new DerivationError(
          "UNKNOWN_FORMULA",
          `Unknown formula function '${formula.fn}' — not in the closed registry`,
        );
      }

      const formulaStr = descriptor.derived_formula ?? formula.fn;

      // Resolve args
      const argValues: string[] = formula.args.map((arg) =>
        resolveArg(arg, resolved, contextData, formulaStr)
      );

      // Arity check
      if (argValues.length !== spec.arity) {
        throw new DerivationError(
          "UNRESOLVABLE_INPUT",
          `Arity mismatch for '${formula.fn}': expected ${spec.arity} arg(s), got ${argValues.length}`,
        );
      }

      const result = spec.fn(...argValues);
      resolved.set(descriptor.name, result);
      continue;
    }
  }

  return resolved;
}

// ─── Internal helper ──────────────────────────────────────────────────────────

function resolvedValues_get(
  resolved: Map<string, string>,
  name: string,
  formulaStr: string,
): string {
  const value = resolved.get(name);
  if (value === undefined) {
    throw new DerivationError(
      "UNRESOLVABLE_INPUT",
      `Unresolvable input: sibling placeholder '${name}' has no resolved value (formula: ${formulaStr})`,
    );
  }
  return value;
}
