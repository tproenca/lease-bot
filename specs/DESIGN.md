# Design — Lease Assistant

## Data Model

```sql
landlords
  id                          uuid primary key
  email                       text unique not null
  name                        text not null
  whatsapp                    text not null
  google_refresh_token        text not null
  autentique_api_key          text not null        -- per-landlord Autentique API key (encrypted at rest)
  autentique_webhook_secret   text not null        -- per-landlord HMAC secret for the landlord's Autentique webhook
  root_folder_id              text not null        -- Google Drive folder ID
  templates_folder_id         text not null        -- Google Drive folder ID
  payment_reminder_frequency  text not null        -- daily | weekly | disabled
  created_at                  timestamptz default now()

buildings
  id                uuid primary key
  landlord_id       uuid references landlords
  name              text not null
  address           text not null
  drive_folder_id   text not null
  created_at        timestamptz default now()

properties
  id                        uuid primary key
  landlord_id               uuid references landlords
  type                      text not null           -- apartment | house | commercial
  building_id               uuid references buildings nullable
  name                      text not null
  address                   text not null
  drive_folder_id           text not null
  current_tenant_folder_id  text nullable           -- Drive folder ID of active tenant (presentation only — star in Drive)
  current_tenant_id         uuid nullable references tenants  -- FK to active tenant; written atomically with current_tenant_folder_id
  created_at                timestamptz default now()

tenants
  id              uuid primary key
  landlord_id     uuid references landlords
  property_id     uuid references properties
  name            text not null
  cpf             text not null
  whatsapp        text nullable
  drive_folder_id text not null
  created_at      timestamptz default now()

templates
  id                      uuid primary key
  landlord_id             uuid references landlords
  drive_file_id           text not null
  name                    text not null
  drive_last_modified_at  timestamptz not null
  placeholder_names       text[] not null default '{}'
  created_at              timestamptz default now()

placeholders
  id               uuid primary key
  landlord_id      uuid references landlords
  name             text not null                   -- e.g. "nome do inquilino"
  required         boolean not null default true
  format           text not null                   -- text | date | cpf | integer | currency
  case             text nullable                   -- maiúsculas | minúsculas | título | frase
  default          text nullable
  derived_formula  text nullable                   -- closed-grammar expression; see §Derived Formula Model
  options          text[] nullable                 -- restricted value list for format=text; rendered as numbered list
  unique (landlord_id, name)
  -- NOTE: derived_from column dropped in migration (ADR-0017)

property_type_templates
  landlord_id    uuid references landlords
  property_type  text not null                     -- apartment | house | commercial
  template_id    uuid references templates
  primary key (landlord_id, property_type, template_id)

witnesses
  id           uuid primary key
  landlord_id  uuid references landlords
  name         text not null
  whatsapp     text not null
  unique (landlord_id, name)

payments
  id               uuid primary key
  landlord_id      uuid references landlords
  tenant_id        uuid references tenants
  amount           numeric not null
  reference_month  date not null                   -- first day of the reference month
  paid_at          timestamptz not null
  on_time          boolean not null
  created_at       timestamptz default now()

payment_reminders
  id               uuid primary key
  landlord_id      uuid references landlords
  tenant_id        uuid references tenants
  reference_month  date not null
  sent_at          timestamptz not null

signature_requests
  id                    uuid primary key
  landlord_id           uuid references landlords
  tenant_id             uuid references tenants
  autentique_document_id text not null unique
  status                text not null default 'pending'   -- pending | completed
  created_at            timestamptz default now()
  completed_at          timestamptz nullable

cron_errors
  id          uuid primary key
  job_name    text not null
  error       text not null
  occurred_at timestamptz default now()
```

---

## Derived Formula Model

A placeholder's value source is fully expressed by a single `derived_formula` column using a closed-grammar expression. This replaces the retired `derived_from` column (ADR-0017).

### Value-source categories

