# ADR-0016: Deterministic Derivation Over GPT
Date: 2026-06-03
Status: Accepted

## Context

Lease documents require derived values: end date (start + duration in months), rent
amount in full Portuguese text (*por extenso*), formatted CPF (`XXX.XXX.XXX-XX`), and
full date text ("DD de mês de AAAA"). These values appear verbatim in legally binding
documents.

Prior to this decision, the system relied on the GPT to compute all derived values
before calling `POST /documents/generate` (ADR-0004: pure substitution engine). The
triggering failure was `generate` silently producing a generic error because the GPT
had not supplied required placeholder values — value assembly was implicitly delegated
to the GPT with no server-side enforcement or reproducibility guarantees.

Legal documents demand correctness, reproducibility, and auditability. A wrong amount
in words or an off-by-one end date is a document defect with real-world consequences.
GPT output for value computation is non-deterministic across model versions and
conversation contexts, cannot be reliably audited, and reintroduces the failure mode
that motivated this redesign.

## Decision

Derived placeholder values are computed by a deterministic server-side formula registry
in the workflow layer. GPT is not involved in value computation.

The formula registry is a closed, versioned set of pure functions. Each function
declares its input arity and types and is covered by unit tests. The initial set:

| Function | Inputs | Output |
|---|---|---|
| `identity` | any context path | Identity copy |
| `cpf_format` | CPF digits string | `XXX.XXX.XXX-XX` |
| `amount_in_words` | numeric amount | PT extenso |
| `full_date_text` | date | "DD de mês de AAAA" |
| `end_date` | start date, duration in months | ISO date |

The derivation engine runs inside the `generate_document` flow, after all asked values
are collected and before the confirm table is shown. `POST /documents/generate` remains
a pure substitution endpoint — it receives a fully-resolved `placeholders` map and
substitutes tokens only. The resolve-then-substitute split is retained from ADR-0004;
this ADR moves the "resolve" responsibility from the GPT to the server.

The landlord reviews all resolved values (asked + derived + context-auto-filled +
defaulted) in a confirm table before generation. This provides an auditable checkpoint.

## Alternatives Considered

**GPT computes derived values (status quo):** Rejected. Non-deterministic across model
versions; no server-side enforcement; silent wrong output goes directly into legal
documents; the triggering failure of this redesign.

**Hybrid (GPT for some, server for others):** Rejected. Creates ambiguity about where
the source of truth lives; any GPT-computed value that lands in a document inherits all
the auditability problems of the pure-GPT approach.

**Arbitrary server-side expression engine (arithmetic/string DSL):** Rejected for the
initial set. A closed registry of well-tested functions provides all the derivations
needed. Arbitrary expressions require a parser, a type system, and significantly more
testing surface. Deferred — if a new formula is genuinely needed, it is added as a
code change with a new ADR.

## Consequences

- Derived values are reproducible and auditable: the same inputs always produce the
  same output, regardless of GPT model version or conversation state.
- The formula registry is a code boundary: adding a formula requires a deliberate code
  change and a new ADR. This prevents ad-hoc derivation logic from accumulating.
- Unit tests per formula are required before merge; the derivation engine target is 95%
  line coverage.
- `amount_in_words` must implement correct Brazilian Portuguese extenso formatting
  (including gender agreement for "real"/"reais" and edge cases for zero, hundreds,
  thousands). This is deterministic but non-trivial; test cases must cover boundary
  values.
- The `gpt/SYSTEM_PROMPT.md` no longer instructs the GPT to compute derived values.
  The GPT's role in value collection is collecting asked inputs and relaying the confirm
  table — not computation.
- Supersedes the derivation-responsibility clause of ADR-0004 (pure substitution engine).
  ADR-0004's core principle — `POST /documents/generate` is a pure substitution endpoint
  — is retained and strengthened.
