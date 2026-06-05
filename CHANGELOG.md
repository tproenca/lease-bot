# Changelog

## Unreleased

### Added
- `docs/MILESTONE-GATES.md`: milestone-specific manual release-gate guide covering M2-M7, with gate rules, Pass/Fail/Blocked logging, and links back to the full manual runbook. (issue 237)

### Added
- `properties.current_tenant_id uuid references tenants` FK column added via migration `20260605000000_properties_current_tenant_id.sql`. Backfill: existing rows with a non-null `current_tenant_folder_id` are matched to the tenant whose `drive_folder_id` equals that folder ID and `current_tenant_id` is set accordingly. `POST /tenants` now writes both `current_tenant_id` and `current_tenant_folder_id` in the same `UPDATE` statement (ADR-0019 atomic write). `GET /properties` and `GET /context` now return `current_tenant_id` in the property payload. Active-tenant lookups in `GET /context`, `GET /payments`, and the `send_payment_reminders()` pg_cron function now use `properties.current_tenant_id` directly — the previous Drive folder string-matching (`current_tenant_folder_id = drive_folder_id`) is replaced. Migration `20260605000001_pg_cron_active_tenant_fk.sql` updates the pg_cron function accordingly. (issue 206)
- Deterministic derivation engine in `workflow/derivation/`: closed-grammar recursive-descent parser for `derived_formula` expressions, closed formula registry (`amount_in_words`, `full_date_text`, `end_date`), and topological resolver with sibling dependency support. `amount_in_words` produces deterministic Portuguese *por extenso* with no external dependencies. Structured errors: `UNKNOWN_FORMULA`, `UNRESOLVABLE_INPUT`, `CIRCULAR_DEPENDENCY`. ADR-0020 documents the design; `identity` and `cpf_format` excluded (see ADR-0020). (issue 198)
- `POST /workflow/next` — flow engine: `FlowDefinition.steps` may now be a function `(values) => FlowStep[]` resolved on every turn, enabling placeholder-driven dynamic step lists. Each `FlowStep` may declare an async `load(values, deps)` hook that fires once after `validate()` succeeds; the returned record is shallow-merged into values before the next step is resolved, supporting lazy data fetching between steps. Unit tests cover dynamic step resolution, load-hook timing, and load-hook result carry-forward. (issue 199)

### Fixed
- `GET /placeholders` (Lista de Placeholders Google Doc): fixed header row being rendered as a data row due to an extra blank line in table concatenation; reordered columns to Nome | Formato | Transformação | Padrão | Notas | Obrigatório; renamed "Campo base" to "Notas" and populated it with `derived_formula` for derived placeholders (em-dash otherwise). (issue 128)

### Changed
- `placeholders.derived_from` column dropped via migration `20260604213556_drop-derived-from.sql` (ADR-0017). Backfill: rows where `derived_from` was set and `derived_formula` was null have `derived_formula` populated with the bare-token identity value before the column is dropped. `POST /placeholders` now rejects payloads containing `derived_from` with `400 LEGACY_FIELD`. `derived_formula` is validated at write time against the closed grammar: bare context paths (e.g. `tenant.cpf`), sibling placeholder names, and function calls from the registry (`amount_in_words`, `full_date_text`, `end_date`); invalid expressions return `400 INVALID_FORMULA`. `buildPlaceholderListContent` in `google.ts` now derives the "Campo base" display column from `derived_formula` via `formatFormulaForDisplay` (null → "Perguntado"; bare tokens and function calls rendered as-is). `specs/openapi.yaml` already documents `derived_from` as removed. (issue 197)

### Changed
- Deleted `review-direction.md` — design decisions now fully captured in issues #199–#210 and ADRs 0016–0020.
- `POST /workflow/next`: cleaned up `WorkflowRequest`/`WorkflowResponse` contracts. Request: `collected` → `values`, `stage` removed. Response: `assistant_message` → `message`, `collected` → `values`, `stage`/`status` removed, `step` added (inferred from values present). `_machine_stage` and `_properties` no longer stored in values. Both `gpt/openapi.yaml` and `specs/openapi.yaml` updated. `gpt/SYSTEM_PROMPT.md` Flow 7 and `docs/GPT-FLOWS.md` updated to match. (issue 144)

### Fixed
- `GET /templates/diff`: "Lista de Placeholders" is now excluded from diff results alongside "Guia de Placeholders". Previously the dynamic reference doc was treated as a new template, causing the GPT to ask for property types. (issue 126)