| Category | `derived_formula` | Meaning |
|---|---|---|
| **Asked** | `null` | Collect from landlord; numbered list if `options[]` is set |
| **Context auto-fill** | `tenant.name` | Identity copy from loaded entity data |
| **Context + transform** | `cpf_format(tenant.cpf)` | Pull context value, apply registry function |
| **Derived from sibling** | `amount_in_words(valor_aluguel)` | Transform another placeholder's value |
| **Multi-input derived** | `end_date(data_inicio, duracao_meses)` | Formula over several inputs |

### Grammar (closed)

- A **bare token** is an identity copy of that source.
- `fn(arg1, arg2, …)` applies registry function `fn` to the resolved args.
- Each **arg** is either a **context path** — namespace ∈ `{tenant, property, landlord, building}` (e.g. `tenant.cpf`, `property.address`) — or a **sibling placeholder name**. Disambiguation: a dotted token with a known namespace prefix is a context path; otherwise it is a sibling placeholder name.
- `null` = asked.

### Formula registry (closed set)

| Function | Inputs | Output |
|---|---|---|
| `identity` | any context path | Identity copy |
| `cpf_format` | CPF digits string | `XXX.XXX.XXX-XX` |
| `amount_in_words` | numeric amount | PT extenso (e.g. "mil e quinhentos reais") |
| `full_date_text` | date | "DD de mês de AAAA" |
| `end_date` | start date, duration in months | ISO date string |

Adding a new formula requires a code change and a new ADR. Config-time validation at `POST /placeholders` rejects any `derived_formula` referencing an unknown function or an unresolvable input.

### Config UX (Option B — menu-driven)

During template sync (Flow 2), the landlord picks a derivation type from a numbered list of the registry functions and picks input fields from existing placeholders or context fields. They never type a formula expression. An unsupported derivation → field is treated as *asked*. Because config is menu-driven, invalid expressions are unconstructable by the landlord; the endpoint still validates defensively.

### Required-validation scoping

`POST /documents/generate` validates `required` placeholders scoped to the **union of placeholders used by the templates being generated** (filtered by `property_type` + `use_case`), not all global placeholders for the landlord. A placeholder marked `required: true` that does not appear in any of the selected templates is not checked.

The `default` column is honored: if a placeholder has a non-null `default`, it is applied at resolution time for any value that remains empty after collection. The resolved default is included in the confirm table.

---

## API Contracts

All endpoints are Supabase Edge Functions. All requests require `Authorization: Bearer <jwt>` except the setup flow. All error responses follow: `{ "error": { "code": "string", "message": "string" } }`.

### Setup & Auth

```
GET  /setup
  → 200 HTML (onboarding page — pre-auth or post-auth state)

GET  /auth/callback?code=&state=
  → 302 redirect to /setup (session established)

POST /setup/complete
  Body: { root_folder_id, templates_folder_name, whatsapp, autentique_api_key,
          autentique_webhook_secret }
  → 200 { templates_folder_id }

GET  /context
  → 200 {
      landlord: { name, whatsapp },
      templates_diff_pending: boolean   -- true if GET /templates/diff is non-empty (triggers Flow 2)
      -- NOTE: full snapshot fields (properties, buildings, templates, placeholders, witnesses,
      -- account_config) are loaded lazily per-flow via WorkflowDeps. GET /context returns
      -- only the menu essentials needed at session start (ADR-0018).
    }
```

### Templates & Placeholders

```
GET  /templates/diff
  → 200 {
      templates: { added: [name], removed: [name] },
      placeholders: { added: [name], removed: [name] },
      witnesses: { added: [name] }
    }

POST /templates
  Body: { drive_file_id, name, placeholder_names, property_types }
  → 201 { id }

DELETE /templates/:id
  → 204

POST /placeholders
  Body: { placeholders: [{ name, required, format, case?, default?, derived_formula?, options? }] }
  -- derived_from field dropped (ADR-0017)
  -- derived_formula validated against the closed registry at write time
  → 201 { ids }

DELETE /placeholders/:name
  → 204
```

