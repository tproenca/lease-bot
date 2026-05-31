-- Enable RLS on oauth_codes to satisfy the Supabase security advisor.
--
-- The oauth_codes table is exclusively accessed via the service-role client
-- (see supabase/functions/_shared/oauth-codes.ts: issueOAuthCode and
-- redeemOAuthCode both call serviceClient()). The service-role bypasses RLS
-- entirely, so enabling RLS here does not affect any Edge Function behaviour.
--
-- No policies are added for the anon or authenticated roles: those roles have
-- no legitimate reason to read or write oauth_codes directly. Any direct
-- access by tenant-scoped requests is blocked, which is the correct security
-- posture for a table that stores short-lived Supabase JWTs.
--
-- See issue #96.

alter table public.oauth_codes enable row level security;
