# GPT Architecture & /workflow/next Contract

This document describes the architecture of the Lease Assistant Custom GPT, the stateless round-trip contract with the backend, and the manual test plan.

---

## Architecture Overview

The GPT is a **thin conversational relay**. All flow logic, menus, validations, confirmations, and context loading are owned by the backend via `POST /workflow/next`. The GPT does not implement any flow logic from memory — it echoes `intent` and `state` from the previous response each turn, relays `message`/`options`/`links` verbatim to the user, and calls `workflowNext` for every business intent.

```
┌─────────────────────────────────────────────────────────────────┐
│                    ChatGPT Custom GPT                           │
│         (thin relay — no flow logic, no menus, no state)        │
└────────────────────────┬────────────────────────────────────────┘
                         │ POST /workflow/next (every turn)
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│              Supabase Edge Functions (Deno/TypeScript)          │
│   /workflow/next  (owns context, menus, flows, validations)     │
│   Flows defined in: supabase/functions/workflow/intents/        │
└──────┬─────────────────┬──────────────────────┬────────────────┘
       │                 │                      │
       ▼                 ▼                      ▼
┌────────────┐  ┌────────────────┐  ┌─────────────────────────┐
│ Supabase   │  │  Google Drive  │  │  Third-party services   │
│ PostgreSQL │  │  (per-landlord │  │  Autentique (e-sign)    │
│ + Auth     │  │   account)     │  │  Meta WhatsApp Cloud    │
│ + pg_cron  │  └────────────────┘  └─────────────────────────┘
└────────────┘
```

**Web onboarding** (`/setup`, `/auth/callback`, `/oauth/*`) runs once in the browser and is not part of the GPT conversation.

Individual flow implementations live in `supabase/functions/workflow/intents/`.

---

## Stateless Round-Trip Contract

Every GPT turn calls `POST /workflow/next`. No session table is used — all flow state is encoded in the opaque `state` token, which the GPT echoes verbatim each turn.

### Request (GPT → backend)

```json
{ "intent": "add_tenant", "state": "<opaque-token>", "message": "1" }
```

| Field | Type | Notes |
|-------|------|-------|
| `intent` | `string \| null` | Resolved by GPT from `options[n].value` on step `"menu"`, or from natural language. Omit when null or once a flow is in progress (intent was established at Enter phase). |
| `state` | `string \| null` | Opaque base64 token from previous response. Echo verbatim — do not decode. Omit when previous response returned `state: null` (session boundary). |
| `message` | `string` | The user's latest reply, relayed verbatim. |

### Response (backend → GPT)

```json
{
  "message": "Qual é o CPF do inquilino?",
  "intent": "add_tenant",
  "state": "eyJwcm9wZXJ0eV9pZCI6InV1aWQiLCJuYW1lIjoiSm_Do28ifQ==",
  "step": "ask_cpf",
  "options": null
}
```

| Field | Type | Notes |
|-------|------|-------|
| `message` | `string` | Relay verbatim to the user. |
| `intent` | `string \| null` | Echo back on the next turn. `null` on session boundaries (menu, reauth, error). |
| `state` | `string \| null` | Opaque token — echo verbatim on next turn. `null` = session boundary; omit on next call. |
| `step` | `string` | Current workflow step. `confirm` → show summary + "Confirma? (Sim para continuar)". `done` never returned — backend auto-transitions to menu. |
| `options` | `array \| null` | Options to present. On `step: "menu"`, each option's `value` is the intent string to send on the next call. On other steps, `value` is a data payload (e.g. property ID) — do not use as intent. |
| `links` | `array \| null` | Links to relay when not null. |
| `error` | `object \| null` | Error details; relay `message` in plain language. |

The GPT does **not** echo `step` back — only `intent` and `state`.

### Enter/Process split

The backend uses the presence of `state` to determine the conversation phase:

- **Enter phase** (`state` absent): backend renders the first prompt of the flow without validating the incoming message. Use this when starting a new flow (intent just selected, no state yet).
- **Process phase** (`state` present): backend validates the user's message and advances the flow.

### Session boundaries

`state: null` is returned for: menu, onboarding, reauth, error. The GPT omits `state` on the next call. The backend then treats the call as a fresh intent resolution (Enter phase or startup).

---

## Intent Resolution

When `intent` is absent, the backend resolves the intent from the user's message:

1. **Numeric match**: `"5"` → `add_tenant` (MENU_MAP)
2. **Text label match** (case-insensitive): `"Adicionar inquilino"` → `add_tenant`
3. **No match**: load context, return menu

The GPT can also resolve intent by reading `options[n].value` when `step: "menu"` and sending that value as `intent` on the next call.

---

## Manual Test Plan

10-step checklist for verifying the GPT relay behaviour end-to-end:

1. **Session start:** Send "oi". Verify GPT calls `workflowNext` with `{message: "oi"}` (no state, no intent) and displays the menu returned by the backend. Response has `state: null`.
2. **Menu selection:** Reply "5" (Add Tenant). Verify GPT sends `{message: "5"}` (no state) and displays the property list. Response has `intent: "add_tenant"`, `state: "<token>"`.
3. **Property selection:** Reply "1". Verify GPT sends `{intent: "add_tenant", state: "<token>", message: "1"}` and backend asks for tenant name. Response has updated `state`.
4. **Name entry:** Reply with a name. Verify GPT sends `{intent: "add_tenant", state: "<token>", message: "<name>"}` and backend asks for CPF.
5. **Invalid CPF:** Reply with a malformed CPF. Verify backend returns a re-ask message; GPT relays it verbatim without inventing its own error text.
6. **Valid CPF:** Reply with a valid CPF. Verify backend asks for WhatsApp.
7. **Skip WhatsApp:** Reply "pular". Verify backend advances to confirm step.
8. **Confirm step:** Verify GPT shows the summary returned by backend and asks "Confirma? (Sim para continuar)".
9. **Rejection at confirm:** Reply "muda o nome". Verify GPT sends `{intent: "add_tenant", state: "<token>", message: "muda o nome"}` to backend and stays in confirm.
10. **Confirmation:** Reply "Sim". Verify backend returns menu (step: done auto-transitions), GPT relays the success message + menu. Next call has no state.
