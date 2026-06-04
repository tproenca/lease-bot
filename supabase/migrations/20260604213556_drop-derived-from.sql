-- Migration: drop placeholders.derived_from column (ADR-0017).
--
-- Backfill: rows where derived_from is set but derived_formula is null are
-- migrated by copying derived_from into derived_formula as a bare-token
-- identity expression. This preserves the derivation intent without data loss.
--
-- After backfill, derived_from is dropped permanently.

begin;

-- Backfill: promote bare derived_from values to derived_formula where needed.
update placeholders
set derived_formula = derived_from
where derived_from is not null
  and derived_formula is null;

-- Drop the legacy column.
alter table placeholders drop column derived_from;

commit;
