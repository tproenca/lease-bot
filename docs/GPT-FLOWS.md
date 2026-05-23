# GPT Conversation Flows & API Reference

This document maps every ChatGPT conversation flow to the Supabase Edge Function calls it triggers. Use it alongside the [manual test runbook](MANUAL-TEST.md) and the [OpenAPI schema](../gpt/openapi.yaml).

---

## System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    ChatGPT Custom GPT                           │
│  (Lease Assistant — shared deployment, per-landlord JWT auth)   │
└────────────────────────┬────────────────────────────────────────┘
                         │ HTTPS · Bearer JWT
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│              Supabase Edge Functions (Deno/TypeScript)          │
│  /context  /templates/diff  /documents/generate  /signatures   │
│  /payments  /tenants  /properties  /buildings  /placeholders    │
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

---

## Authentication

The GPT authenticates to the Edge Functions via **OAuth 2.0 with Google**, proxied through two same-domain Edge Functions so OpenAI can reach them:

```
GPT (OpenAI) ──GET──► /oauth/authorize ──302──► accounts.google.com/o/oauth2/v2/auth
                                                         │
                                               user logs in with Google
                                                         │
                       /auth/callback ◄──302─────────────┘
                              │
                    (exchange code → Google tokens)
                    (create Supabase Auth session)
                              │
                       /oauth/token ◄── GPT exchanges code for tokens
                              │
                    Returns { access_token (Supabase JWT), refresh_token }
                              │
          All subsequent GPT actions ──Bearer {access_token}──► Edge Functions
```

- The `access_token` is a Supabase JWT scoped to the authenticated landlord.
- Row-Level Security (RLS) enforces landlord isolation on every database query — no request can read another landlord's data.
- `refresh_token` is exchanged via `/oauth/token` (grant_type=refresh_token) when the JWT expires.

---

## Flow 0 — Onboarding (first conversation, landlord not yet set up)

**Trigger:** GPT calls `getContext` and receives `HTTP 404 LANDLORD_NOT_FOUND`.

```
GPT                         Edge Functions              Browser (landlord)
 │                                │                           │
 ├──GET /context──────────────────►                           │
 │◄──404 LANDLORD_NOT_FOUND───────┤                           │
 │                                │                           │
 │  [GPT shows setup URL]         │                           │
 │                                │       GET /setup ─────────►
 │                                │◄──── 200 HTML (pre-auth) ─┤
 │                                │    (Entrar com Google btn) │
 │                                │                           │
 │                                │  ── click "Entrar" ───────►
 │                                │◄── GET /oauth/authorize ──┤
 │                                │──302 → accounts.google.com►
 │                                │                     (login)
 │                                │◄── GET /auth/callback ────┤
 │                                │  (exchange code → tokens) │
 │                                │──302 → /setup ────────────►
 │                                │◄── GET /setup ────────────┤
 │                                │──200 HTML (post-auth) ─────►
 │                                │  (Drive Picker + form)    │
 │                                │                           │
 │                                │◄── POST /setup/complete ──┤
 │                                │  (root_folder_id,         │
 │                                │   templates_folder_name,  │
 │                                │   whatsapp,               │
 │                                │   autentique_api_key,     │
 │                                │   autentique_webhook_secret)
 │                                │──201──────────────────────►
 │                                │  (creates landlord row,   │
 │                                │   Drive folders, starter  │
 │                                │   docs)                   │
 │                                │                           │
 │  [landlord returns to GPT chat]│                           │
 │                                │                           │
 ├──GET /context──────────────────►                           │
 │◄──200 (landlord data) ─────────┤                           │
 │  [GPT greets landlord + menu]  │                           │
```

**API calls:**

| Step | Method | Path | Auth | Notes |
|------|--------|------|------|-------|
| Check landlord | GET | `/context` | Bearer JWT | Returns 404 LANDLORD_NOT_FOUND |
| Start OAuth | GET | `/oauth/authorize` | None | Proxies to Google |
| OAuth callback | GET | `/auth/callback` | None | Exchanges code, sets session cookie |
| Get token | POST | `/oauth/token` | None | Returns Supabase JWT |
| Complete setup | POST | `/setup/complete` | Bearer JWT | Creates landlord row + Drive folders |
| Load context | GET | `/context` | Bearer JWT | Confirms setup succeeded |

---

## Flow 1 — Session Start (every conversation)

**Trigger:** Any message, including "oi", "menu", "ajuda", or any other first message.

