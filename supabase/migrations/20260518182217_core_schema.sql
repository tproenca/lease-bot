-- Core schema: landlords, buildings, properties, tenants, templates,
-- placeholders, property_type_templates, witnesses

-- ── landlords ──────────────────────────────────────────────────────────────

create table landlords (
  id                         uuid primary key default gen_random_uuid(),
  email                      text unique not null,
  name                       text not null,
  whatsapp                   text not null,
  google_refresh_token       text not null,
  autentique_api_key         text not null,
  root_folder_id             text not null,
  templates_folder_id        text not null,
  payment_reminder_frequency text not null default 'weekly'
                               check (payment_reminder_frequency in ('daily', 'weekly', 'disabled')),
  created_at                 timestamptz not null default now()
);

alter table landlords enable row level security;

create policy "landlords: own row only"
  on landlords
  for all
  using (id = auth.uid());

-- ── buildings ──────────────────────────────────────────────────────────────

create table buildings (
  id              uuid primary key default gen_random_uuid(),
  landlord_id     uuid not null references landlords on delete cascade,
  name            text not null,
  address         text not null,
  drive_folder_id text not null,
  created_at      timestamptz not null default now()
);

alter table buildings enable row level security;

create policy "buildings: own rows only"
  on buildings
  for all
  using (landlord_id = auth.uid());

-- ── properties ─────────────────────────────────────────────────────────────

create table properties (
  id                       uuid primary key default gen_random_uuid(),
  landlord_id              uuid not null references landlords on delete cascade,
  type                     text not null check (type in ('apartment', 'house', 'commercial')),
  building_id              uuid references buildings on delete set null,
  name                     text not null,
  address                  text not null,
  drive_folder_id          text not null,
  current_tenant_folder_id text,
  created_at               timestamptz not null default now()
);

alter table properties enable row level security;

create policy "properties: own rows only"
  on properties
  for all
  using (landlord_id = auth.uid());

-- ── tenants ────────────────────────────────────────────────────────────────

create table tenants (
  id              uuid primary key default gen_random_uuid(),
  landlord_id     uuid not null references landlords on delete cascade,
  property_id     uuid not null references properties on delete cascade,
  name            text not null,
  cpf             text not null,
  whatsapp        text,
  drive_folder_id text not null,
  created_at      timestamptz not null default now()
);

alter table tenants enable row level security;

create policy "tenants: own rows only"
  on tenants
  for all
  using (landlord_id = auth.uid());

-- ── templates ──────────────────────────────────────────────────────────────

create table templates (
  id                     uuid primary key default gen_random_uuid(),
  landlord_id            uuid not null references landlords on delete cascade,
  drive_file_id          text not null,
  name                   text not null,
  drive_last_modified_at timestamptz not null,
  placeholder_names      text[] not null default '{}',
  created_at             timestamptz not null default now()
);

alter table templates enable row level security;

create policy "templates: own rows only"
  on templates
  for all
  using (landlord_id = auth.uid());

-- ── placeholders ───────────────────────────────────────────────────────────

create table placeholders (
  id              uuid primary key default gen_random_uuid(),
  landlord_id     uuid not null references landlords on delete cascade,
  name            text not null,
  required        boolean not null default true,
  format          text not null check (format in ('text', 'date', 'cpf', 'integer', 'currency')),
  "case"          text check ("case" in ('maiúsculas', 'minúsculas', 'título', 'frase')),
  "default"       text,
  derived_from    text,
  derived_formula text,
  unique (landlord_id, name)
);

alter table placeholders enable row level security;

create policy "placeholders: own rows only"
  on placeholders
  for all
  using (landlord_id = auth.uid());

-- ── property_type_templates ────────────────────────────────────────────────

create table property_type_templates (
  landlord_id   uuid not null references landlords on delete cascade,
  property_type text not null check (property_type in ('apartment', 'house', 'commercial')),
  template_id   uuid not null references templates on delete cascade,
  primary key (landlord_id, property_type, template_id)
);

alter table property_type_templates enable row level security;

create policy "property_type_templates: own rows only"
  on property_type_templates
  for all
  using (landlord_id = auth.uid());

-- ── witnesses ──────────────────────────────────────────────────────────────

create table witnesses (
  id          uuid primary key default gen_random_uuid(),
  landlord_id uuid not null references landlords on delete cascade,
  name        text not null,
  whatsapp    text not null,
  unique (landlord_id, name)
);

alter table witnesses enable row level security;

create policy "witnesses: own rows only"
  on witnesses
  for all
  using (landlord_id = auth.uid());
