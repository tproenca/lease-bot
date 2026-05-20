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
  current_tenant_folder_id  text nullable           -- Drive folder ID of active tenant
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
  derived_from     text nullable                   -- name of source placeholder
  derived_formula  text nullable                   -- human-readable formula for GPT
  unique (landlord_id, name)

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
      properties: [{ id, type, name, address, building_id, current_tenant_folder_id }],
      buildings: [{ id, name, address }],
      templates: [{ id, name, property_types: [] }],
      placeholders: [{ name, required, format, case, default, derived_from, derived_formula }],
      witnesses: [{ name, whatsapp }],
      account_config: { payment_reminder_frequency }
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
  Body: { name, required, format, case?, default?, derived_from?, derived_formula? }
  → 201 { id }

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
  → 200 [{ id, type, name, address, building_id, current_tenant_folder_id }]
```

### Tenants

```
POST /tenants
  Body: { property_id, name, cpf, whatsapp? }
  → 201 { id, drive_folder_id }
  Side effects: creates Drive folder, stars it, unstars previous tenant folder,
                updates properties.current_tenant_folder_id

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
    placeholders: { [name]: value }
  }
  → 200 { documents: [{ template_name, drive_url }] }
  Side effects: copies templates, substitutes {{placeholders}}, saves to Drive
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

### Document Generation Flow

```
GPT calls GET /context
  → GPT calls GET /templates/diff
      → [empty diff] continue
      → [non-empty diff] GPT resolves changes with landlord first
  → GPT collects placeholder values from landlord
  → GPT shows summary → landlord confirms ("Sim")
  → GPT calls POST /documents/generate
      → returns Drive URLs
  → GPT asks "Quer enviar para assinatura?"
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

```
States: vacant | active

POST /tenants (new property)       → vacant → active
POST /tenants (replacing tenant)   → active → (archive old) → active

On activation:
  - Create Drive folder at Root/{property}/{tenant}/
  - Star new folder (Drive API)
  - Unstar previous folder if exists
  - Update properties.current_tenant_folder_id
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