The GPT **always** calls `getContext` before responding. This is enforced by the `## OBRIGATÓRIO` section of the system prompt.

```
GPT ──GET /context──────────────────────────────────────────────►
    ◄──200 { landlord, properties, buildings, templates,
              placeholders, witnesses, account_config,
              cron_errors } ─────────────────────────────────────

GPT ──GET /templates/diff ───────────────────────────────────────►
    ◄──200 { templates: {added, removed},
              placeholders: {added, removed},
              witnesses: {added} } ──────────────────────────────
```

- If `cron_errors` is non-empty, GPT warns the landlord about failed automated reminders.
- If `templates/diff` returns non-empty changes, GPT enters **Flow 2** before showing the menu.
- If both are clean, GPT greets the landlord by name and shows the menu.

**API calls:**

| Method | Path | Auth | Response |
|--------|------|------|----------|
| GET | `/context` | Bearer JWT | Full landlord context snapshot |
| GET | `/templates/diff` | Bearer JWT | Detected changes vs Drive state |

---

## Flow 2 — Template Sync (diff non-empty)

**Trigger:** `GET /templates/diff` returns at least one change. Runs before the main menu.

The diff compares the landlord's Google Drive templates folder against the cached DB state. The GPT walks through each change interactively before continuing.

```
templates.added      → GPT asks: which property types apply?
                        ──POST /templates──────────────────────►
                          { drive_file_id, name,
                            placeholder_names[],
                            property_types[] }
                        ◄──201 { id } ─────────────────────────

placeholders.added   → GPT asks: format, case, derived?, required?, default?
                        ──POST /placeholders───────────────────►
                          [{ name, required, format, case,
                             default_value, derived_from,
                             derived_formula }]
                        ◄──201 { ids[] } ───────────────────────

witnesses.added      → GPT asks: WhatsApp number for each
                        ──POST /witnesses──────────────────────►
                          { name, whatsapp }
                        ◄──201 { id } ─────────────────────────

templates.removed    → GPT informs landlord + asks confirmation
                        ──DELETE /templates/:id────────────────►
                        ◄──204 ─────────────────────────────────

placeholders.removed → GPT informs landlord (no confirmation required)
                        ──DELETE /placeholders/:name────────────►
                        ◄──204 ─────────────────────────────────
```

**Confirmation protocol:** GPT requires explicit "Sim" before calling any write endpoint. Each change gets a summary + "Confirma? (Sim para continuar)".

---

## Flow 3 — Generate Contract

**Trigger:** Menu item "Gerar contrato" or user intent.

```
1. GPT identifies property and tenant from context (already loaded in Flow 1)
2. GPT asks for each required placeholder not marked as derived
3. GPT computes derived values (end date, amount in words, formatted CPF, etc.)
4. GPT shows complete summary of all placeholder values
5. Landlord confirms with "Sim"

──POST /documents/generate───────────────────────────────────────►
  { tenant_id,
    values: { placeholder_name: value, ... } }
◄──200 [{ doc_id, url }] ────────────────────────────────────────
  (Drive URLs of generated documents)

6. GPT shows Drive links and asks if landlord wants to send for signature
```

**Derived value rules** (from `contract-rules.md`):

| Placeholder | Derived from |
|-------------|--------------|
| End date | Start date + duration in months |
| Amount in words | Numeric rent value → Portuguese text |
| Formatted CPF | Raw CPF digits → XXX.XXX.XXX-XX |
| Full date text | Date → "DD de mês de YYYY" |

**API calls:**

| Method | Path | Auth | Key fields |
|--------|------|------|------------|
| POST | `/documents/generate` | Bearer JWT | `tenant_id`, `values{}` |

---

## Flow 4 — Send for Signature

**Trigger:** Menu item "Enviar para assinatura" or after generating a contract.

```
1. GPT confirms documents exist for the tenant (from context)
2. GPT lists signers:
   - Tenant (WhatsApp required — asks if not set)
   - Landlord (WhatsApp from context)
   - Witnesses (WhatsApp from context)
3. GPT shows summary of signers + "Confirma? (Sim para continuar)"

──POST /signatures/send──────────────────────────────────────────►
  { tenant_id }
◄──201 { id, autentique_document_id } ───────────────────────────

4. GPT confirms submission and explains that signers receive WhatsApp link

--- background (called by Autentique, not GPT) ---

Autentique ──POST /webhooks/autentique/:landlord_id───────────────►
            (HMAC-SHA256 verified)
           ◄──200 ───────────────────────────────────────────────
            [background: download signed PDF, upload to Drive,
             mark signature_requests as completed]
```

