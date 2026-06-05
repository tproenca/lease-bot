-- Migration: update send_payment_reminders() to use properties.current_tenant_id FK
--
-- Replaces the active-tenant detection logic in the pg_cron function.
-- Previously, active tenants were identified by matching
--   properties.current_tenant_folder_id = tenants.drive_folder_id
-- This is brittle (string-matching across two tables; see ADR-0019).
--
-- After this migration, active tenants are identified via the FK:
--   properties.current_tenant_id = tenants.id
-- The query becomes a simple FK lookup, which is faster and safe under RLS.
--
-- All other logic is preserved verbatim.

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
    --    reference month. Active tenant is now determined via the FK
    --    properties.current_tenant_id (ADR-0019), not Drive folder matching.
    for v_tenant in
      select t.id as tenant_id,
             t.whatsapp
      from   tenants t
      join   properties p on p.current_tenant_id = t.id
      where  t.landlord_id = v_landlord.id
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
