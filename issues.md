# issues.md — Lease Assistant

Status values: `todo` | `in-progress` | `done`

---

## Batch Plan

Issues within the same batch can be worked in parallel. Start the next batch only when all issues in the current batch are `done`.

| Batch | Issues | Depends on |
|-------|--------|------------|
| 1A | 1.1, 1.10 | — |
| 1B | 1.2 | 1A |
| 1C | 1.3, 1.4, 1.6 | 1B |
| 1D | 1.5 | 1C |
| 1E | 1.7, 1.9 | 1D |
| 1F | 1.8 | 1E |
| 2A | 2.1 | 1F |
| 2B | 2.2 | 2A |
| 2C | 2.3 | 2B |
| 2D | 2.4 | 2C |
| 3A | 3.1 | 2D |
| 3B | 3.2 | 3A |
| 3C | 3.3 | 3B |
| 3D | 3.4 | 3C |
| 4A | 4.1 | 3D |
| 4B | 4.2 | 4A |

---

## Phase 1 — Core Product

---

### 1.1 — Database schema and RLS

**Status:** done
**Dependencies:** none

Create all Supabase migration files. Apply RLS policies to enforce landlord isolation on every table.

**Tables:** `landlords`, `buildings`, `properties`, `tenants`, `templates`, `placeholders`, `property_type_templates`, `witnesses`, `payments`, `payment_reminders`, `signature_requests`, `cron_errors`

**Acceptance criteria:**
- [ ] One migration file per logical group (e.g. `001_core_schema.sql`, `002_payments.sql`, `003_signatures.sql`)
- [ ] Every table has an RLS policy: landlord can only read/write rows where `landlord_id = auth.uid()`
- [ ] `supabase db reset` applies all migrations cleanly with no errors
- [ ] Foreign key cascade rules match `DESIGN.md` (e.g. `property_type_templates` cascade-deletes on template removal)

---

### 1.2 — Onboarding flow

**Status:** done
**Dependencies:** 1.1

Three Edge Functions serving the first-time setup flow:

- `GET /setup` — serve pre-auth HTML ("Connect with Google" button) or post-auth HTML (Drive Picker + templates folder name + WhatsApp input)
- `GET /auth/callback` — exchange Google OAuth code for tokens, create Supabase session, redirect to `/setup`
- `POST /setup/complete` — validate Autentique API key (test call to Autentique), create `Templates/` folder in Drive if it doesn't exist, persist `root_folder_id`, `templates_folder_id`, `whatsapp`, and `autentique_api_key` to `landlords` table

**Acceptance criteria:**
- [ ] Unauthenticated visit to `/setup` renders pre-auth HTML with Google OAuth link
- [ ] Completing OAuth redirects back to `/setup` in post-auth state
- [ ] Submitting the form calls `POST /setup/complete` and creates the landlord record
- [ ] Autentique API key is validated against the Autentique API before storing; returns 400 with clear error if invalid
- [ ] `autentique_api_key` is stored encrypted via Supabase Vault in `landlords.autentique_api_key`
- [ ] `Templates/` Drive folder is created under the selected root folder and its ID stored in DB
- [ ] Visiting `/setup` after setup is complete shows a confirmation page with GPT link
- [ ] Google refresh token is persisted in `landlords.google_refresh_token`

---

### 1.3 — GET /context

**Status:** todo
**Dependencies:** 1.1, 1.2

Implement `GET /context` — the GPT's primary data loading endpoint called at conversation start.

**Returns:** landlord info, all properties, all buildings, all templates with property type mappings, all placeholder definitions, all witnesses, account config (payment reminder frequency).

**Acceptance criteria:**
- [ ] Returns correct data for the authenticated landlord only
- [ ] `cron_errors` from the last 24h are included in the response so the GPT can surface them
- [ ] Returns 401 for missing or invalid JWT
- [ ] Response shape matches `DESIGN.md` exactly

---

### 1.4 — Buildings and properties

**Status:** todo
**Dependencies:** 1.1, 1.2

Implement building and property management endpoints plus Drive folder creation.

**Endpoints:** `POST /buildings`, `POST /properties`, `GET /properties`

**Folder structure per property type (created in Drive on POST):**
- Apartment: `Root/{BuildingName}/{ApartmentName}/`
- House: `Root/{PropertyName}/`
- Commercial: `Root/{PropertyName}/`

**Acceptance criteria:**
- [ ] `POST /buildings` creates Drive folder under root and persists `drive_folder_id`
- [ ] `POST /properties` with `type=apartment` requires `building_id` and creates folder inside building folder
- [ ] `POST /properties` with `type=house` or `type=commercial` creates folder directly under root
- [ ] `GET /properties` returns all properties for the authenticated landlord
- [ ] Returns 400 for missing required fields; returns 404 if `building_id` not found or belongs to another landlord

