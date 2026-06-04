-- pg_cron: scheduled payment reminders
--
-- Registers a daily cron job (09:00 BRT = 12:00 UTC) that sends automatic
-- WhatsApp payment reminders to overdue tenants based on each landlord's
-- configured frequency (daily | weekly | disabled).
--
-- The job function:
--   1. Determines the current reference month (first day of the current month).
--   2. For each landlord whose payment_reminder_frequency is not 'disabled':
--      a. Identifies active tenants (those still assigned to a property via
--         current_tenant_folder_id) with no payment recorded for the reference month.
--      b. Skips any tenant already reminded within the frequency window:
--            daily  → reminder sent within the last 24 hours
--            weekly → reminder sent within the last 7 days
--      c. Calls POST /payments/remind via pg_net (service-role JWT) to send the
--         WhatsApp message and record the reminder in payment_reminders.
--   3. Catches every exception per-tenant and logs it to cron_errors with
--      job_name = 'payment_reminder'.
--
-- Extensions used:
--   pg_cron  — job scheduling (enabled via Supabase project settings)
--   pg_net   — async HTTP from within PostgreSQL

-- ── Extensions ─────────────────────────────────────────────────────────────

-- pg_cron must live in the pg_catalog search-path schema; Supabase provisions
-- it automatically but the IF NOT EXISTS guard makes migrations re-runnable.
create extension if not exists pg_cron;

-- pg_net is installed in the net schema by default on Supabase.
create extension if not exists pg_net;

-- ── Helper function ─────────────────────────────────────────────────────────

-- send_payment_reminders()
--
-- Called once per day at 12:00 UTC by the pg_cron schedule below.
-- Runs as the pg_cron background worker (effectively the postgres superuser /
-- service role), which means RLS is bypassed for the direct DB work, but
-- the HTTP call to the Edge Function still goes through the normal application
-- auth path using the service-role JWT.

create or replace function send_payment_reminders()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_landlord            record;
  v_tenant              record;
  v_reference_month     date;
  v_window_start        timestamptz;
  v_already_reminded    boolean;
  v_service_role_key    text;
  v_functions_base_url  text;
begin
  -- 1. Reference month = first day of the current calendar month (UTC).
  v_reference_month := date_trunc('month', now() at time zone 'UTC')::date;

  -- 2. Read runtime configuration injected as Postgres settings.
  --    These must be set before deploying:
  --      ALTER DATABASE postgres SET app.service_role_key = '...';
  --      ALTER DATABASE postgres SET app.functions_base_url = 'https://<ref>.supabase.co/functions/v1';
  begin
    v_service_role_key   := current_setting('app.service_role_key');
    v_functions_base_url := current_setting('app.functions_base_url');
  exception when undefined_object then
    insert into cron_errors (job_name, error)
    values (
      'payment_reminder',
      'Configuration missing: app.service_role_key or app.functions_base_url not set'
    );
    return;
  end;

  -- 3. Iterate over every landlord that has reminders enabled.
  for v_landlord in
    select id, payment_reminder_frequency
    from   landlords
    where  payment_reminder_frequency in ('daily', 'weekly')
  loop
    -- 4. Compute the look-back window for this landlord's frequency.
    if v_landlord.payment_reminder_frequency = 'daily' then
      v_window_start := now() - interval '24 hours';
    else -- weekly
      v_window_start := now() - interval '7 days';
    end if;

    -- 5. Find active tenants of this landlord that have no payment for the
    --    reference month.
    for v_tenant in
      select t.id as tenant_id,
             t.whatsapp
      from   tenants t
      join   properties p on p.id = t.property_id
      where  t.landlord_id = v_landlord.id
        --   Active tenant: their Drive folder is the current one on the property.
        and  p.current_tenant_folder_id = t.drive_folder_id
        --   No payment recorded for this reference month.
        and  not exists (
               select 1
               from   payments pay
               where  pay.tenant_id       = t.id
                 and  pay.reference_month = v_reference_month
             )
    loop
      begin
        -- 6. Skip if a reminder was already sent within the frequency window
        --    (idempotency guard — prevents double-sending).
        select exists (
          select 1
          from   payment_reminders pr
          where  pr.tenant_id       = v_tenant.tenant_id
            and  pr.reference_month = v_reference_month
            and  pr.sent_at        >= v_window_start
        ) into v_already_reminded;

        if v_already_reminded then
          continue;
        end if;

        -- 7. Skip tenants without a WhatsApp number — nothing to send.
        if v_tenant.whatsapp is null then
          continue;
        end if;

        -- 8. Call POST /payments/remind via pg_net.
        --    The Edge Function handles the actual WhatsApp dispatch and inserts
        --    the payment_reminders row.  net.http_post is non-blocking (async);
        --    we proceed to the next tenant immediately.  Any call-site failure
        --    (e.g. function not yet deployed) is caught by the exception block
        --    below and logged to cron_errors.
        perform net.http_post(
          url     := v_functions_base_url || '/payments/remind',
          headers := jsonb_build_object(
            'Content-Type',  'application/json',
            'Authorization', 'Bearer ' || v_service_role_key
          ),
          body    := jsonb_build_object(
            'tenant_id',       v_tenant.tenant_id,
            'reference_month', v_reference_month::text
          )
        );

      exception when others then
        -- 9. Log per-tenant failures; continue to the next tenant so that one
        --    failure does not abort all remaining reminders for the day.
        insert into cron_errors (job_name, error)
        values (
          'payment_reminder',
          format(
            'tenant_id=%s reference_month=%s landlord_id=%s error=%s',
            v_tenant.tenant_id,
            v_reference_month,
            v_landlord.id,
            sqlerrm
          )
        );
      end;
    end loop; -- tenants
  end loop; -- landlords
end;
$$;

-- ── Cron schedule ───────────────────────────────────────────────────────────

-- cron.schedule() is idempotent when called with the same job name:
-- it creates the job on first run and updates the schedule on subsequent runs.
-- Schedule: every day at 12:00 UTC (= 09:00 BRT, UTC-3).
select cron.schedule(
  'payment_reminder_daily',       -- job name (unique key)
  '0 12 * * *',                   -- daily at 12:00 UTC
  'select send_payment_reminders()'
);
