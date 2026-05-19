# Testing Flows — Lease Assistant

Which application flows are tested, at which tier, and what's not covered yet.
See [TESTING.md](TESTING.md) for how to run each tier.

## Covered flows

| Flow | Tier | Type | Notes |
|---|---|---|---|
| Core landlord happy path (building → property → tenant → generate docs → payment) | 2 | E2E smoke | Google/Drive mocked; real Supabase |
| Buildings CRUD | 1 | Integration | Auth, validation, Drive failures, folder reuse |
| Properties CRUD | 1 | Integration | House / commercial / apartment; building scoping |
| Tenants CRUD (create, get, patch) | 1 | Integration | Folder creation, Drive star/unstar, replacement, rollback |
| Context load | 1 | Integration | Full landlord context, account config, template mapping |
| Document generation | 1 | Integration + unit | Placeholder substitution, case transforms, RLS block |
| Document export / PDF merge | 1 | Integration + unit | Multi-doc merge, stop-on-first-failure, token auth |
| Template diff (fast + slow path) | 1 | Integration + unit | Placeholder detection, witness detection |
| Templates CRUD | 1 | Integration | Create, delete |
| Payments (record + query) | 1 | Integration | on_time boundary logic, paid/overdue split |
| Placeholders CRUD | 1 | Integration | Create, delete (idempotent, URL-encoded) |
| Witnesses CRUD | 1 | Integration | Create, uniqueness |
| Setup / onboarding complete | 1 | Integration | Folder ID, WhatsApp, Autentique key validation |
| Account config (reminder frequency) | 1 | Unit | All valid values + invalid inputs |
| Substitution engine | 1 | Unit | applyCase, substituteTokens |
| PDF merge logic | 1 | Unit | Page count, header check |
| Input validation utilities | 1 | Unit | WhatsApp, Drive ID, folder name, API key, cookies, OAuth URL |

## Tier 3 only — nightly, not pre-merge

Tested but not required before merge (`scripts/nightly.sh`):

- Tenant replacement full flow: old folder unstarred, new folder starred
- Cross-landlord access control: JWT from landlord A rejected for landlord B's resources
- Template add/remove round-trip: diff detects new/removed → DB updated

## No automated test yet

Flows with no test in any tier:

- Signing flow: send for signing → Autentique webhook → signed PDF saved to Drive
- WhatsApp payment reminders: pg_cron trigger → Meta WhatsApp API called → `payment_reminders` record created
- Webhook idempotency: duplicate Autentique webhook processed only once
