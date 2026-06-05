# ADR-0004: Pure Substitution Engine — No Server-Side Computation
Date: 2026-05-18
Status: Accepted

## Context
Lease documents require derived values: date arithmetic (end date = start date + duration), currency amounts written out in full (extenso), prorated values, totals. These could be computed server-side or delegated to the GPT.

## Decision
The backend is a pure substitution engine. It receives a flat key-value payload from the GPT with all values pre-computed and ready to substitute. It does not compute, validate, or transform any values — only replaces `{{placeholder}}` tokens in the document with the provided values.

## Alternatives Considered
- **Server-side computation:** The API receives raw inputs (start date, duration) and computes derived values itself. Rejected because it duplicates logic between the GPT and the backend, requires the backend to understand Brazilian date/currency formatting, and makes the API more complex to test and maintain.
- **Hybrid (some computation server-side):** Rejected for the same reasons — any server-side computation creates ambiguity about where the source of truth lives.

## Consequences
- The backend is simple, fast, and easy to test — substitution logic has no business logic.
- All intelligence lives in the GPT system prompt, which can be updated without deploying code.
- The GPT is responsible for correctness of all derived values — errors in GPT output (wrong date math, wrong extenso) go directly into the document.
- The API validates that all `required: true` placeholders are present in the payload before substituting, catching missing values early.
