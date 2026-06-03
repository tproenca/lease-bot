# Testing — Lease Assistant

## Testing Strategy

### Tier 1 — Unit + Integration
**When:** run before every merge via CI (`scripts/check.sh`, `scripts/test-unit.sh`, `scripts/test-integration.sh`, `scripts/test-smoke.sh`). Must pass before merge.

**Scope:**
- Unit tests for the substitution engine (placeholder replacement, case transformations)
- Unit tests for the **derivation engine**: each registry formula (`identity`, `cpf_format`, `amount_in_words`, `full_date_text`, `end_date`), topological resolution order, sibling dependency chaining, error cases (unknown function, circular dependency, unresolvable input)
- Unit tests for **flow engine features**: dynamic-step resolution, async `load` hook, reply-to-edit field clearing (including transitive derived dependents), cross-flow chaining hand-off
- Unit tests for **`generate_document` flow**: Flow 3a (chained from add_tenant, implicit `initial` use_case), Flow 3b (menu entry, explicit use_case), confirm table assembly, assembled placeholders map sent to endpoint
- Unit tests for signature position detection (PDF scanning logic, signer label classification)
- Unit tests for `GET /templates/diff` (fast path / slow path logic, diff computation)
- Unit tests for HMAC webhook signature verification
- Integration tests for every Edge Function endpoint against a local Supabase instance (real DB, real auth — no mocks)
- Integration test: **scoped required-check** — `POST /documents/generate` only rejects missing placeholders that appear in the selected templates (not global); asserts placeholders absent from selected templates are not required
- Integration test: **`default` column honored** — placeholder with `default` value and empty input in `placeholders` map uses the default, not `""`
- Contract test: **`ERROR_MAP` completeness** — asserts every error code that any endpoint can emit exists as a key in `ERROR_MAP`; fails CI if a new code is added without updating the map

**Framework:** Deno built-in test runner (`deno test`)

**How to run locally:**
```sh
scripts/check.sh
scripts/test-unit.sh

# requires: supabase start
scripts/test-integration.sh
```

---

### Tier 2 — E2E Smoke Tests
**When:** run before every merge via CI (`scripts/check.sh`, `scripts/test-unit.sh`, `scripts/test-integration.sh`, `scripts/test-smoke.sh`). Must pass before merge.

**Critical paths covered:**
1. Onboarding → setup complete → context loaded correctly
2. Create building → create apartment → verify Drive folder created
3. Create tenant → verify Drive folder created, starred, `current_tenant_folder_id` updated
4. Generate documents → verify placeholders substituted → verify files saved to Drive
5. Record payment → query overdue tenants → verify correct tenant appears

**Framework:** Deno test calling live Edge Functions against local Supabase (`supabase start`)

**How to run locally:**
```sh
# requires: supabase start
scripts/test-smoke.sh
```

---

### Tier 3 — Full E2E Suite
**When:** nightly on main via CI (`scripts/test-nightly.sh`). Not required before merge.

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
# requires: supabase start
scripts/test-nightly.sh
```

---

## Coverage Expectations by Area

| Area | Expected coverage |
|------|-----------------|
| Substitution engine | 95% |
| Derivation engine (formula registry + resolution) | 95% |
| Flow engine (dynamic steps, load hook, edit path, chaining) | 90% |
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
# Static checks + unit tests (no Supabase needed)
scripts/check.sh
scripts/test-unit.sh

# Start local Supabase (required for integration and e2e)
supabase start

# Integration + smoke (Tier 1 + 2 — pre-merge gate)
scripts/test-integration.sh
scripts/test-smoke.sh

# Full regression + coverage (Tier 3 — nightly)
scripts/test-nightly.sh
```

Each script exits with code 0 on success, code 1 on failure.
On nightly failure, the CI workflow opens a GitHub issue automatically.

---

## Coverage Status

Which flows are covered at which tier, and what has no automated test yet.

### Covered

| Flow | Tier | Type | Notes |
|---|---|---|---|
| Core landlord happy path (building → property → tenant → generate docs → payment) | 2 | E2E smoke | Google/Drive mocked; real Supabase |
| Buildings CRUD | 1 | Integration | Auth, validation, Drive failures, folder reuse |
| Properties CRUD | 1 | Integration | House / commercial / apartment; building scoping |
| Tenants CRUD (create, get, patch) | 1 | Integration | Folder creation, Drive star/unstar, replacement, rollback; current_tenant_id FK written atomically |
| Context load | 1 | Integration | Menu-essential context (landlord name, templates_diff_pending, cron_errors); asserts full snapshot fields absent |
| Document generation | 1 | Integration + unit | Placeholder substitution, case transforms, RLS block; scoped required-check; default column honored |
| Document export / PDF merge | 1 | Integration + unit | Multi-doc merge, stop-on-first-failure, token auth |
| Template diff (fast + slow path) | 1 | Integration + unit | Placeholder detection, witness detection |
| Templates CRUD | 1 | Integration | Create, delete |
| Payments (record + query) | 1 | Integration | on_time boundary logic, paid/overdue split |
| Ad-hoc payment reminder | 1 | Integration | WhatsApp send, `payment_reminders` record, non-500 on failure |
| Account config (reminder frequency) | 1 | Integration | All valid values + invalid inputs |
| Placeholders CRUD | 1 | Integration | Create (derived_formula validated; derived_from rejected), delete (idempotent, URL-encoded) |
| Witnesses CRUD | 1 | Integration | Create, uniqueness |
| Setup / onboarding complete | 1 | Integration | Folder ID, WhatsApp, Autentique key validation |
| Substitution engine | 1 | Unit | applyCase, substituteTokens |
| Derivation engine — formula registry | 1 | Unit | Each registry function; topological resolution; sibling dependencies; circular dep error; unknown function error |
| Derivation engine — flow integration | 1 | Unit | generate_document Flow 3a (chained, implicit initial); Flow 3b (menu, explicit use_case); confirm table; assembled placeholders map |
| Flow engine — dynamic steps + load hook | 1 | Unit | Dynamic step resolution; async load hook fires after validate; hook result carried in values |
| Flow engine — reply-to-edit | 1 | Unit | Field cleared on edit; transitive derived dependents cleared; confirm table re-shown |
| Flow engine — cross-flow chaining | 1 | Unit | nextIntent hand-off; state carry from add_tenant to generate_document |
| ERROR_MAP contract | 1 | Unit | Every error code emitted by any endpoint exists in ERROR_MAP |
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
| template_sync flow (Flow 2) — full interactive round-trip | Blocked on flow implementation (G12) |
| record_payment flow (Flow 5) | Blocked on flow implementation (G13) |
| view_overdue flow (Flow 6) | Blocked on flow implementation (G14) |
| update_account_config flow (Flow 10) | Blocked on flow implementation (G15) |

For manual coverage of these flows, see [docs/MANUAL-TEST.md](../docs/MANUAL-TEST.md).
