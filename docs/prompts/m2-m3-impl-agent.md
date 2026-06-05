You are implementing the **flow engine and document-generation core** for the Lease Assistant project — a Supabase Edge Functions backend (Deno/TypeScript) backing a ChatGPT Custom GPT for Brazilian landlords.

**Read these files before writing any code:**
1. `AGENTS.md` — your full working contract: branch naming, commit format, pre-merge self-verification checklist, iteration limits, escalation protocol
2. `specs/DESIGN.md` — data model and flow definitions
3. `specs/TESTING.md` — required unit tests per component
4. `specs/adr/0016-deterministic-derivation-over-gpt.md` through `specs/adr/0020-derivation-engine-closed-formula-registry.md` — read all five ADRs deeply before touching derivation or flow engine code
5. `specs/adr/0018-lazy-per-flow-loading-and-dynamic-steps.md` — read before touching the flow engine

**Your scope — work these issues in order:**

| # | Issue | Why this order |
|---|---|---|
| 1 | `#199` — engine dynamic steps + async load hook on FlowDefinition [G1] | Already in-progress. Check current branch state first (`git branch -a | grep 199`). Everything else builds on this. |
| 2 | `#206` — properties.current_tenant_id FK — migration + write on tenant add/archive [G10] | Independent Supabase migration. Do it early so #208 is unblocked when you reach it. |
| 3 | `#210` — lazy loading — replace per-step loadContext with targeted deps; shrink /context to menu essentials [G6] | Architectural change that all subsequent flows must conform to. |
| 4 | `#201` — loadPlaceholderUnion internal dep — resolve placeholder union for (property_type, use_case) [G7] | Required by the generate_document rewrite. |
| 5 | `#202` — scope /documents/generate required-check to template union + honor default column [G9] | Small backend fix; feeds generate_document correctness. |
| 6 | `#207` — cross-flow chaining mechanism — add_tenant → generate → send [G3] | Mechanism used by #204, #208, #209. Build it before those flows. |
| 7 | `#205` — reply-to-edit at confirm table — clear field + dependents, re-ask, re-derive [G2] | Confirm table UX. Implement before #203 which builds the confirm table itself. |
| 8 | `#203` — rewrite generate_document flow — Flow 3b [G8] | The big one. Depends on #199, #201, #210, #202, #205. |
| 9 | `#204` — generate_document Flow 3a — chained from add_tenant, implicit use_case=initial [G8 part 2] | Depends on #203 and #207. |
| 10 | `#208` — add_tenant — chain to generate + warn on active-tenant replace [G18] | Depends on #206 (migration) and #207 (chaining). |
| 11 | `#209` — add_property — new building inline (Flow 9) [G17] | Depends on #207 for the chain pattern. |
| 12 | `#200` — template_sync flow — interactive per-change config, Option B derived menus [G12] | Uses dynamic steps (#199). Comes last so all flow engine patterns are established. |

**For each issue:**
1. Read the full issue body: `gh issue view NUMBER`
2. Check for an existing branch: `git branch -a | grep issue-NUMBER` — if found, check it out and continue from where it left off
3. Implement, then run `scripts/check.sh` (static + unit)
4. For any issue touching migrations or DB queries, also run `scripts/test-integration.sh` (requires `supabase start`)
5. Complete the pre-merge self-verification checklist from `AGENTS.md`
6. Open a PR using the repo's PR template — fill every section before running:
   ```bash
   gh pr create --title "feat: ..." --body "$(cat .github/pull_request_template.md)"
   ```
7. **Wait.** Do not start the next issue until this PR is reviewed and merged.

**Hard rules:**
- The derivation engine (`supabase/functions/workflow/derivation/`) must be a pure function — no `fetch`, no network calls, no side effects. Unit-test every formula before using it in an endpoint.
- Flow definitions (`supabase/functions/workflow/flows/*.ts`) must not import from `google.ts`, `autentique/`, or `whatsapp/`. Data from external sources arrives via `deps` only — never call external APIs directly from a flow step.
- Every Supabase migration is forward-only. No `DROP` without a prior deprecation step.
- Every new or changed endpoint must be reflected in `specs/openapi.yaml`.
- `CHANGELOG.md ## Unreleased` must be updated before opening each PR.
- Max 2 self-verification attempts before escalating (see `AGENTS.md` Escalation Protocol).
