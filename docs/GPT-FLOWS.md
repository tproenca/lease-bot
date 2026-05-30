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

## Conversation Conventions

### Numbered options

Whenever the GPT presents a set of choices, it **always** uses a numbered list — never bullets. The landlord can reply with just a number, a range, or a comma-separated list of numbers.

```
GPT: Para quais tipos de imóvel este template se aplica?
     1. Apartamento
     2. Casa
     3. Imóvel comercial

Proprietário: 1 e 2
```

This applies to every choice prompt in the flows, including:
- Property type selection (Flows 2, 8, 9)
- Tenant selection (Flows 3, 5, 6, 7)
- Building selection — existing vs. new (Flow 9)
- Overdue tenants to remind (Flow 6)
- Main menu items (Flow 1)

### Post-flow behavior

After completing any flow that doesn't chain directly into another, the GPT re-shows the menu with a short prompt:

```
Feito! Posso ajudar com mais alguma coisa?

1. Registrar pagamento
2. Ver inadimplentes
3. Gerar documento
4. Enviar para assinatura
5. Adicionar inquilino
6. Adicionar imóvel
7. Criar template
```

**Exception — chained flows:** flows that naturally lead into another do NOT re-show the menu between steps. The menu only appears at the end of the full chain or when the landlord declines to continue:

- Add Tenant (Flow 7) → Generate Document (Flow 3) → Send for Signature (Flow 4) → **menu**
- Generate Document (Flow 3) → Send for Signature (Flow 4) → **menu**

If the landlord declines a chain step (e.g. "não" to generating a contract after adding a tenant), the GPT re-shows the menu immediately.

---

### Confirmation protocol

Before any write API call, the GPT shows a summary and waits for explicit confirmation:

```
GPT: Resumo:
     - Template: Contrato Residencial
     - Tipos: apartamento, casa

     Confirma? (Sim para continuar)

Proprietário: Sim
```

Only "Sim" (or equivalent) triggers the API call. Any other response prompts the GPT to ask what to change.

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

## Flow 1 — Session Start (every session)

**Trigger:** Any message, including "oi", "menu", "ajuda", or any other first message.

Session start sequence is strict:

1. Call `getContext`.
2. Call `getTemplatesDiff`. If non-empty changes, enter **Flow 2** and complete it fully.
3. Only after step 2 is resolved, greet the landlord by name and show the menu.

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

If both are clean, GPT greets the landlord by name and shows the menu:

```
Olá, [nome]! O que você quer fazer?

1. Registrar pagamento
2. Ver inadimplentes
3. Gerar documento
4. Enviar para assinatura
5. Adicionar inquilino
6. Adicionar imóvel
7. Criar template
```

**API calls:**

| Method | Path | Auth | Response |
|--------|------|------|----------|
| GET | `/context` | Bearer JWT | Full landlord context snapshot |
| GET | `/templates/diff` | Bearer JWT | Detected changes vs Drive state |

---

## Flow 2 — Template Sync (diff non-empty)

**Trigger:** `GET /templates/diff` returns at least one change. Runs before the main menu.

The diff compares the landlord's Google Drive templates folder against the cached DB state. The GPT **lists all detected changes upfront**, then walks through each one interactively before showing the main menu.

**Opening message (example — 3 changes):**

```
Detectei mudanças nos templates:
- Novos: Contrato Residencial, Contrato Comercial
- Removidos: Aditivo Antigo

Vamos configurar cada um. Começando com Contrato Residencial — para quais tipos de imóvel ele se aplica?
1. Apartamento
2. Casa
3. Imóvel comercial
```

**Re-upload detection:** If the same template name appears in both `added` and `removed`, the GPT treats it as a re-upload (file deleted and re-uploaded to Drive, producing a new Drive file ID). Instead of asking property types from scratch, it asks:

```
O template "Contrato Residencial" parece ter sido re-enviado para o Drive.
Deseja manter as configurações anteriores? (tipos: Apartamento, Casa)
```

