# ADR-0014: OAuth Proxy Endpoints for GPT Action Root Domain Requirement
Date: 2026-05-20
Status: Accepted

## Context

OpenAI enforces that a Custom GPT action's Authorization URL, Token URL, and
API server hostname must all share the same root domain. This project uses
Google OAuth, where the natural URLs are:

- Authorization URL: `https://accounts.google.com/o/oauth2/v2/auth`
- Token URL: `https://oauth2.googleapis.com/token`
- API server: `https://<project>.supabase.co/functions/v1`

All three are on different domains, so OpenAI rejects the configuration with:
"Authorization URL, Token URL, and API hostname must share a root domain."

## Decision

Add two thin proxy Edge Functions on the API's domain:

- `GET /oauth/authorize` — receives the GPT's redirect, forwards all query
  params to `https://accounts.google.com/o/oauth2/v2/auth`, and returns a 302.
- `POST /oauth/token` — receives the GPT's token exchange request, forwards the
  body verbatim to `https://oauth2.googleapis.com/token`, and returns Google's
  response verbatim (status, body, content-type).

Both proxy endpoints are hardcoded to their exact Google destinations — no
configurable target, no open redirect.

## Alternatives Considered

1. **Register a custom domain that covers all three URLs** — not feasible;
   Google's OAuth endpoints cannot be remapped.

2. **Host the API on a Google Cloud domain** — would require migrating from
   Supabase, which is the single-platform decision documented in ADR-0001.

3. **Use a different OAuth provider** — out of scope; Google OAuth is required
   for Google Drive access (ADR-0003 and ADR-0009).

## Consequences

- The proxy adds one extra network hop for the OAuth flow (authorize redirect
  and token exchange). This is a one-time cost during login; it has no impact
  on per-request API latency.
- The proxy does not store, log, or inspect credentials; it merely
  passes bytes through. No new secrets are introduced.
- `GET /oauth/authorize` and `POST /oauth/token` must be listed with
  `security: []` in `specs/openapi.yaml` because they are part of the auth
  flow, not protected API endpoints.
