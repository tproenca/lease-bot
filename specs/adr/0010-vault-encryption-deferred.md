# ADR-0010: Vault Encryption of Sensitive Columns Deferred
Date: 2026-05-18
Status: Accepted

## Context
`specs/SECURITY.md` requires that `landlords.google_refresh_token` and
`landlords.autentique_api_key` be encrypted at rest via Supabase Vault (the
`pgsodium`-backed secret store built into Supabase PostgreSQL).

The standard Vault pattern stores a plaintext secret via `vault.create_secret(value)`
which returns a UUID, then stores that UUID in the application column. Reads
use `vault.decrypted_secrets` to dereference the UUID back to the plaintext.
This requires:
1. `[db.vault]` enabled in `supabase/config.toml` with a `secret_key` env var.
2. Column type changed from `text not null` to `uuid not null` (storing the
   Vault secret ID), with a forward-only migration.
3. Edge Functions to call `vault.create_secret` on write and read from
   `vault.decrypted_secrets` on read — requiring a raw SQL RPC (Supabase JS
   client has no typed Vault helper as of the current SDK version).

## Decision
Defer Vault column encryption to a follow-up task. Immediate mitigations in place:

- **Encryption at rest via Supabase platform:** Supabase PostgreSQL runs on
  encrypted-at-rest storage (AES-256) at the infrastructure level. Both columns
  are protected by the same disk-level encryption that covers all Supabase data.
- **RLS access control:** `landlords` has an RLS policy `id = auth.uid()`, so no
  landlord JWT can read another landlord's row. The `google_refresh_token` and
  `autentique_api_key` columns are only accessible to the service-role key,
  which never leaves the server tier.
- **Never logged:** both values are excluded from all log output and error
  responses (enforced in `setup/complete/index.ts`).

The gap vs. the spec is that a database-level compromise (e.g. a SQL dump with
the service-role key) would expose the raw token/key strings rather than
requiring a Vault key to decrypt them. This is an acceptable interim risk given
the scale (~10 landlords) and timeline, but must be resolved before the product
reaches a broader audience.

## Follow-up Required
- Enable `[db.vault]` in `supabase/config.toml`.
- Add migration `004_vault_encrypt_landlord_secrets.sql`:
  - Change `google_refresh_token` and `autentique_api_key` columns to `uuid`.
  - Backfill existing rows via `vault.create_secret(current_value)`.
- Update `setup/complete/index.ts` to call `vault.create_secret` on insert and
  read via `vault.decrypted_secrets` in any future endpoint that needs these
  values.
- Update `specs/SECURITY.md` once Vault is live.

## Alternatives Considered
- **Application-layer encryption (AES-GCM in Edge Function):** encrypt before
  insert, decrypt after select. Would require managing an encryption key env var,
  adds complexity, and Supabase Vault does the same thing with better key
  management. Deferred for the same reason.
- **Implement Vault now with raw SQL RPC:** feasible but the migration +
  SDK-level raw SQL adds ~2 days of work and integration test complexity for a
  feature with no user-visible effect. Deferred.

## Consequences
- `specs/SECURITY.md` is updated to record this deferral explicitly.
- Any future issue that touches `landlords.google_refresh_token` or
  `landlords.autentique_api_key` must pick up the Vault migration as a
  dependency.
