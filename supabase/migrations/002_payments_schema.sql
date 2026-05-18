-- Payments and payment reminders

create table payments (
  id              uuid primary key default uuid_generate_v4(),
  landlord_id     uuid not null references landlords on delete cascade,
  tenant_id       uuid not null references tenants on delete cascade,
  amount          numeric not null check (amount > 0),
  reference_month date not null,
  paid_at         timestamptz not null,
  on_time         boolean not null,
  created_at      timestamptz not null default now()
);

alter table payments enable row level security;

create policy "payments: own rows only"
  on payments
  for all
  using (landlord_id = auth.uid());

create table payment_reminders (
  id              uuid primary key default uuid_generate_v4(),
  landlord_id     uuid not null references landlords on delete cascade,
  tenant_id       uuid not null references tenants on delete cascade,
  reference_month date not null,
  sent_at         timestamptz
);

alter table payment_reminders enable row level security;

create policy "payment_reminders: own rows only"
  on payment_reminders
  for all
  using (landlord_id = auth.uid());
