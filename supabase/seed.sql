-- seed.sql — local development database seed
--
-- Applied automatically by `supabase db reset` after all migrations.
-- Do NOT commit production values here. Production GUCs are set manually
-- via `ALTER DATABASE postgres SET ...` on the Supabase project.

-- ---------------------------------------------------------------------------
-- pg_cron GUC settings (local dev only)
--
-- send_payment_reminders() reads these settings via current_setting().
-- Without them the cron job fails every run with:
--   "Configuration missing: app.service_role_key or app.functions_base_url not set"
-- and writes rows to cron_errors.
--
-- app.service_role_key: the default local Supabase service-role JWT
--   (signed with the well-known local anon secret; not a production credential).
--
-- app.functions_base_url: Docker-internal URL so pg_net (which runs inside
--   the postgres container) can reach the Kong API gateway without leaving
--   the Docker network. Do not use localhost here.
-- ---------------------------------------------------------------------------

ALTER DATABASE postgres
  SET app.service_role_key = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hj04zWl196z2-SBc0';

ALTER DATABASE postgres
  SET app.functions_base_url = 'http://kong:8000/functions/v1';