### Changed
- `placeholders.derived_from` column dropped; the "base field" shown in the "Lista de Placeholders" Google Doc is now computed on the fly from `derived_formula` via regex (`/^[a-z_][a-z0-9_]*/i`). `POST /placeholders` no longer accepts `derived_from`; `GET /context` and `GET /placeholders` no longer return it. `gpt/SYSTEM_PROMPT.md` updated to remove `— derived_from=1º campo` from 3 flow prompts; `docs/GPT-FLOWS.md` and `gpt/openapi.yaml` updated accordingly. (issue 124)

### Added
- `GET /context/health/cron`: new sub-route of the `context` Edge Function. Returns `200 { status: "ok" }` when no `cron_errors` rows exist in the last 25 hours, or `503 { status: "error", errors: [...] }` otherwise. Authenticated with the service-role key for use by external uptime monitors (e.g. UptimeRobot). (issue 119)
- `gpt/SYSTEM_PROMPT.md`: removed cron error handling from Flow 1 and the `cron_errors` entry from the Erros section — cron failures are now monitored externally and no longer interrupt GPT sessions. (issue 119)
- `docs/GPT-FLOWS.md`: updated Flow 1 to remove cron error handling steps; updated Flow 6 note and API Quick Reference to reference the new health endpoint. (issue 119)

### Security
- `supabase/migrations/20260531012207_rls-app-config.sql`: enable Row Level Security on `public.app_config`. The Supabase security advisor flagged the table because RLS was disabled despite `REVOKE ALL` from `anon`/`authenticated`. No policies are added — deny-all by default is the intent. `SECURITY DEFINER` functions bypass RLS and are unaffected. (issue 118)
- `supabase/migrations/20260531012036_rls-oauth-codes.sql`: enable Row Level Security on `public.oauth_codes`. No `anon`/`authenticated` policies are added since the table is exclusively accessed via the service-role client (which bypasses RLS). Direct tenant-scoped access is now blocked at the DB layer, clearing the Supabase security advisor warning. (issue 96)

### Fixed
- `supabase/migrations/011_app_config_table.sql` (new migration): replaces the GUC-based (`ALTER DATABASE SET`) approach from migration 010 with an `app_config` key/value table. `send_payment_reminders()` now reads `service_role_key` and `functions_base_url` from `app_config` instead of `current_setting()`, eliminating the superuser requirement and the daily `cron_errors` rows that resulted from the silent skip in local dev. `REVOKE ALL` on `app_config` from `anon`/`authenticated` roles keeps secrets inaccessible to tenant requests. (issue 116)
- `supabase/migrations/010_local_dev_guc.sql` (new migration): sets `app.service_role_key` and `app.functions_base_url` GUC settings on `supabase db reset` so the `send_payment_reminders()` pg_cron job can reach Edge Functions internally. Guards prevent overwriting production values or failing in CI. Eliminates daily `cron_errors` rows in local dev. (issue 113)

### Fixed
- `POST /signatures/send`: `exportAndMergePdfs` now has a guard around its internal `refreshGoogleAccessToken` call. If the landlord's token is revoked between the initial Drive auth (step 6) and the export (step 7), the handler returns `401 GOOGLE_REAUTH_REQUIRED` instead of an unhandled `500`. Other export failures continue to return `502 PDF_EXPORT_FAILED`. (issue 107)
- All endpoints that call `refreshGoogleAccessToken` now return `401 GOOGLE_REAUTH_REQUIRED` (with a Portuguese reconnect hint) when Google responds with `invalid_grant`, instead of a generic `502 GOOGLE_AUTH_FAILED`. Other Google auth failures (network errors, 5xx from Google) continue to return `502 GOOGLE_AUTH_FAILED` unchanged. `docs/GPT-FLOWS.md` and `gpt/SYSTEM_PROMPT.md` updated so the GPT instructs the landlord to reconnect via ChatGPT's account settings. (issue 105)
- `GET /templates/diff`: now detects unconfigured placeholders by comparing `templates.placeholder_names` against the `placeholders` table. When a session is interrupted after the template is saved but before `POST /placeholders` completes, the next call correctly returns the missing names in `placeholders.added`, preventing the GPT from silently skipping Flow 2. The fast path only fires when there are zero template-level changes AND zero unconfigured placeholders. (issue 103)
- `POST /placeholders`: accepts GPT Actions' wrapped `{ placeholders: [...] }` request body while preserving bare-array compatibility, and the OpenAPI specs now document the wrapped request with `{ ids: [...] }` response. (issue 99)
- `GET /templates/diff`: `templates.added` now returns `Array<{ name, drive_file_id, last_modified_at }>` instead of `string[]`, giving the GPT the Drive file ID and real modifiedTime needed to call `POST /templates` correctly. (issue 98)
- `POST /templates`: accepts `last_modified_at` from the request body and stores the real Drive modifiedTime instead of `new Date()`, preventing false "Alterado" diffs on subsequent sessions. (issue 98)
- `templates` table: renamed `drive_last_modified_at` → `last_modified_at` and dropped unused `created_at` column (migration 008). (issue 98)

