-- One-time OAuth codes for the integrated setup flow.
--
-- When a new landlord completes the /setup form from within the ChatGPT OAuth
-- window, we cannot redirect directly to Google → ChatGPT because the session
-- is ours, not Google's. Instead /setup/complete generates a short-lived,
-- single-use code that encapsulates the Supabase access_token + refresh_token.
-- ChatGPT calls /oauth/token?grant_type=authorization_code&code=<code> and
-- receives the Supabase JWT pair in exchange.
--
-- Security:
--   - Codes are crypto.randomUUID() — 122 bits of entropy, not guessable.
--   - Codes expire after 5 minutes (expires_at column).
--   - Codes are deleted on first successful exchange (single-use).
--   - The tokens stored here are Supabase JWTs, not Google tokens.
--
-- See issue #89 and ADR-0015.

create table oauth_codes (
  code        text        primary key,
  access_token  text      not null,
  refresh_token text      not null,
  expires_at  timestamptz not null default now() + interval '5 minutes'
);

-- No RLS needed: this table is only ever touched by service-role Edge
-- Functions (/setup/complete inserts, /oauth/token reads + deletes).
-- Enabling RLS with no policies would block all access; disable it explicitly.
alter table oauth_codes disable row level security;

-- Index for the expiry cleanup query (not needed for the primary-key lookup,
-- but useful if we ever add a pg_cron cleanup job).
create index oauth_codes_expires_at_idx on oauth_codes (expires_at);
