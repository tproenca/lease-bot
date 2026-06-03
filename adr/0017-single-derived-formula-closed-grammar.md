# ADR-0017: Single `derived_formula` Column with Closed Grammar
Date: 2026-06-03
Status: Accepted

## Context

The `placeholders` table has two columns related to derivation:
- `derived_from text nullable` — stores the name of a source placeholder (identity copy)
- `derived_formula text nullable` — stores a human-readable formula description intended
  for the GPT to interpret

Both columns are populated by the template sync flow and echoed in `GET /context`. Neither
is evaluated server-side — values are never computed from them. The `derived_from` column
was introduced for simple identity copies; `derived_formula` was added for more complex
cases but remained a free-text description with no grammar or validation.

Problems:
1. Two columns for one concept — which is authoritative when both are set?
2. `derived_formula` as free text is unvalidatable and unparseable server-side.
3. `derived_from` is redundant once `derived_formula` supports identity copies.
4. Neither column is evaluated — the data is stored but never acted on (gap G5).

With ADR-0016 (deterministic derivation engine), `derived_formula` must be parseable
by the server. A closed grammar is required.

## Decision

Drop `derived_from`. Keep `derived_formula` as a single closed-grammar expression.

**Grammar:**
- `null` — asked; collect from the landlord (numbered list if `options[]` is set).
- A **bare token** — identity copy of that source. Disambiguation: a dotted token with
  a namespace prefix ∈ `{tenant, property, landlord, building}` is a context path;
  otherwise it is a sibling placeholder name.
- `fn(arg1, arg2, …)` — apply registry function `fn` to the resolved args. Each arg
  is a context path or a sibling placeholder name.

**Registry (initial closed set):** `identity`, `cpf_format`, `amount_in_words`,
`full_date_text`, `end_date`. All entries declared in ADR-0016.

**Config-time validation at `POST /placeholders`:** a stored `derived_formula` must
reference only known registry functions and resolvable inputs (known context paths or
existing sibling placeholder names). Invalid expressions are rejected with 400.

**Config UX (Option B — menu-driven):** during template sync (Flow 2), the landlord
picks a derivation type from a numbered list of registry functions and picks input
fields from existing placeholders or context fields. They never type a formula
expression. An unsupported derivation → the field is treated as asked. Because
config is menu-driven, syntactically invalid expressions are unconstructable by the
landlord; the endpoint still validates defensively.

**Migration:** drop the `derived_from` column. Any existing row with `derived_from` set
and `derived_formula` null is migrated by writing `derived_formula = derived_from` (bare
token identity copy). After migration, `derived_from` is removed from the schema.

The `buildPlaceholderList…` function in `google.ts` (renders the "Lista de Placeholders"
Google Doc) currently renders a `derived_from` column. After migration it must derive
that display by parsing `derived_formula`.

## Alternatives Considered

**Keep both columns:** Rejected. Two-column ambiguity creates a maintenance burden and
makes the derivation engine's parsing logic ambiguous. One column is unambiguous.

**Keep `derived_from` as a shorthand for identity copies:** Rejected. The bare-token
grammar already handles identity copies. Adding a special case for `derived_from` adds
parser complexity for no benefit.

**Free-text `derived_formula` (status quo), GPT interprets it:** Rejected. Rejected by
ADR-0016 — GPT must not be in the value pipeline.

**Arbitrary expression DSL (arithmetic, string ops):** Rejected. See ADR-0016. Deferred
to a future ADR if a specific formula need arises.

## Consequences

- Single source of truth for derivation configuration.
- The server can parse and validate `derived_formula` at write time; invalid expressions
  never reach the derivation engine at runtime.
- One migration required: drop `derived_from` column; backfill `derived_formula` for
  any rows using `derived_from` only.
- `google.ts` `buildPlaceholderList…` must be updated to parse `derived_formula`.
- `GET /context` and `POST /placeholders` no longer include `derived_from`.
- Adding a new formula type is a deliberate code change (new registry entry + new ADR),
  not a config change. This prevents formula proliferation.
