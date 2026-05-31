-- Enable Row Level Security on app_config.
--
-- Migration 011 created app_config with REVOKE ALL ON app_config FROM anon,
-- authenticated, which blocks direct access by tenant-facing roles.  However,
-- the Supabase security advisor still flags the table because RLS itself was
-- not enabled — REVOKE alone does not satisfy the advisor check.
--
-- Enabling RLS here closes that gap.  No policies are added: the intent is
-- deny-all for direct access, which is the default when RLS is on and no
-- permissive policy exists.
--
-- SECURITY DEFINER functions (send_payment_reminders) run as their owner
-- (postgres / service role) and bypass RLS, so they are unaffected.

ALTER TABLE public.app_config ENABLE ROW LEVEL SECURITY;
