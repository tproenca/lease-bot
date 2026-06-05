# ADR-0009: Google OAuth via Supabase signInWithIdToken
Date: 2026-05-18
Status: Accepted

## Context
The onboarding flow (issue 1.2) needs two things from a single Google OAuth round-trip:

1. A Supabase Auth session bound to the landlord's Google identity, so subsequent API calls verify via standard JWT.
2. A Google **refresh token** with the `drive` scope, persisted server-side so Edge Functions can mint Drive access tokens later.

Supabase's built-in Google provider performs the OAuth dance itself but does **not** expose Google's refresh token to the application — the token stays inside Supabase Auth and is not retrievable by Edge Functions. That is incompatible with our need to call the Drive API on behalf of the landlord days or weeks after onboarding.

## Decision
Run the OAuth flow ourselves from `/auth/callback`:

1. Build the consent URL with `access_type=offline` and `prompt=consent` so Google always returns a refresh token.
2. Exchange the code at Google's token endpoint and capture `refresh_token` + `id_token`.
3. Create the Supabase session by passing the `id_token` to `auth.signInWithIdToken({ provider: 'google', token })`. Supabase verifies the id_token signature/audience against its configured Google provider and issues a Supabase JWT.
4. Store the Google `refresh_token` in the auth user's `user_metadata` via the service-role admin API. The token is protected by infrastructure-level AES-256 encryption; column-level Vault encryption is deferred — see ADR-0010 and `specs/SECURITY.md`.

## Alternatives Considered
- **Supabase's built-in Google provider:** simplest, but the refresh token never leaves Supabase Auth. Rejected because Drive access requires the refresh token in our Edge Functions.
- **Implicit OAuth + manual JWT minting:** would require us to mint our own JWTs signed with the Supabase JWT secret, duplicating Supabase Auth's job and risking divergence from its session model. Rejected.
- **Storing the refresh token directly in `landlords.google_refresh_token` on first call:** we still do this on `POST /setup/complete` (the column is `not null`), but holding it in auth metadata between the OAuth callback and the form submit lets us survive page reloads without re-running OAuth.

## Consequences
- The Supabase project must have the Google provider configured with the *same* client ID/secret used by our `/auth/callback`. A mismatch will cause `signInWithIdToken` to reject the token.
- `google_refresh_token` lives in two places after onboarding completes: auth user metadata (transient, for fallback) and `landlords.google_refresh_token` (persistent, the source of truth). Subsequent Drive operations read from the `landlords` row.
- If Google revokes the refresh token (user revokes access from their Google account), Drive operations start failing with 401 — we surface a clear error and prompt the landlord to re-onboard.
