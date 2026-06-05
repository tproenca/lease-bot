# ADR-0020: Deterministic Derivation Engine — Closed Formula Registry and Grammar Parser
Date: 2026-06-04
Status: Accepted

## Context

Placeholder values in generated lease documents must be reproducible and auditable. The existing codebase had no derivation engine — `derived_formula` was stored in the database but never evaluated. Values that should be deterministic (CPF formatting, amounts in words, date calculations, end-date computation) were either left blank or delegated to GPT, which is non-deterministic.

ADR-0016 (deterministic derivation over GPT) and ADR-0017 (single `derived_formula` closed grammar) established the policy. This ADR documents the implementation decisions for the engine itself: the grammar parser, the registry structure, and the topological resolver.

## Decision

Implement a deterministic server-side derivation engine in `workflow/derivation/` with three components:

1. **Closed-grammar recursive-descent parser** (`parser.ts`): parses `derived_formula` strings into an AST. Grammar handles: `null` (asked), bare context paths (`tenant.name`), bare sibling references (`valor_aluguel`), and function calls (`cpf_format(tenant.cpf)`, `end_date(data_inicio, duracao_meses)`). Disambiguation: a dotted token whose first segment is a known namespace (`tenant`, `property`, `landlord`, `building`) is a context path; otherwise it is a sibling placeholder name.

2. **Closed formula registry** (`registry.ts`): a `Map<string, FormulaSpec>` keyed by function name. Each entry declares arity and a deterministic implementation. Initial set: `identity`, `cpf_format`, `amount_in_words`, `full_date_text`, `end_date`. The `amount_in_words` function is a fully deterministic Portuguese *por extenso* implementation with no external dependencies. Adding a formula requires a code change and a new ADR.

3. **Topological resolver** (`resolver.ts`): uses Kahn's algorithm to sort placeholders by sibling dependency order, then resolves each in order: asked → context path → formula call. Raises structured `DerivationError` with codes `UNKNOWN_FORMULA`, `UNRESOLVABLE_INPUT`, and `CIRCULAR_DEPENDENCY`.

## Alternatives Considered

- **GPT-based derivation**: rejected (ADR-0016). Non-deterministic, not auditable, not reproducible for legal documents.
- **Arbitrary expression DSL** (arithmetic, string ops): deferred. Only the closed registry is supported; anything outside the registry becomes an *asked* field or a new registry entry (code + ADR). Prevents formula injection and keeps the surface area small.
- **Eval-based parser**: rejected. Security risk; the closed grammar makes a recursive-descent parser straightforward and safe.
- **Storing pre-resolved values at config time**: rejected. Values depend on tenant/property context loaded at flow time; they can only be resolved at document-generation time.

## Consequences

- `POST /documents/generate` remains a pure substitution endpoint. The derivation engine runs inside the `generate_document` flow before the confirm table, not at the HTTP boundary.
- Adding a new formula is a deliberate code change + ADR — no landlord or GPT can introduce novel formulas at runtime.
- `amount_in_words` is deterministic Portuguese *por extenso*: no GPT, no external service, no locale dependency.
- The topological resolver guarantees sibling dependencies are resolved before their dependents. Circular dependencies are detected at resolution time and surfaced as `CIRCULAR_DEPENDENCY` errors.
- Config-time validation at `POST /placeholders` can use the same parser to reject unknown functions or unresolvable inputs before they are stored.
