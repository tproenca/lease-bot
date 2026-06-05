# ADR-0018: Lazy Per-Flow Loading and Dynamic Engine Steps
Date: 2026-06-03
Status: Accepted

## Context

The current `POST /workflow/next` implementation calls `loadContext` (a full DB snapshot
of ~10 tables) on the menu render, on every flow step, and again after `done`. It also
calls `loadTemplatesDiff` at menu render and discards the result.

Problems:
1. **Every step pays the full snapshot cost.** Most of the snapshot data (all properties,
   all placeholders, all tenants, all templates, buildings, witnesses, account_config) is
   irrelevant to the step being executed. For a flow like `add_tenant`, the full snapshot
   is fetched three or more times yet only a property list is needed.
2. **Template diff is fetched and discarded.** The diff result is computed at menu render
   but the data is thrown away — the flow that would consume it (template sync) does not
   exist yet. This means a wasted query on every session start.
3. **Static `steps[]` prevents data-dependent flows.** The `generate_document` flow
   needs to know which placeholders are asked (vs. derived/context-auto-filled) to build
   its step list. A static array cannot express this — the step list depends on data
   loaded after the flow starts.
4. **No async `load` hook.** There is no mechanism for a step to load data and make it
   available to subsequent steps without pre-loading it for the entire flow.

The target design (server-driven flow engine, lazy WorkflowDeps, ADR-0016 derivation
engine) requires all three capabilities: lazy loading, dynamic steps, and load hooks.

## Decision

**1. Retire the eager `/context` DB snapshot for flow execution.**

`GET /context` is repurposed as a menu-essentials endpoint: it returns only landlord
name, the `templates_diff_pending` flag (whether the diff is non-empty), and cron
errors. It is called once at session start. It is not called inside any flow step.

**2. Lazy per-flow targeted dependencies (`WorkflowDeps` pattern).**

Each flow declares the data it needs as named dependency functions. These functions are
called via `invokeHandler` at the step where the data is first needed, not upfront. The
result is carried forward in `values`.

Examples:
- `generate_document`: calls `loadPlaceholderUnion(property_type, use_case)` at the
  first collection step; calls the active-tenant lookup (via `properties.current_tenant_id`)
  at the property-selection step.
- `add_tenant`: loads the property list at step 1 only.
- `template_sync`: loads the full diff result at session start (instead of discarding it).

`loadPlaceholderUnion` is an internal workflow dependency — it resolves the set of
placeholders used by templates matching `(property_type, use_case)`. There is no public
`GET /placeholders/union` endpoint. The flow engine calls it via `invokeHandler`.

**3. Dynamic `FlowDefinition.steps`.**

`FlowDefinition.steps` is changed from a static array to a function:
```
steps(values: Record<string, unknown>): StepDefinition[]
```
The function is called after each step completes. For `generate_document`, it returns
only the asked placeholder steps (those with `derived_formula = null` and no context
auto-fill), derived from the loaded placeholder union. This eliminates the need for
placeholder-count-aware static arrays.

**4. Optional async `load` hook on `StepDefinition`.**

A step may declare an optional `load` hook:
```
load?(values: Record<string, unknown>): Promise<Record<string, unknown>>
```
The hook fires after the step's `validate` completes. Its return value is merged into
`values` before `steps()` is re-evaluated for the next step. This is the mechanism for
lazy data loading mid-flow without coupling the load to a specific step index.

## Alternatives Considered

**Keep eager `loadContext` per step:** Rejected. The cost compounds with flow length and
is paid even when the data is irrelevant. At the target scale (~10 landlords) it is not
a performance crisis, but it is architecturally wrong — any given step fetches data for
10 other flows it is not running.

**Retire `/context` entirely:** Considered and deferred. The menu render needs the
landlord name and the diff flag. Fetching these from individual endpoints on every
session start adds round trips. Keeping `/context` as a menu-essentials endpoint is the
lowest-effort path; full retirement (NL session state entirely in `values`) is a future
option if `/context` accumulates unwanted scope creep.

**Static steps with all placeholder steps pre-declared:** Rejected. The number of asked
placeholder steps is not known until the placeholder union is loaded (which requires the
property type and use case to be known, which are only collected mid-flow). A static
array would require placeholder-count placeholders to be stubbed, which is fragile.

**Load hook as a separate `preStep` hook (fire before validate):** Rejected. Firing
after `validate` is the correct ordering — the step that triggers the load has already
been validated, and the loaded data is for subsequent steps. A `preStep` hook would fire
before the current step's input is validated, loading data that may be irrelevant if
validation fails.

## Consequences

- `GET /context` response schema shrinks significantly; callers that expected the full
  snapshot will need to be updated. The GPT system prompt no longer depends on the full
  snapshot at conversation start.
- Each flow is responsible for loading its own data. This is more explicit but requires
  each flow author to declare deps correctly. Undeclared deps will cause runtime errors
  (missing values) rather than silently using stale snapshot data.
- `loadPlaceholderUnion` is internal. It must not be exposed as a public endpoint to
  avoid coupling the GPT to an internal resolution detail.
- Dynamic `steps()` must handle the case where the loaded data is not yet available
  (e.g., called before the `load` hook fires). The convention is: if required dep data
  is missing from `values`, return a single "loading" placeholder step that triggers the
  load hook.
- The flow engine's `state` token (opaque base64 echoed by the GPT) must carry enough
  context to reconstruct `values` across turns. No change to the token format is needed —
  `values` is already the full state.
