# Changelog

## Unreleased

### Added
- Supabase project scaffolding (`supabase/`, `deno.json`)
- Database migrations: full schema for all 11 tables with RLS policies (issue 1.1)
- GPT system prompt and configuration artifacts in `gpt/` (issue 1.10)
- Onboarding flow: `GET /setup`, `GET /auth/callback`, `POST /setup/complete`
  Edge Functions, with Google OAuth + Drive Picker, Autentique API key
  validation, and Templates/ folder creation (issue 1.2)
