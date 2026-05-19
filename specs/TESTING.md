# Testing — Lease Assistant

## Testing Strategy

### Tier 1 — Unit + Integration
**When:** run before every merge via `scripts/ci.sh`. Must pass before merge.

**Scope:**
- Unit tests for the substitution engine (placeholder replacement, case transformations, derived field handling)
- Unit tests for signature position detection (PDF scanning logic, signer label classification)
- Unit tests for `GET /templates/diff` (fast path / slow path logic, diff computation)
- Unit tests for HMAC webhook signature verification
- Integration tests for every Edge Function endpoint against a local Supabase instance (real DB, real auth — no mocks)

**Framework:** Deno built-in test runner (`deno test`)

**How to run locally:**
```sh
scripts/ci.sh --tier 1
# or directly:
deno test --allow-all supabase/functions/ --filter "unit|integration"
```

---

### Tier 2 — E2E Smoke Tests
**When:** run before every merge via `scripts/ci.sh`. Must pass before merge.

**Critical paths covered:**
1. Onboarding → setup complete → context loaded correctly
2. Create building → create apartment → verify Drive folder created
3. Create tenant → verify Drive folder created, starred, `current_tenant_folder_id` updated
4. Generate documents → verify placeholders substituted → verify files saved to Drive
5. Record payment → query overdue tenants → verify correct tenant appears

**Framework:** Deno test calling live Edge Functions against local Supabase (`supabase start`)

**How to run locally:**
```sh
scripts/ci.sh --tier 2
# or directly:
deno test --allow-all supabase/functions/ --filter "e2e:smoke"
```

---

### Tier 3 — Full E2E Suite
**When:** nightly on main via `scripts/nightly.sh`. Not required before merge.

**Additional paths covered beyond Tier 2:**
- Template diff: add new template → detect new placeholders → configure → verify DB updated
- Template diff: remove template → verify mapping cleaned up
- Tenant replacement → verify old folder unstarred, new folder starred
- Signing flow: generate documents → send for signing → mock Autentique webhook → verify signed PDF saved to Drive (planned)
- Payment reminder: mock pg_cron trigger → verify Meta WhatsApp API called → verify `payment_reminders` record created (planned)
- Webhook idempotency: duplicate Autentique webhook → verify processed only once (planned)
- Access control: JWT from landlord A rejected for landlord B's resources

**Coverage threshold:** 80% line coverage across all Edge Function logic

**How to run locally:**
```sh
scripts/nightly.sh
# or directly:
deno test --allow-all supabase/functions/ --coverage=coverage/
deno coverage coverage/ --lcov > coverage/lcov.info
```

---

## Coverage Expectations by Area

| Area | Expected coverage |
|------|-----------------|
| Substitution engine | 95% |
| Signature position detection | 90% |
| Template diff logic | 90% |
| Edge Function handlers | 80% |
| Webhook handlers | 85% |
| Overall minimum | 80% |

---

## What Not to Test

- Google Drive API behaviour — trust Google's SDK; mock Drive calls in unit tests
- Autentique API behaviour — mock in Tier 3; not a test target
- Meta WhatsApp API behaviour — mock in Tier 3; not a test target
- Supabase Auth internals — trust Supabase; test only that our JWT validation middleware rejects invalid tokens
- PDF rendering fidelity — test that substitution happened and pages merged; not visual output
- pg_cron scheduling precision — test the job logic, not the scheduler itself

---

## How to Run Each Tier Locally

```sh
# Start local Supabase (required for Tier 1 integration and Tier 2/3)
supabase start

# Tier 1 + Tier 2 (pre-merge)
scripts/ci.sh

# Tier 3 (nightly — full suite + coverage)
scripts/nightly.sh
```

`scripts/ci.sh` exits with code 0 if all Tier 1 and Tier 2 tests pass, code 1 otherwise.
`scripts/nightly.sh` exits with code 0 if all tests pass and coverage ≥ 80%, code 1 otherwise.
On failure, `scripts/nightly.sh` appends a bug entry to `issues.md`.

---

## Coverage Status

Which flows are covered at which tier, and what has no automated test yet.

### Covered

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
| Ad-hoc payment reminder | 1 | Integration | WhatsApp send, `payment_reminders` record, non-500 on failure |
| Account config (reminder frequency) | 1 | Integration | All valid values + invalid inputs |
| Placeholders CRUD | 1 | Integration | Create, delete (idempotent, URL-encoded) |
| Witnesses CRUD | 1 | Integration | Create, uniqueness |
| Setup / onboarding complete | 1 | Integration | Folder ID, WhatsApp, Autentique key validation |
| Substitution engine | 1 | Unit | applyCase, substituteTokens |
| PDF merge logic | 1 | Unit | Page count, header check |
| Input validation utilities | 1 | Unit | WhatsApp, Drive ID, folder name, API key, cookies, OAuth URL |

### Tier 3 only — nightly, not pre-merge

| Flow | Notes |
|---|---|
| Tenant replacement full flow | Old folder unstarred, new folder starred |
| Cross-landlord access control | JWT from landlord A rejected for landlord B's resources |
| Template add/remove round-trip | Diff detects new/removed → DB updated |

### No automated test yet

| Flow | Reason |
|---|---|
| Signing flow end-to-end | Autentique webhook requires a live external call |
| pg_cron reminder execution | Requires live Supabase deployment with pg_cron enabled |
| Webhook idempotency | Duplicate Autentique webhook processed only once |

For manual coverage of these flows, see [docs/MANUAL-TEST.md](../docs/MANUAL-TEST.md).
