-- Migration: add properties.current_tenant_id FK and backfill from drive_folder_id match
--
-- Adds a nullable FK column `current_tenant_id` to `properties` that points to the
-- currently active tenant. This is the authoritative source of truth for the
-- active-tenant relationship (ADR-0019). The Drive "star" and
-- `current_tenant_folder_id` become presentation-only concerns.
--
-- Backfill: for each property row with a non-null current_tenant_folder_id,
-- locate the tenant (for the same landlord + property) whose drive_folder_id
-- matches and set current_tenant_id accordingly.
-- Properties without a matching tenant row remain NULL (vacant).

-- ── 1. Add the column ──────────────────────────────────────────────────────

alter table properties
  add column current_tenant_id uuid references tenants on delete set null;

-- ── 2. Backfill from drive_folder_id match ─────────────────────────────────
-- Join condition: same landlord_id + same property_id + folder ID match.
-- The landlord_id and property_id guards prevent cross-contamination in the
-- unlikely event of a folder ID collision across landlords.

update properties p
set current_tenant_id = t.id
from tenants t
where p.current_tenant_folder_id is not null
  and t.drive_folder_id = p.current_tenant_folder_id
  and t.landlord_id = p.landlord_id
  and t.property_id = p.id;
