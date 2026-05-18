-- Signature requests and cron error tracking

create table signature_requests (
  id                     uuid primary key default uuid_generate_v4(),
  landlord_id            uuid not null references landlords on delete cascade,
  tenant_id              uuid not null references tenants on delete cascade,
  autentique_document_id text not null unique,
  status                 text not null default 'pending'
                           check (status in ('pending', 'completed')),
  created_at             timestamptz not null default now(),
  completed_at           timestamptz
);

alter table signature_requests enable row level security;

create policy "signature_requests: own rows only"
  on signature_requests
  for all
  using (landlord_id = auth.uid());

create table cron_errors (
  id          uuid primary key default uuid_generate_v4(),
  job_name    text not null,
  error       text not null,
  occurred_at timestamptz not null default now()
);

-- cron_errors is written by the service role (pg_cron), read by the landlord
alter table cron_errors enable row level security;

create policy "cron_errors: service role write"
  on cron_errors
  for insert
  to service_role
  with check (true);

create policy "cron_errors: landlords read all"
  on cron_errors
  for select
  using (auth.role() = 'authenticated');