If the landlord confirms, the GPT uses the `property_types` from the `removed` entry (returned by the API — see #78) to call `POST /templates` without asking again. If they decline, the GPT asks for property types normally.

> **Note:** Re-upload detection requires `GET /templates/diff` to return `removed.templates` as `Array<{ name, property_types }>` instead of `string[]`. Tracked in [#78](https://github.com/tproenca/lease-bot/issues/78). Until that ships, the GPT will ask for property types even on re-uploads.

**Per-change actions:**

```
templates.added      → GPT asks: which property types apply? (numbered list)
                        ──POST /templates──────────────────────►
                          { drive_file_id, name,
                            placeholder_names[],
                            property_types[],
                            last_modified_at }
                        ◄──201 { id } ─────────────────────────

placeholders.added   → GPT asks per placeholder (one message each, no API
                          calls between them). Questions vary by format:

                          All formats: "Qual formato?"
                             1. Texto  2. Data  3. CPF  4. Inteiro  5. Moeda

                          Texto: "É obrigatório?" + "É derivado?"
                             (yes: campo+fórmula; no: "Valor padrão?")
                             + "Qual transformação?"
                               (1.Maiúsculas 2.Minúsculas 3.Título 4.Frase)
                             + "Deseja restringir valores?" → options[]
                          Data:  "É obrigatório?" + "É derivado?"
                             (yes: campo+fórmula; no: "Valor padrão?")
                             + "Qual formato de data?" (1.Normal 2.Por extenso)
                             — format always asked; derivation=computation,
                             format=display.
                          CPF:   "É obrigatório?" only
                          Inteiro: "É obrigatório?" + "É derivado?"
                             (yes: campo+fórmula; no: "Valor padrão?")
                          Moeda: "É obrigatório?" + "Valor padrão?"

                          If derived: set required=false.
                          Collect all, then show markdown table summary →
                          "Confirma?" → POST /placeholders.
                        ──POST /placeholders───────────────────►
                          [{ name, required, format, case,
                             default_value, derived_from,
                             derived_formula, options? }]
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

## Flow 3a — Generate Document (new tenant)

**Trigger:** Chained from Flow 7 (Add Tenant) when tenant was just added.

```
1. GPT identifies property and tenant (just created in Flow 7 — no selection needed)
2. GPT asks which template to use (shows numbered list filtered by property type)
3. GPT asks for each required placeholder not marked as derived AND not already
   known from context. Values available from context (tenant name, CPF, WhatsApp,
   property address) are filled automatically — the landlord is never asked to
   repeat information already in the system.
   If a placeholder has a non-empty options[], GPT presents those as a numbered
   list instead of asking for free text input.
4. GPT computes derived values (end date, amount in words, formatted CPF, etc.)
5. GPT shows complete summary of all placeholder values
6. GPT asks if want to generate the document
7. Landlord confirms with "Sim"

──POST /documents/generate───────────────────────────────────────►
  { tenant_id,
    values: { placeholder_name: value, ... } }
◄──200 [{ doc_id, url }] ────────────────────────────────────────
  (Drive URLs of generated documents)

7. GPT shows Drive links and asks if landlord wants to send for signature → Flow 4
```

---

## Flow 3b — Generate Document (existing tenant)

**Trigger:** Menu item "Gerar documento" when tenant already exists (renewal, addendum, or any other document).

```
1. GPT asks: which property? (shows numbered list)
2. GPT identifies the active tenant for that property from context (no need to
   ask for tenant name — it is already known)
3. GPT asks which template to use (shows numbered list filtered by property type)
   e.g.: 1. Contrato Residencial
         2. Aditivo de Renovação
4. GPT asks for each required placeholder not marked as derived AND not already
   known from context. Values available from context (tenant name, CPF, WhatsApp,
   property address) are filled automatically — the landlord is never asked to
   repeat information already in the system.
   If a placeholder has a non-empty options[], GPT presents those as a numbered
   list instead of asking for free text input.
5. GPT computes derived values
6. GPT shows complete summary
7. GPT asks if want to generate the document
8. Landlord confirms with "Sim"

──POST /documents/generate───────────────────────────────────────►
  { tenant_id,
    values: { placeholder_name: value, ... } }
◄──200 [{ doc_id, url }] ────────────────────────────────────────

8. GPT shows Drive links and asks if landlord wants to send for signature → Flow 4
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

**Trigger:** Menu item "Enviar para assinatura" or after generating a document.

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
2. GPT asks: reference month (MM/YYYY) (default: current month)
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

**Note:** Automated reminders are sent by pg_cron (no GPT involvement). Cron job failures are monitored externally via `GET /context/health/cron` and do not interrupt the GPT session.

**API calls:**

| Method | Path | Auth | Key fields |
|--------|------|------|------------|
| GET | `/payments` | Bearer JWT | `?month=YYYY-MM` |
| POST | `/payments/remind` | Bearer JWT | `tenant_id`, `reference_month` |

---

## Flow 7 — Add Tenant

**Trigger:** Menu item "Adicionar inquilino".

```
1. GPT asks: which property? (from context — shows numbered list)
2. GPT asks: name, CPF, WhatsApp (optional)
3. GPT shows summary + "Confirma? (Sim para continuar)"
   Note: if property already has an active tenant, GPT warns the
   previous tenant folder will be unstarred (archived in Drive)

──POST /tenants───────────────────────────────────────────────────►
  { property_id, name, cpf, whatsapp? }
◄──201 { id, drive_folder_id } ──────────────────────────────────
  (Drive folder created: Root/{Property}/{TenantName}/)

4. GPT confirms
5. GPT proceeds directly to contract generation (Flow 3)
   GPT: "Inquilino adicionado! Vamos gerar o contrato agora?
         (Diga "não" para fazer isso depois)"
   → if "não": return to menu
   → otherwise: continue to Flow 3 without requiring any extra input
```

**Happy path chain:** Add Tenant → Generate Contract (Flow 3) → Send for Signature (Flow 4)

**"Gerar contrato" stays in the menu** for cases where the landlord skipped it earlier, needs to regenerate after a template update, or rent/terms changed.

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

2. GPT asks: apartment name (unit identifier, e.g. "Apto 42")
   — do NOT ask for address; the building already has one
3. GPT shows summary + "Confirma? (Sim para continuar)"

──POST /properties────────────────────────────────────────────────►
  { type: "apartment", name, building_id }
◄──201 { id, drive_folder_id } ──────────────────────────────────
  (Drive folder created: Root/{Building}/{ApartmentName}/)
```

**API calls:**

| Method | Path | Auth | Key fields |
|--------|------|------|------------|
| POST | `/buildings` | Bearer JWT | `name`, `address` |
| POST | `/properties` | Bearer JWT | `type: "apartment"`, `name`, `building_id` |

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

## Flow 11 — Create Template _(planned)_

> **Status:** Not yet implemented. Tracked in [#77](https://github.com/tproenca/lease-bot/issues/77).

**Trigger:** Menu item "Criar template" or user intent ("quero criar um novo template", "preciso de um aditivo de renovação").

```
1. GPT asks: what kind of document? (e.g. contrato residencial, aditivo de renovação,
   recibo de entrega de chaves, contrato de comodato...)

2. GPT brainstorms with landlord:
   - What is the purpose of this document?
   - What clauses are mandatory? (e.g. prazo, valor, reajuste, multa)
   - What information needs to be captured per tenant?
     (name, CPF, address, rent amount, start date, duration...)
   - Are there any special clauses? (pets, guarantor, inventory list...)

3. GPT drafts the document in the chat, using {{placeholder}} tokens for
   dynamic fields and hardcoded text for fixed clauses.

4. Landlord reviews and iterates:
   - "adiciona uma cláusula sobre animais de estimação"
   - "remove a parte do fiador"
   - "o reajuste deve ser pelo IGPM anual"
   GPT updates the draft in the chat after each request.

5. GPT asks: which property types does this template apply to?
   1. Apartamento
   2. Casa
   3. Imóvel comercial

6. GPT asks: confirm the template name (shown as the Google Doc filename in Drive)

7. Landlord confirms with "Sim"

──POST /templates/create (new endpoint)──────────────────────────►
  { name, content (raw text with {{placeholders}}), property_types[] }
◄──201 { drive_file_id, template_id } ───────────────────────────
  (Google Doc created in landlord's templates folder)

8. GPT informs: "Template criado no Drive. Na próxima conversa vou detectar
   os placeholders automaticamente e pedir para configurá-los."

--- next session start ---

GET /templates/diff detects the new file → Flow 2 handles placeholder
configuration automatically (format, required, derived, etc.)
```

**Disclaimer:** GPT must remind the landlord that AI-generated legal text is a starting point and should be reviewed by a lawyer before use.

**New endpoint required:** `POST /templates/create`
- Accepts document name, raw text content, and property types
- Creates a Google Doc in the landlord's templates folder via Drive API
- Inserts the landlord row in the `templates` table
- Returns `{ drive_file_id, template_id }`

**What's already built (no changes needed):**
- `/templates/diff` automatically detects the new file on the next session
- Flow 2 handles placeholder metadata configuration
- `/documents/generate` handles substitution once placeholders are configured

**API calls:**

| Method | Path | Auth | Key fields |
|--------|------|------|------------|
| POST | `/templates/create` _(new)_ | Bearer JWT | `name`, `content`, `property_types[]` |

---

## Google Account Reconnection (`GOOGLE_REAUTH_REQUIRED`)

When any endpoint returns `401 GOOGLE_REAUTH_REQUIRED`, the landlord's Google connection has expired or been revoked. This happens when:

- The landlord revoked the app's Google access from their Google account settings
- The landlord changed their Google password
- Google rotated the token and the stored copy became stale
- The OAuth app is in Testing mode — tokens expire after 7 days

**What the GPT must do:** Inform the landlord that their Google Drive connection expired and ask them to reconnect via the "Connect account" button in ChatGPT (disconnect + reconnect the Google account in ChatGPT's account settings). Do **not** show a raw OAuth URL — the reconnect happens through ChatGPT's account connection UI.

**Example message:**

```
Sua conexão com o Google Drive expirou. Para continuar, reconecte sua conta Google:
acesse as configurações do ChatGPT, localize o Lease Assistant em "Apps conectados",
desconecte e conecte novamente.
```

**Affected endpoints:** All endpoints that call `refreshGoogleAccessToken` internally — including `/templates/diff`, `/documents/generate`, `/signatures/send`, `/tenants`, `/properties`, `/buildings`.

---

## API Quick Reference

| Method | Path | GPT-callable | Auth | Purpose |
|--------|------|:---:|------|---------|
| GET | `/context` | ✅ | Bearer JWT | Load all landlord data (called every session) |
| GET | `/context/health/cron` | ❌ monitor-only | Bearer service-role key | Cron health check — 200 ok / 503 error |
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