### Properties & Buildings

```
POST /buildings
  Body: { name, address }
  → 201 { id, drive_folder_id }

POST /properties
  Body: { type, building_id?, name, address }
  → 201 { id, drive_folder_id }

GET  /properties
  → 200 [{ id, type, name, address, building_id, current_tenant_folder_id, current_tenant_id }]
```

### Tenants

```
POST /tenants
  Body: { property_id, name, cpf, whatsapp? }
  → 201 { id, drive_folder_id }
  Side effects: creates Drive folder, stars it, unstars previous tenant folder,
                updates properties.current_tenant_folder_id AND properties.current_tenant_id
                (both written in the same DB statement — ADR-0019)

GET  /tenants/:id
  → 200 { id, name, cpf, whatsapp, property_id, drive_folder_id, created_at }

PATCH /tenants/:id
  Body: { whatsapp? }
  → 200 { id }
```

### Documents

```
POST /documents/generate
  Body: {
    property_id,
    tenant_id,
    use_case: "initial" | "renewal" | "termination",  -- default: "initial"
    placeholders: { [name]: value }   -- fully resolved (asked + derived + defaulted)
  }
  → 200 { documents: [{ template_name, drive_url }] }
  Side effects: copies templates, substitutes {{placeholders}}, saves to Drive
  -- Pure substitution: no derivation performed here (derivation is done by the flow engine)
  -- Required-check scoped to union of placeholders in templates matching (property_type, use_case)
  -- default column honored: empty values filled from placeholder.default before substitution
  -- Error codes: INVALID_PLACEHOLDERS, UNKNOWN_PLACEHOLDER, MISSING_REQUIRED_PLACEHOLDERS,
  --              INVALID_USE_CASE
```

### Signatures

```
POST /signatures/send
  Body: { tenant_id }
  → 201 { id, autentique_document_id }
  Side effects: exports Docs to PDF, merges, detects signature positions,
                submits to Autentique with DELIVERY_METHOD_WHATSAPP

GET  /signatures/:id/status
  → 200 { status, created_at, completed_at, signers: [{ name, signed_at }] }

PATCH /signatures/:id/reminder
  Body: { frequency }   -- DAILY | WEEKLY
  → 200

POST /webhooks/autentique/{landlord_id}
  Body: Autentique webhook payload
  → 200
  Side effects: saves signed PDF to Drive, updates signature_requests.status
  Auth: HMAC-SHA256 over the raw body using
        landlords.autentique_webhook_secret for the {landlord_id} path param.
```

### Payments

```
POST /payments
  Body: { tenant_id, amount, reference_month, paid_at }
  → 201 { id, on_time }

GET  /payments?month=YYYY-MM
  → 200 {
      paid: [{ tenant_id, name, amount, paid_at, on_time }],
      overdue: [{ tenant_id, name, last_reminder_sent_at }]
    }

POST /payments/remind
  Body: { tenant_id, reference_month }
  → 200
  Side effects: sends WhatsApp via Meta Cloud API, records in payment_reminders
```

### Witnesses

```
POST /witnesses
  Body: { name, whatsapp }
  → 201 { id }
```

---

## User Flows and State Machines

### Flow 2 — Template Sync

Triggered at session start when `GET /context` returns a non-empty diff flag. The `template_sync` intent runs before the menu is rendered.

