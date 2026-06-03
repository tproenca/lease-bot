# ADR-0019: Active Tenant via `properties.current_tenant_id` FK
Date: 2026-06-03
Status: Accepted

## Context

The system needs to know which tenant is currently active for a property so that:
1. Flow 3b (generate document, menu entry) can resolve the active tenant without asking.
2. Flow 7 (add tenant) can warn the landlord when replacing an existing active tenant.
3. The system can unstar the previous tenant's Drive folder when a new tenant is created.

The current implementation uses `properties.current_tenant_folder_id` (a Drive folder
ID string) to identify the active tenant. Active-tenant detection works by finding the
tenant whose `drive_folder_id` matches `current_tenant_folder_id`. This is brittle:

1. **String-matching across two tables.** The lookup requires joining `tenants` on
   `drive_folder_id = current_tenant_folder_id`. If Drive folder IDs are ever
   regenerated, reassigned, or the tenant row is deleted without clearing the property
   field, the match silently fails or returns the wrong tenant.
2. **Drive folder as source of truth.** The Drive "star" and `current_tenant_folder_id`
   conflate two concerns: (a) which tenant is active, and (b) which folder to star in
   Drive for presentation. These should be separate.
3. **No FK integrity.** There is no database-level constraint enforcing that
   `current_tenant_folder_id` corresponds to a tenant owned by the same landlord for
   the same property. A typo or race condition creates silent data inconsistency.

## Decision

Add `properties.current_tenant_id uuid nullable references tenants` as a proper foreign
key. Write it atomically in the **same DB statement** as `current_tenant_folder_id`
when a tenant is registered or replaced:

```sql
UPDATE properties
SET current_tenant_id       = <new_tenant_id>,
    current_tenant_folder_id = <new_drive_folder_id>
WHERE id = <property_id>
  AND landlord_id = <landlord_id>;
```

Active-tenant lookup in flows uses this FK directly:
```sql
SELECT current_tenant_id FROM properties WHERE id = ?
```

The Drive "star" becomes a **presentation-only** concern: the `POST /tenants` handler
still stars the new folder and unstars the previous one (derived from the current FK
value before overwrite), but the star state in Drive is not the source of truth. If
Drive star state drifts (e.g., Drive API call fails after DB write), the DB FK is still
correct; the star can be repaired independently.

## Alternatives Considered

**`tenants.is_active` boolean flag:** Rejected. Creates a two-flags-can-disagree
problem: `tenants.is_active = true` for tenant A and `properties.current_tenant_id`
pointing to tenant B are contradictory states with no single source of truth. Requires
two writes to be kept in sync on every tenant replacement.

**Derive active tenant from Drive star state (status quo extended):** Rejected. The
Drive star is an external signal outside our transactional boundary. A failed Drive API
call leaves the DB in a state where the "active" tenant cannot be determined. More
importantly, the Drive API is not a database — it has no FK integrity, no transactions,
and no tenant-scope guarantee.

**Separate `active_tenancies` table with a `(property_id, tenant_id, started_at,
ended_at)` history:** Considered. Provides full tenancy history, which is useful for
auditing ("who was the tenant in January?"). Deferred — the current scope does not
require tenancy history, and the added complexity (extra table, end-date management,
latest-active query) is not justified. This can be added later without breaking the FK
pointer approach.

**`tenants.property_id` as the active-tenant marker (current schema):** Already exists
as a non-nullable FK (`tenants.property_id references properties`). Cannot be used to
determine the active tenant because multiple tenants can exist for the same property
(historical tenants retain their `property_id`). The FK identifies association, not
current activity.

## Consequences

- One migration required: add `current_tenant_id uuid nullable references tenants` to
  `properties`. Existing rows with a non-null `current_tenant_folder_id` can be
  backfilled by joining on `tenants.drive_folder_id = properties.current_tenant_folder_id`
  to find the matching tenant ID.
- `POST /tenants` must write both columns in the same statement. If the DB write
  succeeds but the Drive star/unstar calls fail, the DB is consistent; Drive presentation
  is eventually repaired.
- `GET /properties` and `GET /context` (historical full-snapshot) must include
  `current_tenant_id` in the response. Flows that look up the active tenant use this
  field directly — no Drive string-matching.
- `current_tenant_folder_id` is retained for Drive star management only and is not
  removed. The two columns have distinct concerns: FK (active-tenant source of truth)
  vs. folder ID (Drive presentation).
- RLS policies on `tenants` and `properties` already scope by `landlord_id`; no RLS
  change required for the new column.