### Added
- `options text[]` nullable column on `placeholders` table (migration 008): allows landlords to define a restricted list of allowed values for text placeholders. During contract generation (Flow 3a/3b), the GPT presents the options as a numbered list instead of asking for free text input. During template sync (Flow 2), the GPT asks "Deseja restringir os valores?" after format selection when the format is `text`. (issue 97)
- `POST /placeholders` now accepts `options` (array of strings, optional); `GET /context` returns `options` per placeholder. (issue 97)
- `docs/sample-contract.md` and generated `_shared/sample-contract-content.ts` updated to include `{{estado_civil}}` placeholder as a realistic example of options usage. (issue 97)

### Added
- Embedded setup form in ChatGPT OAuth window: new landlords now complete onboarding in one uninterrupted flow without visiting a separate `/setup` URL. `GET /oauth/authorize` intercepts ChatGPT's `redirect_uri` and stores it in a cookie; `GET /auth/callback` checks for an existing landlord and either issues a one-time code directly (existing) or redirects to `/setup?via=oauth` (new); `POST /setup/complete` returns `redirect_to` so the form JS can close the OAuth window; `POST /oauth/token` redeems one-time codes from the new `oauth_codes` table before falling through to Google. (issue 89)
- `oauth_codes` DB table: short-lived (5 min), single-use codes bridging the setup form to ChatGPT's token exchange. (issue 89)
- ADR-0015: documents the cookie + one-time-code design for the embedded OAuth setup flow. (issue 89)

### Added
- `GET /oauth/authorize` and `POST /oauth/token`: thin proxy endpoints that forward requests to Google's OAuth authorization and token endpoints, enabling the GPT action OAuth config to satisfy OpenAI's root domain requirement. (issue 53)

### Added
- Unit tests for `GET /oauth/authorize` and `POST /oauth/token` proving both endpoints accept requests with no `Authorization` header and return non-401/403 responses; any future accidental JWT re-enablement will be caught in CI. (issue 56)
- Unit tests for `POST /webhooks/autentique/{landlord_id}` covering the no-`Authorization`-header path: the handler runs and returns 401 from its own HMAC check — not from Kong. (issue 56)

### Changed
- `gpt/SYSTEM_PROMPT.md`: reduce from 9,206 to 7,475 characters to fit the GPT Instructions field limit; onboarding script blocks replaced with concise behavioral rules and derivation/transformation rules extracted to `gpt/contract-rules.md` (Knowledge file). (issue 51)

### Added
- `gpt/contract-rules.md`: new Knowledge file containing derivation rules (data de término, valor por extenso, CPF formatado, data por extenso, derived_formula) and case transformation rules extracted from the system prompt. (issue 51)

### Fixed
- `POST /webhooks/autentique`: fix payload parsing to read `event.data.id` and
  `event.data.files.signed` (verified from a real `document.finished` capture);
  the previous `document.id` / `document.files.signed` paths always evaluated
  to `null`, silently dropping every webhook after HMAC verification. (issue 49)

### Changed
- `POST /webhooks/autentique` → `POST /webhooks/autentique/{landlord_id}`:
  per-landlord webhook endpoint. Each landlord registers their own webhook in
  their own Autentique account and stores the unique Endpoint Secret in the DB
  (`landlords.autentique_webhook_secret`). The handler looks up that secret by
  the path-parameter `landlord_id` and verifies HMAC-SHA256 against it. The
  global `AUTENTIQUE_WEBHOOK_SECRET` env var is removed — it could not scale
  across multiple landlords. Unknown landlord_id and DB lookup failures both
  return 401 (same response as bad signature, so landlord existence is not
  leaked). (issue 49)