---

### 1.5 — Tenant management

**Status:** todo
**Dependencies:** 1.1, 1.4

Implement tenant creation with Drive folder lifecycle management.

**Endpoints:** `POST /tenants`, `GET /tenants/:id`, `PATCH /tenants/:id`

**Drive side effects on `POST /tenants`:**
1. Create `Root/{property}/{tenantName}/` folder
2. Star the new folder
3. Unstar the previous `current_tenant_folder_id` folder (if exists)
4. Update `properties.current_tenant_folder_id`

**Acceptance criteria:**
- [ ] New tenant folder is created in the correct Drive location per property type
- [ ] New folder is starred; previous tenant folder is unstarred
- [ ] `properties.current_tenant_folder_id` is updated atomically with the Drive operations
- [ ] `GET /tenants/:id` returns tenant data; 404 if not found or belongs to another landlord
- [ ] `PATCH /tenants/:id` updates `whatsapp` only
- [ ] Replacing a tenant on an already-occupied property correctly archives the previous tenant

---

### 1.6 — Template diff (GET /templates/diff)

**Status:** todo
**Dependencies:** 1.1, 1.2

Implement `GET /templates/diff` — the read-only endpoint the GPT calls to detect template changes.

**Logic:**
- Fast path: all Drive `modifiedTime` values match DB cache → return empty diff immediately
- Slow path: re-read changed templates from Drive, extract `{{placeholder}}` patterns, compare against DB
- Also extract witness names from signature blocks (hardcoded names below `_____` lines)

**Returns:** `{ templates: { added, removed }, placeholders: { added, removed }, witnesses: { added } }`

**Notes:**
- The `Guia de Placeholders` doc must be excluded from scanning (matched by exact name)
- Placeholder names from unchanged templates come from `templates.placeholder_names` DB cache

**Acceptance criteria:**
- [ ] Fast path returns in <200ms when no templates have changed
- [ ] Slow path correctly identifies new and removed `{{placeholder}}` tokens
- [ ] Witness names detected from signature blocks appear in `witnesses.added`
- [ ] `Guia de Placeholders` is never included in the diff
- [ ] Returns 200 with all-empty arrays when there are no changes

---

### 1.7 — Template and placeholder management

**Status:** todo
**Dependencies:** 1.1, 1.6

Implement endpoints to register templates, define placeholders, and manage witnesses — called by the GPT after the landlord resolves a non-empty diff.

**Endpoints:** `POST /templates`, `DELETE /templates/:id`, `POST /placeholders`, `DELETE /placeholders/:name`, `POST /witnesses`

**Acceptance criteria:**
- [ ] `POST /templates` persists `drive_file_id`, `name`, `placeholder_names[]`, and `property_types[]` (writes to `property_type_templates`)
- [ ] `DELETE /templates/:id` cascade-deletes `property_type_templates` rows
- [ ] `POST /placeholders` validates `format` is one of: `text | date | cpf | integer | currency`
- [ ] `DELETE /placeholders/:name` removes placeholder and its DB entries
- [ ] `POST /witnesses` stores name + WhatsApp; returns 409 if name already exists for landlord
- [ ] Auto-generates or updates `Guia de Placeholders` doc in Templates/ after any placeholder change

---

### 1.8 — Document generation

**Status:** todo
**Dependencies:** 1.1, 1.5, 1.7

Implement `POST /documents/generate` — the substitution engine.

**Logic:**
1. Look up templates mapped to the property's type (`property_type_templates`)
2. For each template: copy the Google Doc to the tenant's Drive folder
3. Replace all `{{placeholder}}` tokens with the provided values
4. Apply case transformations (`maiúsculas | minúsculas | título | frase`)
5. Return Drive URLs of generated documents

Regeneration overwrites the existing file (copy → replace → overwrite).

**Acceptance criteria:**
- [ ] Only templates mapped to the property's type are used
- [ ] All `{{placeholder}}` tokens are replaced; no token survives in the output
- [ ] Case transformations are applied correctly for each placeholder's `case` setting
- [ ] Generated docs are saved to `Root/{property}/{tenant}/` and Drive URLs returned
- [ ] Regenerating for the same tenant overwrites the previous files
- [ ] Returns 422 if any required placeholder value is missing from the request body
- [ ] Drive API retries up to 3× with exponential backoff on 429/500

---

### 1.9 — Manual payment tracking

**Status:** todo
**Dependencies:** 1.1, 1.5

Implement payment recording and status query.