```
State: detecting_changes
  GET /templates/diff → diff result
  If empty → skip to menu
  If non-empty → State: presenting_changes
    List all changes upfront (added templates, added placeholders, removed templates,
    removed placeholders, added witnesses)
    For each added template:
      State: ask_property_types → landlord picks (numbered list)
      State: ask_use_case → landlord picks initial | renewal | termination (numbered)
      State: confirm_template → landlord confirms ("Sim")
      Action: POST /templates
    For each added placeholder:
      State: ask_format → numbered list
      State: ask_case → numbered list or skip
      State: ask_derived? → numbered list from formula registry (Option B) or "not derived"
        If derived: State: ask_inputs → pick from existing placeholders/context fields (numbered)
      State: ask_required → sim/não
      State: ask_default → or skip
      State: ask_options? → (format=text only) restrict to list or free text
      State: confirm_placeholder → "Confirma?" → landlord confirms
      Action: POST /placeholders
    For each added witness:
      State: ask_whatsapp → or skip
      Action: POST /witnesses
    For each removed template:
      State: inform_removed → "Confirma remoção?"
      Action: DELETE /templates/:id
    For each removed placeholder:
      State: inform_removed (no confirm)
      Action: DELETE /placeholders/:name
  → done → render menu
```

### Flow 3a — Generate Document (chained from add_tenant)

Entry point: chained from `add_tenant` after tenant is created. Tenant already known; `use_case` implicit `initial`.

```
State: load_placeholders
  loadPlaceholderUnion(property_type, use_case="initial")
  Auto-fill context placeholders (tenant.*, property.*, landlord.*, building.*)
  Run derivation engine: compute derived values
  Apply defaults for empty values

State: ask_placeholders (asked, one per step)
  For each placeholder with derived_formula=null and no auto-fill and no default:
    Prompt with name; if options[] present → numbered list
    Validate input; store in values

State: confirm_table
  Show all resolved values (asked + derived + context + defaulted)
  Landlord replies "Sim" → generate
  Landlord replies field number or label → State: edit_field
    Clear that value and all derived dependents
    Re-ask only the edited step
    Re-derive affected placeholders
    Return to confirm_table

State: generate
  Action: POST /documents/generate { property_id, tenant_id, use_case, placeholders }
  → done → chain to Flow 4 ("Quer enviar para assinatura?")
```

### Flow 3b — Generate Document (menu entry)

Entry point: landlord selects "Gerar documento" from menu.

```
State: ask_property
  List properties (numbered); landlord picks
  Resolve active tenant via properties.current_tenant_id (no ask)

State: ask_use_case
  List: initial | renewal | termination (numbered)

[then follows the same load_placeholders → ask_placeholders → confirm_table → generate
 sequence as Flow 3a, with the selected property_type and use_case]
```

### Flow 5 — Record Payment

```
State: ask_tenant
  List active tenants (numbered); landlord picks

State: ask_reference_month
  Default: current month (MM/YYYY); landlord can override

State: ask_amount_and_date
  Ask amount; ask paid_at date

State: confirm
  Show summary (tenant, month, amount, date)
  Landlord confirms ("Sim")
  Action: POST /payments { tenant_id, amount, reference_month, paid_at }
  Report whether payment was on time

→ done → menu
```

### Flow 6 — View Overdue

```
State: ask_reference_month
  Default: current month; landlord can override

State: show_overdue
  GET /payments?month=YYYY-MM → overdue list with last_reminder_sent_at
  Display list

State: ask_remind
  Options: "Lembrar todos", "Lembrar um", "Nenhum"
  If "Lembrar um" → ask which tenant (numbered)
  If "Lembrar todos" or single selected:
    State: confirm_reminder
      Show summary; landlord confirms ("Sim")
      Action: POST /payments/remind for each selected tenant

→ done → menu
```

### Flow 10 — Update Account Config

Triggered by NL request (not a menu item), e.g. "quero receber lembretes diários".

```
State: ask_frequency
  Options: daily | weekly | disabled (numbered list)

State: confirm
  Show summary; landlord confirms ("Sim")
  Action: PATCH /account/config { payment_reminder_frequency }

→ done → menu
```

### Signing State Machine

