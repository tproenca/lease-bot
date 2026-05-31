-- pg_cron GUC settings for local development
--
-- send_payment_reminders() reads app.service_role_key and
-- app.functions_base_url via current_setting(). Without them the job
-- fails every run and writes rows to cron_errors.
--
-- This migration sets safe defaults only when the settings are NOT already
-- configured — so production values set manually via the Supabase dashboard
-- or a one-time ALTER DATABASE are never overwritten.
--
-- Local dev:  both settings are absent after a fresh reset → defaults applied.
-- Production: both settings are present (set manually) → skipped entirely.

DO $$
BEGIN
  IF current_setting('app.service_role_key', true) IS NULL
     OR current_setting('app.service_role_key', true) = '' THEN
    -- Well-known local Supabase default service-role JWT (not a production
    -- credential — signed with the shared local anon secret).
    EXECUTE 'ALTER DATABASE postgres SET app.service_role_key = ''eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hj04zWl196z2-SBc0''';
    EXECUTE 'ALTER DATABASE postgres SET app.functions_base_url = ''http://kong:8000/functions/v1''';
  END IF;
END;
$$;
