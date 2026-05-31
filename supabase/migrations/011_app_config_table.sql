-- app_config table: replaces GUC-based configuration for pg_cron credentials
--
-- Migration 010 used ALTER DATABASE SET (GUC) to store service_role_key and
-- functions_base_url. ALTER DATABASE SET requires superuser rights, which
-- Supabase's local postgres role does not have, causing migration 010 to
-- silently skip the GUC writes and leaving send_payment_reminders() unable to
-- read its configuration → daily cron_errors rows.
--
-- This migration supersedes that approach with a simple key/value table that
-- any role can read (including the SECURITY DEFINER function context), but
-- anon and authenticated roles cannot access.
--
-- Production deployments: INSERT the real values for service_role_key and
-- functions_base_url via the Supabase dashboard SQL editor or a one-time
-- manual migration before enabling the cron job.

-- ── Table ────────────────────────────────────────────────────────────────────

create table if not exists app_config (
  key   text primary key,
  value text not null
);

-- Prevent anon and authenticated roles from reading or writing runtime secrets.
-- The SECURITY DEFINER function (send_payment_reminders) runs as its owner
-- (postgres / service role) and bypasses this restriction.
revoke all on app_config from anon, authenticated;

-- ── Local dev defaults ───────────────────────────────────────────────────────
-- These are the well-known, publicly documented Supabase local-dev JWT and
-- internal Kong URL.  They are NOT production credentials.
-- ON CONFLICT DO NOTHING ensures this is safe to run repeatedly (idempotent)
-- and never overwrites values set by a previous manual INSERT.

insert into app_config (key, value) values
  ('service_role_key',   'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hj04zWl196z2-SBc0'),
  ('functions_base_url', 'http://kong:8000/functions/v1')
on conflict (key) do nothing;

-- ── Update send_payment_reminders() ─────────────────────────────────────────
-- Replace the current_setting() GUC read with a SELECT from app_config.
-- All other logic is preserved verbatim from migration 004.

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

  -- 2. Read runtime configuration from the app_config table.
  --    Falls back to a clear error row in cron_errors if either key is absent.
  select value into v_service_role_key   from app_config where key = 'service_role_key';
  select value into v_functions_base_url from app_config where key = 'functions_base_url';

  if v_service_role_key is null or v_functions_base_url is null then
    insert into cron_errors (job_name, error)
    values (
      'payment_reminder',
      'Configuration missing: service_role_key or functions_base_url not set in app_config'
    );
    return;
  end if;

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