**Endpoints:** `POST /payments`, `GET /payments?month=YYYY-MM`

**GET /payments** returns:
- `paid`: tenants who paid in the given month (amount, paid_at, on_time)
- `overdue`: active tenants with no payment in the given month (with `last_reminder_sent_at`)

**Acceptance criteria:**
- [ ] `POST /payments` records payment and computes `on_time` (true if `paid_at` ≤ due date — assume 5th of the month)
- [ ] `GET /payments` correctly separates paid and overdue tenants for the given month
- [ ] `last_reminder_sent_at` is populated from `payment_reminders` table (null if no reminder sent)
- [ ] Returns 400 if `reference_month` format is invalid

---

### 1.10 — GPT configuration artifacts

**Status:** done
**Dependencies:** none

Write the GPT source-of-truth files. These are markdown files committed to the repo; the developer copies the content into the OpenAI Custom GPT configuration manually.

**Files:**
- `gpt/SYSTEM_PROMPT.md` — Portuguese language, intents surface, confirmation protocol ("Sim"), derived field computation rules (date arithmetic, CPF formatting, totals), API usage instructions, context loading on start
- `gpt/GPT_CONFIG.md` — GPT name, description, conversation starters, capability settings (no code interpreter, no browsing, enable actions)

**Acceptance criteria:**
- [ ] System prompt covers all intents from `DESIGN.md` (document generation, tenant management, payment tracking, template management)
- [ ] Confirmation protocol is explicit: GPT must show full summary and require "Sim" before calling `POST /documents/generate` or `POST /signatures/send`
- [ ] Derived field computation rules are unambiguous (e.g. "data de término = data de início + duração em meses")
- [ ] GPT_CONFIG.md lists at least 4 conversation starters covering the main intents

---

## Phase 2 — E-Signature

---

### 2.1 — PDF export and merge

**Status:** todo
**Dependencies:** 1.8

Export generated Google Docs to PDF and merge into a single bundle using pdf-lib.

Called internally by `POST /signatures/send` before submitting to Autentique.

**Acceptance criteria:**
- [ ] Each generated Google Doc is exported to PDF via Drive API (export MIME type `application/pdf`)
- [ ] All PDFs are merged into one bundle in document order using pdf-lib
- [ ] Returns a structured error if any export fails (includes Drive URLs so landlord can retry)
- [ ] Merged PDF page count equals the sum of individual document page counts

---

### 2.2 — Signature position detection

**Status:** todo
**Dependencies:** 2.1

Scan the last page of the merged PDF for signature blocks and return Autentique-compatible signer coordinates.

**Detection logic:** scan for `_____________________________` line pattern; the label below each line identifies the signer (Inquilino / Locador / witness name).

**Acceptance criteria:**
- [ ] Detects tenant (Inquilino), landlord (Locador), and witness signature positions correctly
- [ ] Returns `{ name, role, x, y, page }` per detected signer
- [ ] Falls back gracefully when markers are not found: returns structured error with instructions for manual positioning
- [ ] Unit test coverage ≥90% for the detection logic

---

### 2.3 — Autentique integration

**Status:** todo
**Dependencies:** 2.1, 2.2, 1.1

Implement signing submission and status endpoints.

**Endpoints:** `POST /signatures/send`, `GET /signatures/:id/status`, `PATCH /signatures/:id/reminder`

**Autentique flow:**
1. Read `landlords.autentique_api_key` for the authenticated landlord
2. Submit merged PDF + signers (tenant WhatsApp, landlord WhatsApp, witnesses) with `DELIVERY_METHOD_WHATSAPP`
3. Configure `DAILY` signing reminders at submission time
4. Persist `autentique_document_id` in `signature_requests`

**Acceptance criteria:**
- [ ] `POST /signatures/send` submits via Autentique GraphQL API and returns `autentique_document_id`
- [ ] All signers (tenant, landlord, witnesses) are included with correct WhatsApp numbers
- [ ] `GET /signatures/:id/status` returns current status and per-signer signed_at timestamps
- [ ] `PATCH /signatures/:id/reminder` updates reminder frequency on Autentique
- [ ] Autentique API retries up to 3× with exponential backoff; returns Drive URLs on failure so landlord can retry

---

### 2.4 — Autentique webhook handler

**Status:** todo
**Dependencies:** 2.3

Implement `POST /webhooks/autentique` — receives signed document notification from Autentique.

**Logic:**
1. Verify `x-autentique-signature` HMAC-SHA256 header
2. Check idempotency (`autentique_document_id` already processed → return 200 immediately)
3. Download signed PDF from Autentique
4. Save to `Root/{property}/{tenant}/Contrato Assinado.pdf` in Drive
5. Update `signature_requests.status = 'completed'` and `completed_at`

