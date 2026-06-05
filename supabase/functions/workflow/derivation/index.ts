// Public API for the derivation engine.
//
// Consumers (e.g. generate_document flow) import from this file.

export { CONTEXT_NAMESPACES, parseFormula, siblingDeps } from "./parser.ts";
export type {
  Arg,
  ContextPath,
  FnCall,
  ParsedFormula,
  SiblingRef,
} from "./parser.ts";

export { amountInWords, FORMULA_REGISTRY } from "./registry.ts";
export type { FormulaSpec } from "./registry.ts";

export { DerivationError, resolvePlaceholders, topoSort } from "./resolver.ts";
export type {
  CollectedValues,
  ContextData,
  PlaceholderDescriptor,
} from "./resolver.ts";