- `POST /setup/complete`: now accepts and requires `autentique_webhook_secret`
  in the request body; validated with the same bounds/encoding rules as
  `autentique_api_key` and stored in `landlords.autentique_webhook_secret`.
  Returns 400 `MISSING_AUTENTIQUE_WEBHOOK_SECRET` when absent or malformed.
  (issue 49)
- `gpt/SYSTEM_PROMPT.md`: new "Onboarding inicial" section guiding the
  landlord conversationally (one value at a time) through API key creation
  and webhook registration before collecting Drive/WhatsApp fields. (issue 49)
- `GET /setup` HTML form: adds a webhook Endpoint Secret input alongside the
  API key, and displays the exact per-landlord webhook URL to paste into
  Autentique. (issue 49)

### Added
- `supabase/migrations/006_autentique_webhook_secret.sql`: adds
  `landlords.autentique_webhook_secret text not null` so each landlord stores
  the Endpoint Secret Autentique generates on webhook creation. (issue 49)
- `supabase/migrations/004_pg_cron_payment_reminders.sql`: registers the
  `send_payment_reminders` pg_cron job (daily at 12:00 UTC = 09:00 BRT).
  For each landlord with `payment_reminder_frequency` set to `daily` or
  `weekly`, the job finds active tenants with no payment for the current
  reference month, skips any tenant already reminded within the frequency
  window (24 h for daily, 7 days for weekly), and calls `POST /payments/remind`
  via `pg_net` with the service-role JWT.  Per-tenant failures are logged to
  `cron_errors` with `job_name = 'payment_reminder'` so they surface in
  `GET /context`.  Enables `pg_cron` and `pg_net` extensions with
  `IF NOT EXISTS` guards for idempotency. (issue 17)
- `PATCH /account/config` Edge Function: allows the landlord to update
  `payment_reminder_frequency` (`daily | weekly | disabled`) via the GPT.
  Validates the enum value, persists to `landlords.payment_reminder_frequency`
  using the authenticated user client (RLS-scoped), and returns the updated
  value. Returns 400 for invalid frequency values, 401 for missing/invalid JWT,
  500 for DB errors. `GET /context` reflects the updated value immediately.
  Integration tests cover all valid frequencies, invalid inputs, auth errors,
  DB failures, and method-not-allowed. (issue 18)
- `POST /payments/remind` Edge Function: GPT-triggered ad-hoc WhatsApp payment
  reminder. Sends a `payment_reminder` template via the Meta WhatsApp API to the
  tenant's stored number and records the attempt in `payment_reminders`.
  `sent_at` is set to the current timestamp on success and left null on failure.
  If the WhatsApp send fails, returns 422 `WHATSAPP_SEND_FAILED` (never 500) so
  the GPT can surface a helpful message. Validates `tenant_id` as UUID and
  `reference_month` in `YYYY-MM` or `YYYY-MM-DD` format. Returns 422 when the
  tenant has no WhatsApp number on file. 17 integration tests covering success,
  WhatsApp failure (non-500 response), missing/invalid inputs, 401, 404, and
  405 cases. (issue 16)
- `_shared/whatsapp.ts`: reusable Meta WhatsApp Business Cloud API client —
  `sendWhatsAppTemplate` sends pre-approved template messages, never throws,
  retries once on 5xx/network errors, and maps 401/403 → `invalid_token`,
  other 4xx → `client_error`, and persistent 5xx/network → `transient_error`.
  Reads `META_WHATSAPP_TOKEN` and `META_WHATSAPP_PHONE_ID` from env. 14 unit
  tests covering success, 401 (no retry), 5xx retry-succeeds, and
  5xx+5xx both-fail paths. (issue 15)
- `POST /webhooks/autentique` Edge Function: receives Autentique's signed-document
  notification, verifies the HMAC-SHA256 signature (`x-autentique-signature` header,
  `AUTENTIQUE_WEBHOOK_SECRET` env var, timing-safe comparison) before any payload
  processing, downloads the signed PDF, uploads it to the tenant's Drive folder as
  `contrato-assinado-{tenant_id}.pdf`, and marks `signature_requests.status = 'completed'`.
  Returns 200 immediately for all authenticated requests; idempotent on duplicates;
  silent 200 for unknown documents (does not expose internal IDs). Uses service-role
  client (no user JWT for webhooks — approved per specs/SECURITY.md). (issue 14)
