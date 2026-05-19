# Changelog

## Unreleased

### Added
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