**Acceptance criteria:**
- [ ] Requests with invalid HMAC signature return 401 and are not processed
- [ ] Duplicate webhook calls for the same document return 200 without re-processing
- [ ] Signed PDF is saved to the correct tenant folder in Drive
- [ ] `signature_requests` record is updated correctly
- [ ] Returns 200 immediately before processing (prevents Autentique retry storms)

---

## Phase 3 — WhatsApp Reminders

---

### 3.1 — Meta WhatsApp API client

**Status:** todo
**Dependencies:** 1.1

Implement a reusable internal module for sending WhatsApp messages via Meta Business Cloud API.

**Used by:** `POST /payments/remind` (3.2) and the pg_cron job (3.3).

**Acceptance criteria:**
- [ ] Sends a pre-approved message template to a given WhatsApp number
- [ ] Returns success/failure without throwing (callers handle errors)
- [ ] Retries once on transient failure before returning failure
- [ ] Message template name and parameters are configurable (not hardcoded)
- [ ] `META_WHATSAPP_TOKEN` and `META_WHATSAPP_PHONE_ID` are read from secrets, never hardcoded

---

### 3.2 — Ad-hoc payment reminder

**Status:** todo
**Dependencies:** 3.1, 1.9

Implement `POST /payments/remind` — GPT-triggered reminder to a specific tenant for a specific month.

**Logic:** send WhatsApp via Meta API, record in `payment_reminders`, return success.

**Acceptance criteria:**
- [ ] Sends WhatsApp message to the tenant's stored number
- [ ] Records the reminder in `payment_reminders` with correct `tenant_id`, `reference_month`, `sent_at`
- [ ] If WhatsApp send fails, records with `sent_at = null` and returns a non-500 error response
- [ ] `GET /payments` for the same month reflects updated `last_reminder_sent_at` after this call

---

### 3.3 — Scheduled payment reminders (pg_cron)

**Status:** todo
**Dependencies:** 3.1, 3.2

Set up a pg_cron job that sends automatic payment reminders to overdue tenants according to each landlord's configured frequency.

**Logic:**
- Job runs daily at 09:00 BRT
- For each landlord with `payment_reminder_frequency != 'disabled'`:
  - Find active tenants with no payment in the current reference month
  - Check if a reminder was already sent within the frequency window (daily/weekly)
  - If not, call `POST /payments/remind` logic (or invoke directly)
  - Log failures to `cron_errors`

**Acceptance criteria:**
- [ ] pg_cron job is registered in a migration file (not manually)
- [ ] Respects per-landlord `payment_reminder_frequency` setting
- [ ] Does not double-send: checks `payment_reminders` before sending
- [ ] Failures are written to `cron_errors` with `job_name` and error message
- [ ] `GET /context` surfaces unresolved `cron_errors` from the last 24h

---

### 3.4 — Reminder frequency configuration

**Status:** todo
**Dependencies:** 3.3, 3.2

Allow the landlord to update payment reminder frequency via the GPT.

**Add endpoint:** `PATCH /account/config` — updates `landlords.payment_reminder_frequency`

**Acceptance criteria:**
- [ ] `PATCH /account/config` accepts `payment_reminder_frequency: daily | weekly | disabled` and persists it
- [ ] `GET /context` returns the updated frequency immediately
- [ ] `GET /payments` overdue list includes `last_reminder_sent_at` for each overdue tenant

---

## Phase 4 — Pix Integration

---

### 4.1 — Pix QR code generation

**Status:** todo
**Dependencies:** 1.9

Generate a Pix QR code per tenant per reference month for unambiguous payment matching.

**Acceptance criteria:**
- [ ] `GET /payments/pix-qr?tenant_id=&month=YYYY-MM` returns a Pix QR code (static or dynamic, per PSP integration)
- [ ] QR code payload includes a unique identifier linking back to `tenant_id` + `reference_month`
- [ ] Returns 404 if tenant does not belong to the authenticated landlord

---

### 4.2 — Pix webhook integration

**Status:** todo
**Dependencies:** 4.1, 1.9

Receive automatic payment notifications from the PSP via Pix webhook and record them as payments.

**Acceptance criteria:**
- [ ] `POST /webhooks/pix` verifies webhook authenticity per the PSP's mechanism
- [ ] Matches incoming payment to `tenant_id` + `reference_month` via the QR code identifier
- [ ] Records payment in `payments` table (marks `on_time` based on `paid_at`)
- [ ] Idempotent: duplicate notifications for the same payment are ignored
- [ ] Unmatched payments are logged and do not cause a 500

---