- Unit tests for `POST /webhooks/autentique`: valid webhook end-to-end success, invalid
  HMAC (401), duplicate already-completed request (200 no-op), unknown document (200
  silent), malformed payload, missing fields, and resilience against downstream failures
  (PDF download, Drive upload, Google token refresh, DB lookup). (issue 14)
- `POST /signatures/send` Edge Function: exports tenant Google Docs to PDF via Drive, merges
  them with pdf-lib, detects `[[LOCADOR]]`/`[[LOCATARIO]]`/`[[TESTEMUNHA_N]]` signature markers,
  submits the merged PDF to Autentique with DELIVERY_METHOD_WHATSAPP, and records the request
  in `signature_requests`. Returns `{ id, autentique_document_id }`. Retries Autentique submission
  up to 3× with exponential backoff; on final failure returns 502 with Drive URLs so the landlord
  can retry. Returns 422 if signature markers are absent or no documents exist in the tenant folder. (issue 13)
- `GET /signatures/:id/status` Edge Function: returns `{ status, created_at, completed_at, signers }`
  combining the DB record with live per-signer `signed_at` timestamps from Autentique GraphQL. (issue 13)
- `PATCH /signatures/:id/reminder` Edge Function: updates signing reminder frequency (DAILY/WEEKLY)
  on Autentique via GraphQL mutation. Validates `frequency` is exactly "DAILY" or "WEEKLY". (issue 13)
- `submitDocument`, `getDocumentStatus`, `updateReminderFrequency` functions added to
  `_shared/autentique.ts`: full Autentique GraphQL signing integration using multipart upload
  for PDF submission and standard GraphQL for status query and reminder update. (issue 13)
- `documents/signatures/detect.ts` internal module: scans merged PDF bytes for `[[ROLE]]`
  marker strings and returns page/coordinate positions for Autentique signer placement. (issue 13)
- Unit tests for all new autentique.ts functions, send handler, and status/reminder handler (issue 13)
- `documents/signatures/detect` internal module: scans the last page of a merged
  PDF for signature blocks (underscore lines + role labels) and returns
  Autentique-compatible signer coordinates `{ name, role, x, y, page }`.
  Detects `Inquilino` → `"tenant"`, `Locador` → `"landlord"`, any other label →
  `"witness"`. Falls back gracefully to `{ ok: false, error }` with a
  user-friendly Portuguese message when no markers are found. Implementation
  decompresses pdf-lib's zlib content streams with Deno's built-in
  `DecompressionStream` and parses PDF content-stream operators (Tm, Td, Tj, TJ).
  22 unit tests covering standard 3-signer layout, missing markers, witness with
  custom name, single-signer edge case, multi-page PDFs, and role classification.
  ADR-0012 documents the content-stream parsing approach. (issue 12)
