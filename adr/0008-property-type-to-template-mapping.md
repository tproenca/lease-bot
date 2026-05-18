# ADR-0008: Property-Type-to-Template Mapping
Date: 2026-05-18
Status: Accepted

## Context
Landlords manage three property types: apartments, houses, and commercial units. Different property types require different contract templates (e.g. a residential lease for houses/apartments, a commercial lease for commercial units). The question was whether to use all templates for every lease or to map templates to property types.

## Decision
Each template is associated with one or more property types via a `property_type_templates` junction table. When generating a lease, only the templates mapped to the property's type are used. The mapping is configured conversationally through the GPT when a template is first added or detected.

## Alternatives Considered
- **Always use all templates:** Simpler, no mapping needed. Rejected because it would apply residential templates to commercial leases and vice versa, producing incorrect documents.
- **Landlord selects templates per lease at generation time:** More flexible but adds friction to every lease generation. Rejected in favour of a one-time setup that is then automatic.
- **Separate template folders per property type:** Simpler discovery but requires the landlord to manage multiple folders. Rejected because a single Templates folder is easier to maintain.

## Consequences
- Lease generation is automatic — the GPT selects the correct templates based on property type without asking the landlord each time.
- The mapping is set up once per template (conversationally) and reused for all future leases.
- When a template is added or modified, the GPT asks for its property type mapping as part of the same configuration flow.
- When a template is removed, its `property_type_templates` entries are cascade-deleted.
