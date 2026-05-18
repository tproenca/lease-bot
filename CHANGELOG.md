# Changelog

## Unreleased

### Added
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