**Error cases:**
- `422 SIGNATURE_MARKERS_NOT_FOUND` — template is missing `[[LOCADOR]]`, `[[LOCATARIO]]`, etc. GPT explains and asks the landlord to fix the template.
- `502 AUTENTIQUE_ERROR` — response includes `drive_urls[]` so landlord can submit manually.

**API calls:**

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| POST | `/signatures/send` | Bearer JWT | Exports PDFs, detects markers, submits to Autentique |
| GET | `/signatures/:id/status` | Bearer JWT | Check signing status later |
| PATCH | `/signatures/:id/reminder` | Bearer JWT | Update Autentique reminder frequency |
| POST | `/webhooks/autentique/:landlord_id` | HMAC (not GPT) | Called by Autentique on completion |

---

## Flow 5 — Record Payment

**Trigger:** Menu item "Registrar pagamento".

```
1. GPT asks: which tenant? (from context)
2. GPT asks: reference month (YYYY-MM)
3. GPT asks: amount and payment date
4. GPT shows summary + "Confirma? (Sim para continuar)"

──POST /payments─────────────────────────────────────────────────►
  { tenant_id, amount, reference_month, paid_at }
◄──201 { id, on_time } ──────────────────────────────────────────
  (on_time = true if paid on/before 5th of reference month)

5. GPT confirms payment recorded, notes if it was on time
```

**API calls:**

| Method | Path | Auth | Key fields |
|--------|------|------|------------|
| POST | `/payments` | Bearer JWT | `tenant_id`, `amount`, `reference_month`, `paid_at` |

---

## Flow 6 — View Overdue Tenants

**Trigger:** Menu item "Ver inadimplentes".

```
1. GPT asks: reference month (default: current month)

──GET /payments?month=YYYY-MM────────────────────────────────────►
◄──200 { paid: [...], overdue: [...] } ──────────────────────────

2. GPT lists overdue tenants with date of last reminder sent
3. GPT asks: send reminder to a specific tenant, all, or none?

For each tenant to remind:
4. GPT shows summary + "Confirma? (Sim para continuar)"

──POST /payments/remind───────────────────────────────────────────►
  { tenant_id, reference_month }
◄──200 ──────────────────────────────────────────────────────────
  (or 422 WHATSAPP_SEND_FAILED — GPT informs landlord)
```

**Note:** Automated reminders are sent by pg_cron (no GPT involvement). If `cron_errors` were returned in `/context`, GPT surfaces them here and offers to send manually.

**API calls:**

| Method | Path | Auth | Key fields |
|--------|------|------|------------|
| GET | `/payments` | Bearer JWT | `?month=YYYY-MM` |
| POST | `/payments/remind` | Bearer JWT | `tenant_id`, `reference_month` |

---

## Flow 7 — Add Tenant

**Trigger:** Menu item "Adicionar inquilino".

```
1. GPT asks: which property? (from context — shows list)
2. GPT asks: name, CPF, WhatsApp (optional)
3. GPT shows summary + "Confirma? (Sim para continuar)"
   Note: if property already has an active tenant, GPT warns the
   previous tenant folder will be unstarred (archived in Drive)

──POST /tenants───────────────────────────────────────────────────►
  { property_id, name, cpf, whatsapp? }
◄──201 { id, drive_folder_id } ──────────────────────────────────
  (Drive folder created: Root/{Property}/{TenantName}/)

4. GPT confirms and shows Drive folder link
```

**API calls:**

| Method | Path | Auth | Key fields |
|--------|------|------|------------|
| POST | `/tenants` | Bearer JWT | `property_id`, `name`, `cpf`, `whatsapp` (optional) |
| PATCH | `/tenants/:id` | Bearer JWT | Update `whatsapp` later |

---

## Flow 8 — Add Property (House or Commercial)

**Trigger:** Menu item "Adicionar imóvel" → type = house or commercial.

```
1. GPT asks: property name and address
2. GPT shows summary + "Confirma? (Sim para continuar)"

──POST /properties────────────────────────────────────────────────►
  { type: "house" | "commercial", name, address }
◄──201 { id, drive_folder_id } ──────────────────────────────────
  (Drive folder created: Root/{PropertyName}/)
```

**API calls:**

| Method | Path | Auth | Key fields |
|--------|------|------|------------|
| POST | `/properties` | Bearer JWT | `type`, `name`, `address` |

