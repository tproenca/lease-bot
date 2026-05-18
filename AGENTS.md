# AGENTS.md — Lease Assistant

---

## Project Overview

Lease Assistant is a Supabase Edge Functions backend (Deno / TypeScript) that powers a ChatGPT Custom GPT for Brazilian landlords. Core capabilities: document generation via Google Drive template substitution, e-signature via Autentique, payment tracking, and WhatsApp reminders via Meta Cloud API.

All compute lives in `supabase/functions/`. There is no separate server, no build pipeline, and no frontend framework.

---

## Repo Layout

```
supabase/
  functions/       — one subfolder per Edge Function endpoint
  migrations/      — SQL migration files (forward-only)
  .env.local       — local secrets (gitignored)
gpt/
  SYSTEM_PROMPT.md — GPT system prompt source of truth
  GPT_CONFIG.md    — GPT name, description, conversation starters
specs/             — approved design documents (do not edit without updating specs)
adr/               — Architecture Decision Records
scripts/
  ci.sh            — Tier 1 + Tier 2 tests
  nightly.sh       — Tier 3 full suite + coverage
```

---

## Local Development Setup

```sh
# 1. Start local Supabase (PostgreSQL + Auth + Edge Functions runtime)
supabase start

# 2. Copy env vars and fill in values
cp .env.example supabase/.env.local

# 3. Serve Edge Functions locally
supabase functions serve --env-file supabase/.env.local
```

Local API base URL: `http://localhost:54321/functions/v1/`

To apply DB migrations against the local instance:
```sh
supabase db reset
```

---

## Running Tests

```sh
# Pre-merge: Tier 1 (unit + integration) + Tier 2 (e2e smoke) — must pass before merge
scripts/ci.sh

# Nightly: full Tier 3 suite + coverage check (≥80%)
scripts/nightly.sh
```

`supabase start` must be running before executing either script. See `specs/TESTING.md` for full details.

---

## Deployment (Production)

Manual, developer-triggered. Run `scripts/ci.sh` first and confirm it passes.

```sh
supabase functions deploy --project-ref <project-ref>  # Edge Functions
supabase db push --project-ref <project-ref>           # DB migrations
```

---

## Architecture Quick Reference

- All API calls from the GPT carry a `Bearer` JWT verified by Supabase Auth
- RLS policies enforce landlord isolation at the DB layer — every query is automatically scoped to the authenticated landlord
- Google Drive operations use the landlord's stored OAuth refresh token (`landlords.google_refresh_token`) to obtain a fresh access token per request
- Autentique webhook authenticity is verified via HMAC-SHA256 on the `x-autentique-signature` header
- pg_cron triggers payment reminders; failures are logged to `cron_errors` and surfaced in `GET /context`

See `specs/ARCHITECTURE.md` for the full system diagram and `adr/` for the decisions behind these choices.

---

## Scope and Responsibilities

- Work only within the files and folders relevant to your assigned issue.
- Every implementation decision must conform to the approved specs in `specs/`. If you find a conflict between the spec and what is practical, stop and escalate — do not silently deviate.
- If you make a non-obvious architectural decision not already captured in `adr/`, create a new ADR before merging. See [When to Write an ADR](#when-to-write-an-adr).

---

## Issue Dependencies

Do not start work on an issue if any of its dependency issues in `issues.md` are not yet marked `done`. Check the dependency list at the top of each issue before creating a branch.

---

## Branch Naming

```
feat/issue-{N}-short-description
fix/issue-{N}-short-description
refactor/issue-{N}-short-description
chore/issue-{N}-short-description
hotfix/issue-{N}-short-description
```

`{N}` is the issue identifier from `issues.md` (e.g. `2.1`). Branch names with dot notation are valid git syntax.

---

## Commit Format

Conventional Commits. Issue identifier in parentheses at the end.

```
feat: description (2.1)
fix: description (3.2)
refactor: description (1.4)
chore: description (1.1)
docs: description (4.1)
test: description (2.3)
hotfix: description (1.2)
```

---

## Pre-Merge Self-Verification Checklist

Before handing off for review, verify:

- [ ] All tests pass: `scripts/ci.sh`
- [ ] No hardcoded secrets, tokens, or credentials anywhere in the diff
- [ ] No `console.log` debug statements left in Edge Functions
- [ ] Input validation exists at every API boundary (see `specs/SECURITY.md`)
- [ ] RLS is not bypassed (no `service_role` key in Edge Functions unless explicitly documented in `specs/SECURITY.md`)
- [ ] Every new endpoint has a corresponding entry in `specs/openapi.yaml`
- [ ] DB migrations are forward-only — no `DROP` or destructive `ALTER` without a compensating migration
- [ ] Integration tests run against a real local Supabase instance (no mocking Supabase internals)
- [ ] Scope is limited to the assigned issue — no unrelated cleanups or additions
- [ ] `CHANGELOG.md` updated under `## Unreleased`

**Maximum 2 self-verification attempts.** If both fail, escalate — do not loop indefinitely.

---

## Pre-Merge Subagent Check

Before marking a branch ready for review, spawn a subagent to verify the diff:

**Subagent prompt:**
```
Review this diff for: (1) security issues per specs/SECURITY.md, (2) missing input
validation at API boundaries, (3) RLS bypass risks, (4) scope violations against
issues.md #{N}. Report pass or specific failures only.
```

If the subagent reports failures, fix them and run it once more. If it still fails on the second run, escalate to the lead.

---

## Reviewer Agent Rules

After the lead assigns a branch for review, a Reviewer Agent checks the diff against `main`:

1. **Read** the assigned issue in `issues.md` and all relevant specs.
2. **Review** the diff for: correctness, spec compliance, security, test coverage, scope.
3. **Report** one of:
   - `APPROVED` — ready to merge
   - `CHANGES REQUESTED` — list specific required changes (not suggestions)
4. If changes are requested and the teammate fixes them, review again. **Maximum 3 review cycles.**
5. If still not passing after 3 cycles, escalate to the lead with a summary of what remains unresolved.

---

## Escalation Protocol

When blocked or uncertain, escalate with:

```
BLOCKED — issue {N}

What was attempted:
[describe the specific actions taken, max 3 bullet points]

What failed:
[describe the exact failure — error message, test output, or decision conflict]

Specific question:
[one clear question the lead must answer to unblock]
```

Do not guess or work around blockers silently.

---

## When to Write an ADR

Create a new ADR in `adr/` whenever you make a decision that:
- Chooses one of several viable technical approaches
- Selects or changes a third-party dependency
- Introduces a new integration pattern
- Deviates from a decision already documented in an existing ADR

Name format: `adr/NNNN-short-title.md`. Use the next available number.

Template:
```markdown
# ADR-NNNN: [Title]
Date: YYYY-MM-DD
Status: Accepted

## Context
## Decision
## Alternatives Considered
## Consequences
```

---

## CHANGELOG Requirement

Every merge to `main` must include an entry under `## Unreleased` in `CHANGELOG.md`. Format:

```markdown
### Added
- Brief description of new behaviour (issue 2.1)

### Fixed
- Brief description of fix (issue 3.2)

### Changed
- Brief description of change (issue 1.4)
```

---

## Iteration Limits Summary

| Stage | Max attempts |
|-------|-------------|
| Pre-merge self-verification | 2 |
| Pre-merge subagent check | 2 |
| Reviewer Agent review cycles | 3 |

Exceeding any limit → escalate, do not continue.
