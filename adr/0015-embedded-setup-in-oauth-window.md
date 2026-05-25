# ADR-0015: Embedded Setup Form in ChatGPT OAuth Window
Date: 2026-05-25
Status: Accepted

## Context

When a new landlord clicks "Sign in" in ChatGPT, the GPT Actions OAuth flow opens
a window, authenticates via Google, then calls `GET /context`. Because no landlord
row exists yet, `getContext` returns `404 LANDLORD_NOT_FOUND`, and the GPT must
instruct the landlord to visit a separate `/setup` URL manually — breaking the
onboarding flow into two disconnected steps.

ChatGPT already opens an OAuth window for the auth flow. If we can embed the setup
form in that same window and issue a valid code at the end, the landlord never needs
to visit a second URL.

## Decision

Implement a "code-for-tokens" bridge that slots the setup form into the existing
OAuth window:

1. **`/oauth/authorize`**: Intercepts ChatGPT's `redirect_uri` + `state`, stores
   them in a short-lived HttpOnly cookie (`chatgpt_redirect`, 10 min), and replaces
   `redirect_uri` with our own `/auth/callback` before forwarding to Google.

2. **`/auth/callback`**: After Google auth + Supabase session creation, checks for
   the `chatgpt_redirect` cookie:
   - Landlord exists → generate one-time code → store in `oauth_codes` → redirect
     directly to ChatGPT callback (`<redirect_uri>?code=<code>&state=<state>`).
   - No landlord row → set session + refresh cookies → redirect to `/setup?via=oauth`.

3. **`/setup?via=oauth`**: Detects the `via=oauth` flag and updates the JS form
   handler to call `window.location = json.redirect_to` on success.

4. **`/setup/complete`**: When both `chatgpt_redirect` and `sb_session_refresh`
   cookies are present, generates a one-time code and returns `redirect_to` in the
   JSON response. The Supabase `refresh_token` is stored in a separate HttpOnly
   cookie (`sb_session_refresh`) by `/auth/callback` specifically for this purpose.

5. **`/oauth/token`**: Before forwarding to Google, checks the `oauth_codes` table
   for the submitted code. If found: return stored tokens + delete row (single-use).
   If not found: fall through to the existing Google exchange path.

6. **`oauth_codes` table**: `(code TEXT PRIMARY KEY, access_token TEXT NOT NULL,
   refresh_token TEXT NOT NULL, expires_at TIMESTAMPTZ DEFAULT now() + 5 minutes)`.
   Codes are `crypto.randomUUID()` — 122 bits of entropy, not guessable. Filtered
   by `expires_at` on lookup; deleted immediately on redemption.

## Alternatives Considered

**A. Server-side redirect after /setup/complete**: Redirect directly from the Edge
Function to ChatGPT. Rejected: the browser can't follow an HTTP redirect triggered
by a `fetch()` call from the form JS — `window.location = redirect_to` is required.

**B. Store tokens in a URL fragment**: Encode Supabase tokens in the ChatGPT
redirect URL directly, skipping the oauth_codes table. Rejected: tokens in URLs
appear in server logs and browser history; the one-time code approach keeps tokens
out of URLs entirely.

**C. Store ChatGPT redirect info in the DB instead of a cookie**: Write
`(user_id, redirect_uri, state)` to a pending_oauth table. Rejected: the user_id
is not known at `/oauth/authorize` time (before Google auth). A cookie is the
correct transport for ephemeral pre-auth state.

**D. Single combined session cookie (access + refresh)**: Encode both tokens as a
JSON blob in one cookie. Rejected: increases cookie size and complicates parsing
for the existing access-token-only consumers (`/setup`, `/setup/complete`). Two
separate cookies keeps concerns isolated.

## Consequences

- New landlords complete setup in one uninterrupted flow within the ChatGPT window.
- Existing landlords are not affected: the form is skipped entirely.
- `/setup` page remains fully functional for direct browser access (no ChatGPT
  cookie → original behavior unchanged).
- One new DB table (`oauth_codes`) with a 5-minute row TTL.
- Two new short-lived HttpOnly cookies (`chatgpt_redirect`, `sb_session_refresh`).
- The `oauth_codes` table has no RLS; access is restricted to service-role Edge
  Functions only. An expired-code filter prevents stale codes from being returned.
