# GPT Conversation Flows & API Reference

This document describes the architecture of the Lease Assistant Custom GPT, the stateless round-trip contract with the backend, and the manual test plan.

---

## Architecture Overview

The GPT is a **thin conversational relay**. All flow logic, menus, validations, confirmations, and context loading are owned by the backend via `POST /workflow/next`. The GPT does not implement any flow logic from memory — it echoes `intent` and `values` from the previous response each turn, relays `message`/`options`/`links` verbatim to the user, and calls `workflowNext` for every business intent.

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

Every GPT turn calls `POST /workflow/next`. No session table is used — state lives in the `intent`/`values` fields echoed back each turn.

### Request (GPT → backend)

```json
{
  "intent": "add_tenant",
  "values": { "property_id": "uuid", "name": "João Silva" },
  "message": "<user's latest message>"
}
```

| Field | Type | Notes |
|-------|------|-------|
| `intent` | `string \| null` | Intent returned by the previous response. `null` on first turn. |
| `values` | `object \| null` | Collected values returned by the previous response. `null` on first turn. |
| `message` | `string` | The user's latest reply, relayed verbatim. |

### Response (backend → GPT)

```json
{
  "message": "Qual é o CPF do inquilino?",
  "intent": "add_tenant",
  "values": { "property_id": "uuid", "name": "João Silva" },
  "step": "ask_cpf",
  "options": null,
  "links": null,
  "error": null
}
```

| Field | Type | Notes |
|-------|------|-------|
| `message` | `string` | Relay verbatim to the user. |
| `intent` | `string \| null` | Echo back on the next turn. |
| `values` | `object` | Echo back on the next turn. |
| `step` | `string` | Current workflow step. `confirm` → show summary + "Confirma? (Sim para continuar)". `done` → flow complete. |
| `options` | `array \| null` | Numbered options to present when not null. |
| `links` | `array \| null` | Links to relay when not null. |
| `error` | `object \| null` | Error details; relay `message` in plain language. |

The GPT does **not** echo `step` back — only `intent` and `values`.

---

## Manual Test Plan

10-step checklist for verifying the GPT relay behaviour end-to-end:

1. **Session start:** Send "oi". Verify GPT calls `workflowNext` with `{intent: null, values: null, message: "oi"}` and displays the menu returned by the backend.
2. **Menu selection:** Reply "5" (Add Tenant). Verify GPT echoes `{intent: null, values: null, message: "5"}` and displays the property list.
3. **Property selection:** Reply "1". Verify GPT echoes `{intent: "add_tenant", values: {}, message: "1"}` and asks for tenant name.
4. **Name entry:** Reply with a name. Verify GPT echoes `{intent: "add_tenant", values: {property_id: "..."}, message: "<name>"}` and asks for CPF.
5. **Invalid CPF:** Reply with a malformed CPF. Verify backend returns a re-ask message; GPT relays it verbatim without inventing its own error text.
6. **Valid CPF:** Reply with a valid CPF. Verify GPT echoes values including CPF and backend asks for WhatsApp.
7. **Skip WhatsApp:** Reply "pular". Verify GPT echoes `{..., message: "pular"}` and backend advances to confirm step.
8. **Confirm step:** Verify GPT shows the summary returned by backend and asks "Confirma? (Sim para continuar)".
9. **Rejection at confirm:** Reply "muda o nome". Verify GPT sends `{..., message: "muda o nome"}` to backend and stays in confirm.
10. **Confirmation:** Reply "Sim". Verify backend returns `step: "done"` and GPT relays the completion message.
