# ADR-0021: Identity-Keyed Server-Side Workflow Sessions
Date: 2026-06-06
Status: Accepted

Supersedes the GPT-relayed opaque `state` token from the workflow engine work
(ADR-0018, issue #199). The in-code `FlowDefinition` engine is unchanged; only
the persistence/identity layer changes.

## Context

`POST /workflow/next` is a multi-step slot-filling orchestrator. Today it is
stateless on the backend: the full collected `values` are base64-encoded into an
opaque `state` token that the GPT receives each turn and must echo back verbatim
on the next turn. This has three problems:

1. **The GPT is an unreliable relay.** It must reproduce a growing opaque blob
   exactly. Any corruption or truncation breaks the flow mid-way with no recovery
   path — the backend cannot reconstruct lost state.
2. **PII transits and persists in OpenAI.** Tenant names, CPF, and amounts ride
   inside the `state` blob through ChatGPT and sit in the conversation transcript.
3. **No server-side view of in-flight flows.** There is nothing to audit, resume,
   or debug; abandoned flows are invisible.

The app's actual shape is one authenticated human per landlord taking strictly
serial turns. GPT Actions already send the landlord's Supabase JWT for auth, so
the backend can look up the landlord's single active session by identity without
the GPT carrying anything of ours.

## Decision

Persist flow state server-side in a `flow_sessions` table keyed by
`landlord_id = auth.uid()`. The GPT carries **nothing** — no token, not even a
session id. Each turn the backend resolves the single active session from the
verified JWT.

- **Single endpoint, no split.** `POST /workflow/next` branches on whether an
  active session exists for the JWT: absent → start; present → advance. No
  separate `/start` vs `/step`.
- **Revised envelope.** Request `{ intent, answer, control }`; response carries a
  `status` discriminator (`pending | confirm | complete | chained | error`). The
  `state` field is removed entirely. `control` is `"back" | "menu" | null`; the
  GPT normalizes natural language into it and the backend never parses loose text.
- **Back** restores the previous `resolved_values` snapshot from `history` (not
  just a cursor), which correctly un-resolves derived placeholders.
- **Menu/cancel** tears the session down, confirming first when it holds user data.
- **Intent-switch** auto-parks/replaces when the active flow has no user data, and
  confirms ("quer pausar?") when it does.
- **Idempotency.** A `version` column is bumped on every write; an identical
  consecutive `(step, input)` is absorbed rather than double-applied. This recovers
  most of the replay protection the `state: "sid:step"` cursor gave us, without
  putting anything in the GPT.
- **Expiry.** Sessions carry `expires_at`; an expired lookup resets cleanly
  (re-greets) rather than erroring. A pg_cron job sweeps expired rows.
- **Defense in depth.** RLS scopes `flow_sessions` to the landlord, and every
  query is *also* scoped by `landlord_id` in code.

The in-code `FlowDefinition` engine (`steps`/`validate`/`load`, dynamic steps,
confirm-table edit) is untouched: only `values` moves from the token into a row.

### Schema notes

- The conceptual `values` field is stored as the column `resolved_values` because
  `values` is a reserved SQL keyword; this avoids quoting at every call site and
  matches the foo2 prototype.
- A unique partial index `(landlord_id) where status = 'active'` enforces one
  active session per landlord at the database level.
- Persisted `status` values are `active | confirm | complete | cancelled |
  expired`. `chained` is a transient *response* status only (a completing flow is
  stored `complete` while the next flow starts a fresh `active` row) and is not
  persisted.

## Alternatives Considered

**Keep the opaque `state` token (status quo):** Rejected. Fails on GPT relay
fragility and PII exposure, the two problems that motivated the change.

**Session id in the request body (GPT carries an id, not the blob):** Rejected.
Still asks the GPT to carry and echo our state reliably, and still lets a client
target another session id. Identity-keyed lookup removes both: the JWT is the key,
so the GPT carries nothing and a landlord can only ever address their own session.

**Server sessions keyed by an explicit session id with multiple concurrent active
sessions:** Rejected for now. The app is one human per landlord, serial turns. A
single active session keyed by identity is simpler and matches reality; multiple
concurrent flows would need conflict resolution the product does not require.

## Consequences

- One additive, forward-only migration: `flow_sessions` table, the unique partial
  index, an `expires_at` index, RLS, and the pg_cron expiry sweep
  (`20260606000000_flow_sessions.sql`).
- `POST /workflow/next` is refactored: drop `encodeState`/`decodeState`, derive
  `landlord_id` only from the verified JWT (never body/params), and branch on
  session presence. (Implemented in the handler PR.)
- The GPT-facing contract changes: `specs/openapi.yaml` and `gpt/openapi.yaml`
  drop `state` and adopt the `{ intent, answer, control }` / `status`-discriminated
  envelope. `gpt/SYSTEM_PROMPT.md` gains a standing rule mapping undo→`back`,
  cancel/menu→`menu`, else reply in `answer`.
- **Parallel-conversation trade-off:** with one active session per landlord, two
  simultaneous ChatGPT conversations for the same landlord share the one active
  row. This is last-write-wins, made deterministic by the unique partial index.
  Accepted: the product is single-operator per landlord.
- Resumability comes for free: a landlord can start on their phone and continue in
  a new chat, because state is server-side.
- PII no longer transits OpenAI inside a state blob; it lives only in the
  landlord-scoped `flow_sessions` row under RLS.
