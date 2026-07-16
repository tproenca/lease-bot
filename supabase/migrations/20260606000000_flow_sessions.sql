-- Identity-keyed server-side workflow sessions.
--
-- Replaces the opaque base64 `state` token that the GPT echoed each turn. Flow
-- state now lives server-side in this table, keyed by the landlord's identity
-- (landlord_id = auth.uid()). The GPT carries nothing of ours — not a token,
-- not even a session id. The backend resolves the single active session from
-- the verified JWT. See ADR-0021 and issue #245.
--
-- The in-code FlowDefinition engine (steps/validate/load/dynamic steps) is
-- unchanged: only `values` moved from the token into a `resolved_values` row.
--
-- Column naming note: the conceptual "values" field is stored as
-- `resolved_values` because `values` is a reserved SQL keyword (VALUES clause)
-- and would require quoting at every call site. This mirrors the working
-- foo2 prototype.

create table flow_sessions (
  id              uuid primary key default gen_random_uuid(),
  landlord_id     uuid not null references landlords on delete cascade,
  intent          text not null,
  -- Name of the slot currently being collected (null at confirm/terminal).
  step            text,
  -- Collected flow values (the engine's working set for this turn).
  resolved_values jsonb not null default '{}',
  -- Pre-step snapshots for `back`: [{ step, resolved_values }]. Restoring a
  -- snapshot (not just a cursor) is what makes `back` correctly un-resolve
  -- derived placeholders — popping past rent drops amount_in_words(rent).
  history         jsonb not null default '[]',
  -- Bumped on every write; used for consecutive-request idempotency.
  version         integer not null default 0,
  status          text not null default 'active'
                    check (status in ('active', 'confirm', 'complete', 'cancelled', 'expired')),
  expires_at      timestamptz not null default (now() + interval '12 hours'),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- RLS: a landlord sees only their own sessions. Consistent with every other
-- table (landlord_id = auth.uid()); the handler uses the user-scoped client.
-- The cron sweep below is SECURITY DEFINER and bypasses RLS.
alter table flow_sessions enable row level security;

create policy "flow_sessions: own rows only"
  on flow_sessions
  for all
  using (landlord_id = auth.uid());

-- Enforce one active session per landlord at the DB level. Concurrent starts
-- collide deterministically on this index (last-write-wins is resolved by the
-- handler before insert); see ADR-0021 on the parallel-conversation trade-off.
create unique index flow_sessions_one_active_per_landlord
  on flow_sessions (landlord_id)
  where status = 'active';

-- Supports the expiry sweep below.
create index flow_sessions_expires_at_idx on flow_sessions (expires_at);

-- ── Expiry sweep (pg_cron) ──────────────────────────────────────────────────
--
-- Housekeeping only. The handler already treats an active-but-expired row as
-- "no active session" (re-greet) on read, so correctness does not depend on the
-- sweep; this just stops abandoned rows from accumulating. Same shape as the
-- payment-reminder job (20260519075107). SECURITY DEFINER so the cron worker
-- (not a landlord) can delete across all rows, bypassing RLS.

create extension if not exists pg_cron;

create or replace function sweep_expired_flow_sessions()
returns void
language sql
security definer
set search_path = public
as $$
  delete from flow_sessions
  where expires_at < now();
$$;

-- cron.schedule() is idempotent when called with the same job name.
-- Schedule: every 15 minutes.
select cron.schedule(
  'flow_sessions_expiry_sweep',
  '*/15 * * * *',
  'select sweep_expired_flow_sessions()'
);