```
States: pending | completed

POST /signatures/send        → pending
POST /webhooks/autentique    → completed

Autentique sends DAILY or WEEKLY reminders autonomously to pending signers.
Landlord can update frequency via PATCH /signatures/:id/reminder.
```

### Tenant State per Property

Active tenant is tracked via `properties.current_tenant_id` (FK to `tenants`). Drive "star" is a presentation-only signal derived from this FK — it is not the source of truth. See ADR-0019.

```
States: vacant | active

POST /tenants (vacant property)    → vacant → active
POST /tenants (replacing tenant)   → active → (archive old, warn landlord) → active

On activation (single DB statement):
  - Create Drive folder at Root/{property}/{tenant}/
  - Star new folder (Drive API)
  - Unstar previous tenant folder if current_tenant_id was set
  - UPDATE properties SET current_tenant_id = <new_id>,
                          current_tenant_folder_id = <new_folder>
    WHERE id = <property_id>   -- atomic write

Active-tenant lookup in flows:
  SELECT current_tenant_id FROM properties WHERE id = ?
  -- no Drive folder string-matching
```

### Payment State

```
States: due | paid | overdue

pg_cron daily check per landlord:
  For each active tenant with no payment in reference_month:
    If due date passed → overdue
    If within reminder frequency window → call POST /payments/remind
    Record in payment_reminders
```

---

## Error Handling Strategy

All Edge Functions return structured errors:
```json
{ "error": { "code": "TEMPLATE_NOT_FOUND", "message": "..." } }
```

### GPT error surfacing order

When the backend returns an error, the GPT applies this fallback chain:
1. **`ERROR_MAP` lookup** — if `error.code` is a known key in `ERROR_MAP` (client-side PT-friendly message map), display the mapped message.
2. **`error.message` passthrough** — if `error.code` is not in `ERROR_MAP` but `error.message` is present, display it.
3. **Generic fallback** — "Ocorreu um erro inesperado. Tente novamente."

A contract test asserts that every error code that any endpoint can emit exists as a key in `ERROR_MAP`. This prevents silent generic fallbacks for known errors.

Known codes that must be in `ERROR_MAP`: `INVALID_PLACEHOLDERS`, `UNKNOWN_PLACEHOLDER`, `MISSING_REQUIRED_PLACEHOLDERS`, `INVALID_USE_CASE`, `LANDLORD_NOT_FOUND`, `GOOGLE_REAUTH_REQUIRED`, and any other code emitted by `POST /workflow/next` or `POST /documents/generate`.

### Integration error strategies

| Integration | Strategy |
|------------|----------|
| Google Drive API | Retry up to 3× with exponential backoff on 429/500; surface error to GPT on failure |
| Autentique API | Retry up to 3× with exponential backoff; on failure return error with Drive URLs so landlord can retry |
| Meta WhatsApp API | Retry once; log failure to `payment_reminders` with null `sent_at`; surface in next `GET /payments` |
| PDF merge | Validate page count and file size before submission; if signature markers not found, return structured error with manual positioning instructions |
| pg_cron | Log failures to `cron_errors`; surface in `GET /context` response so GPT can alert landlord |

**Webhook idempotency:**
- `POST /webhooks/autentique` checks `autentique_document_id` before processing; ignores duplicates
- All webhook handlers return `200` immediately before processing to prevent retry storms

---

## UI/UX Conventions

The only UI in this project is the onboarding setup page — three screens served as plain HTML from Edge Functions:

1. **Pre-auth** — "Connect with Google" button; no other elements
2. **Post-auth** — Google Drive Picker + templates folder name input (pre-filled `Templates/`) + WhatsApp input + Autentique API key input (with instructions to sign up at autentique.com.br using their Google account, then copy the key from Configurações → Tokens de API) + submit button
3. **Confirmation** — success message with link to the GPT and link to the Guia de Placeholders in Drive

No CSS framework required. No JavaScript beyond the Google Drive Picker library. Portuguese language throughout.