---

## Flow 9 — Add Property (Apartment)

**Trigger:** Menu item "Adicionar imóvel" → type = apartment.

```
1. GPT asks: existing building or new building?

If new building:
   GPT asks: building name and address
   ──POST /buildings─────────────────────────────────────────────►
     { name, address }
   ◄──201 { id, drive_folder_id } ──────────────────────────────
     (Drive folder created: Root/{BuildingName}/)

2. GPT asks: apartment name and address
3. GPT shows summary + "Confirma? (Sim para continuar)"

──POST /properties────────────────────────────────────────────────►
  { type: "apartment", name, address, building_id }
◄──201 { id, drive_folder_id } ──────────────────────────────────
  (Drive folder created: Root/{Building}/{ApartmentName}/)
```

**API calls:**

| Method | Path | Auth | Key fields |
|--------|------|------|------------|
| POST | `/buildings` | Bearer JWT | `name`, `address` |
| POST | `/properties` | Bearer JWT | `type: "apartment"`, `name`, `address`, `building_id` |

---

## Flow 10 — Update Account Config

**Trigger:** Landlord asks to change payment reminder frequency.

```
1. GPT asks: daily, weekly, or disabled?
2. GPT shows summary + "Confirma? (Sim para continuar)"

──PATCH /account/config───────────────────────────────────────────►
  { payment_reminder_frequency: "daily" | "weekly" | "disabled" }
◄──200 { payment_reminder_frequency } ───────────────────────────
```

**API calls:**

| Method | Path | Auth | Key fields |
|--------|------|------|------------|
| PATCH | `/account/config` | Bearer JWT | `payment_reminder_frequency` |

---

## API Quick Reference

| Method | Path | GPT-callable | Auth | Purpose |
|--------|------|:---:|------|---------|
| GET | `/context` | ✅ | Bearer JWT | Load all landlord data (called every session) |
| GET | `/templates/diff` | ✅ | Bearer JWT | Detect Drive template/placeholder changes |
| POST | `/templates` | ✅ | Bearer JWT | Register a template + property-type mappings |
| DELETE | `/templates/:id` | ✅ | Bearer JWT | Remove a template |
| POST | `/placeholders` | ✅ | Bearer JWT | Add placeholder definitions (bulk) |
| DELETE | `/placeholders/:name` | ✅ | Bearer JWT | Remove a placeholder |
| POST | `/witnesses` | ✅ | Bearer JWT | Add a witness with WhatsApp |
| GET | `/properties` | ✅ | Bearer JWT | List all properties |
| POST | `/properties` | ✅ | Bearer JWT | Create a property (house/apartment/commercial) |
| POST | `/buildings` | ✅ | Bearer JWT | Create a building (parent for apartments) |
| POST | `/tenants` | ✅ | Bearer JWT | Register a tenant |
| GET | `/tenants/:id` | ✅ | Bearer JWT | Fetch tenant details |
| PATCH | `/tenants/:id` | ✅ | Bearer JWT | Update tenant WhatsApp |
| POST | `/documents/generate` | ✅ | Bearer JWT | Generate contracts with placeholder substitution |
| POST | `/signatures/send` | ✅ | Bearer JWT | Submit documents for e-signature via Autentique |
| GET | `/signatures/:id/status` | ✅ | Bearer JWT | Check signing status |
| PATCH | `/signatures/:id/reminder` | ✅ | Bearer JWT | Update Autentique reminder frequency |
| POST | `/payments` | ✅ | Bearer JWT | Record a payment |
| GET | `/payments` | ✅ | Bearer JWT | Get paid/overdue tenants for a month |
| POST | `/payments/remind` | ✅ | Bearer JWT | Send WhatsApp payment reminder |
| PATCH | `/account/config` | ✅ | Bearer JWT | Update payment reminder frequency |
| POST | `/webhooks/autentique/:landlord_id` | ❌ web-only | HMAC | Receive signed document notification from Autentique |
| GET | `/setup` | ❌ web-only | Session | Render onboarding HTML (3 states) |
| POST | `/setup/complete` | ❌ web-only | Bearer JWT | Complete landlord onboarding |
| GET | `/auth/callback` | ❌ web-only | None | Google OAuth redirect handler |
| GET | `/oauth/authorize` | ❌ web-only | None | OAuth proxy → Google (required by OpenAI) |
| POST | `/oauth/token` | ❌ web-only | None | Exchange auth code or refresh token |