- `documents/export` internal helper module: exports Google Docs to PDF via the
  Drive API (using the landlord's stored OAuth refresh token) and merges them into
  a single bundle in document order using pdf-lib. Returns `{ ok: true; pdf:
  Uint8Array; pageCount: number }` on success or `{ ok: false; failedUrl: string;
  driveUrl: string; error: string }` on any export failure. Drive calls retry up to
  3× with exponential backoff. Unit tests with mocked Drive API; integration tests
  with stubbed Drive/pdf-lib against a real local Supabase instance. (issue 11)
- `POST /documents/generate` Edge Function: substitution engine that looks up templates
  mapped to the property's type, copies each to the tenant's Drive folder, replaces all
  `{{placeholder}}` tokens with provided values (applying `maiúsculas`/`minúsculas`/`título`/`frase`
  case transformations), and returns Drive URLs. Regeneration atomically overwrites existing files.
  Returns 422 if any required placeholder is missing; retries Drive API up to 3× with exponential
  backoff on 429/500 errors. Unit tests for `applyCase` and `substituteTokens`; integration tests
  covering 200/400/401/404/422/502 cases and regeneration overwrite. (issue 10)
- `POST /templates`, `DELETE /templates/:id` Edge Functions: register and remove lease templates
  with property-type mappings. Inserts into `templates` and `property_type_templates` tables. (issue 8)
- `POST /placeholders`, `DELETE /placeholders/:name` Edge Functions: manage placeholder definitions.
  After any change, regenerates the "Guia de Placeholders" Google Doc in the landlord's Templates
  Drive folder. Unique-constraint violation returns 409. DELETE is idempotent. (issue 8)
- `POST /witnesses` Edge Function: register a witness by name and WhatsApp. Unique-constraint
  violation returns 409. (issue 8)
- `upsertGuiaDePlaceholders` helper added to `_shared/google.ts`: creates or updates the
  "Guia de Placeholders" Google Doc via Drive multipart upload. (issue 8)
- Integration tests for all five new endpoints covering 201/204/401/404/409/400 cases (issue 8)
- `POST /payments` Edge Function: records a received payment and computes `on_time` (paid on or
  before the 5th of the reference month at 23:59:59 UTC). Accepts `reference_month` as `YYYY-MM`
  or `YYYY-MM-DD`. Returns `{ id, on_time }`. (issue 9)
- `GET /payments?month=YYYY-MM` Edge Function: returns paid tenants with amounts and overdue
  active tenants with last reminder timestamp for the given month. (issue 9)
- Integration tests for `POST /payments` and `GET /payments` endpoints (issue 9)
- `POST /tenants`, `GET /tenants/:id`, `PATCH /tenants/:id` Edge Function: tenant CRUD with
  Drive folder lifecycle management — creates tenant folder inside the property folder, stars it,
  unstars previous tenant folder (if any), and updates `properties.current_tenant_folder_id`
  atomically. CPF validated as XXX.XXX.XXX-XX; WhatsApp validated as Brazilian E.164 (+55…).
  `GET /tenants/:id` returns 404 if not found or belongs to another landlord. `PATCH /tenants/:id`
  updates `whatsapp` only. (issue 7)
- `starDriveFile` and `unstarDriveFile` utilities added to `_shared/google.ts` (issue 7)
- Integration tests for all three tenant endpoints (issue 7)
- `GET /templates/diff` Edge Function: fast-path diff (< 200 ms when no changes) comparing Drive
  `modifiedTime` against DB cache; slow path re-reads changed templates, extracts `{{placeholder}}`
  tokens, detects witness names from signature blocks, updates DB cache, and returns added/removed
  diffs. `Guia de Placeholders` excluded by exact name match (issue 6)
- `listDriveFilesInFolder` and `exportDriveFileAsText` utilities added to `_shared/google.ts` (issue 6)
- Unit and integration tests for `GET /templates/diff`: fast path, slow path, placeholder extraction,
  witness detection, Guia exclusion, 401, 405, CORS, OPTIONS (issue 6)
- `POST /buildings` Edge Function: creates a Drive subfolder under Root/{BuildingName}/
  and persists the building row with `drive_folder_id` (issue 5)
- `POST /properties` Edge Function: creates a Drive folder (inside building folder for
  apartments; under root for house/commercial) and persists the property row (issue 5)
- `GET /properties` Edge Function: returns all properties for the authenticated landlord (issue 5)
- Integration tests for all three buildings/properties endpoints (issue 5)
- `GET /context` Edge Function: returns landlord info, properties, buildings,
  templates with property type mappings, placeholder definitions, witnesses,
  account config, and cron errors from the last 24 h (issue 4)
- Supabase project scaffolding (`supabase/`, `deno.json`)
- Database migrations: full schema for all 11 tables with RLS policies (issue 1.1)
- GPT system prompt and configuration artifacts in `gpt/` (issue 1.10)
- Onboarding flow: `GET /setup`, `GET /auth/callback`, `POST /setup/complete`
  Edge Functions, with Google OAuth + Drive Picker, Autentique API key
  validation, and Templates/ folder creation (issue 1.2)
- Unit and integration tests for `validation.ts`, `cookies.ts`, `google.ts`,
  `autentique.ts`, and `setup/complete` input rejection (issue 1.2)
- ADR-0010: Vault encryption deferred with documented interim mitigations (issue 1.2)

### Changed
- `POST /setup/complete` CORS restricted to same origin (`PUBLIC_FUNCTIONS_BASE_URL`
  or `SUPABASE_URL`) instead of wildcard `*` (issue 1.2)
- `GET /setup` pre-auth page reuses existing CSRF state cookie instead of
  regenerating on every reload (issue 1.2)
- `validateAutentiqueApiKey` enforces upper bound (≤ 256 chars) and rejects
  control characters and internal whitespace before using key in HTTP header (issue 1.2)
- `specs/SECURITY.md` updated: documents Vault deferral, service-role usage,
  and CORS restriction rationale (issue 1.2)
