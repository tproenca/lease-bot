# Changelog

## Unreleased

### Added
- `PATCH /account/config` Edge Function: allows the landlord to update
  `payment_reminder_frequency` (`daily | weekly | disabled`) via the GPT.
  Validates the enum value, persists to `landlords.payment_reminder_frequency`
  using the authenticated user client (RLS-scoped), and returns the updated
  value. Returns 400 for invalid frequency values, 401 for missing/invalid JWT,
  500 for DB errors. `GET /context` reflects the updated value immediately.
  Integration tests cover all valid frequencies, invalid inputs, auth errors,
  DB failures, and method-not-allowed. (issue 18)
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
