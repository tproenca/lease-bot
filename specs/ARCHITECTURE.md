# Architecture — Lease Assistant

## System Components

```
┌─────────────────────────────────────────────────────┐
│                 ChatGPT Custom GPT                  │
│        (one deployment, shared by all landlords)    │
└────────────────────┬────────────────────────────────┘
                     │ HTTPS + OAuth token header
┌────────────────────▼────────────────────────────────┐
│            Supabase Edge Functions (Deno)           │
│                                                     │
│  /setup          /auth/callback  /setup/complete    │
│  /context        /templates/diff                    │
│  /documents/generate  /signatures/send              │
│  /webhooks/autentique/{landlord_id}  /webhooks/pix  │
│  /tenants  /properties  /payments  /placeholders    │
└──────┬───────────────┬──────────────────────────────┘
       │               │
┌──────▼──────┐  ┌─────▼──────────────────────────────┐
│  Supabase   │  │         Google Drive API            │
│  PostgreSQL │  │  (landlord's own Drive account)     │
│  + Auth     │  │  Templates/ generated docs/ PDFs/   │
└─────────────┘  └────────────────────────────────────┘
                         │
          ┌──────────────┼──────────────┐
          │              │              │
   ┌──────▼─────┐ ┌──────▼──────┐ ┌───▼──────────────┐
   │ Autentique │ │  Meta Cloud │ │    pg_cron        │
   │ (signing + │ │  WhatsApp   │ │ (payment reminder │
   │  webhooks) │ │ (reminders) │ │  scheduler)       │
   └────────────┘ └─────────────┘ └──────────────────┘
```

**Key interaction flows:**
- **Landlord → GPT → API:** all landlord actions go through the Custom GPT, which calls Edge Functions via its OpenAPI action
- **API → Drive:** all document operations (copy, substitute, export, save) happen against the landlord's own Google Drive
- **API → Autentique:** signing submission and webhook receipt
- **API → Meta WhatsApp:** ad-hoc payment reminders
- **pg_cron → API:** scheduled payment reminder execution

---

## Tech Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| Runtime | Supabase Edge Functions (Deno / TypeScript) | Single platform for compute, DB, auth, and scheduler; no server to maintain |
| Database | Supabase PostgreSQL | Co-located with Edge Functions; pg_cron built in |
| Auth | Supabase Auth (Google OAuth) | Landlords already have Google accounts for Drive; no separate identity |
| PDF | pdf-lib | Mature TypeScript PDF library; handles merge and validation in Deno |
| Scheduler | pg_cron | Built into Supabase PostgreSQL; no external cron service needed |
| E-signature | Autentique | Brazilian platform with native WhatsApp delivery for signing |
| Notifications | Meta WhatsApp Business Cloud API | Official API for payment reminders; free tier covers this scale |
| Frontend | None | Setup flow served as plain HTML from Edge Functions; no build pipeline |

---

## Infrastructure and Hosting

All infrastructure runs on a single Supabase project:

```
Supabase project (sa-east-1 — São Paulo)
├── Edge Functions      — API endpoints (Deno, auto-scaled)
├── PostgreSQL          — primary database
├── Supabase Auth       — Google OAuth, JWT issuance
└── pg_cron             — scheduled payment reminders
```

**Environments:**
- `local` — Supabase CLI + local Docker (`supabase start`)
- `production` — single Supabase project, deployed via `supabase deploy`

No staging environment — scale (~10 landlords) doesn't justify it. Local dev against a local Supabase instance is sufficient.

**Region:** `sa-east-1` (São Paulo) — closest to the Brazilian user base; keeps data residency in Brazil.

---

## Auth Strategy

```
Identity provider:  Google OAuth 2.0 (via Supabase Auth)
Session:            Supabase JWT issued after OAuth callback
API auth:           OAuth token in Custom GPT action request header
                    → Edge Functions verify via Supabase Auth
Google scopes:
  - openid, email, profile          (identity)
  - https://www.googleapis.com/auth/drive  (Drive read/write)
```

**Onboarding flow:**
1. Landlord visits `/setup` → redirected to Google OAuth consent
2. Google redirects to `/auth/callback` with authorization code
3. Edge Function exchanges code for tokens → Supabase Auth creates session → JWT issued
4. All subsequent GPT action calls carry the JWT in `Authorization: Bearer` header
5. Edge Functions verify JWT with Supabase Auth before processing any request

**GPT action auth:**
Custom GPT native OAuth support — when a landlord first triggers an action, the GPT initiates the OAuth flow. The token is stored by the GPT and sent with every subsequent action call.

**No tenant auth** — tenants never log in. They interact only via WhatsApp (signing links, payment reminders).

**Drive token storage** — Google OAuth refresh token stored in the landlord's Supabase Auth record; Edge Functions use it to obtain fresh access tokens for Drive operations.

**Autentique API key storage** — each landlord has their own Autentique account (created with their Google account at autentique.com.br). Their API key is stored per-landlord in `landlords.autentique_api_key` (encrypted at rest via Supabase Vault). Edge Functions read the key for the authenticated landlord before calling Autentique.

---

## Server-Driven Flow Engine

All landlord interaction flows run through `POST /workflow/next` via a server-side engine (`runFlowEngine`). The GPT is a thin conversational shell: it parses free-text input, routes intents, and renders the messages the backend returns. It never computes values that land in the database or a legal document.

**The dividing line:**
- GPT: understand messy human input ("o aluguel é mil e quinhentos" → `1500`), intent routing, natural-language rendering, numbered option lists.
- Backend: all collection, validation, derivation, assembly, and substitution. See ADR-0016, ADR-0017.

**Flow engine features:**
- Steps are resolved dynamically from collected `values` — `FlowDefinition.steps` is a function, not a static array.
- An optional async `load` hook on each step fires after `validate` to lazily fetch data needed for subsequent steps (e.g., loading the placeholder union for the target property type and use case).
- **Reply-to-edit path:** at the confirm table, if the landlord replies with a field number or label instead of "Sim", the engine clears that value and any derived values that depend on it, re-asks only that step, re-derives, and returns to the confirm table.
- **Cross-flow chaining:** a flow can declare a `nextIntent` to hand off to another flow after `done` (e.g., `add_tenant` → `generate_document` → `send_signature`).

**Custom GPT architecture:**
One GPT deployed by the developer — single link shared with all landlords. Landlords do not configure their own GPT.

**Session start:** at conversation start, the GPT calls `GET /context` for the menu essentials: landlord name and the template-diff flag. If the diff is non-empty, `template_sync` runs before the menu is rendered. `GET /context` is **not** called again during flow execution — flows load their own data lazily.

**System prompt:** static, same for all landlords — behavior rules, Portuguese language, confirmation protocol, intent surface, `POST /workflow/next` usage instructions.

**Repo artifacts:**
- `gpt/SYSTEM_PROMPT.md` — source of truth for GPT instructions
- `gpt/GPT_CONFIG.md` — name, description, conversation starters, capability settings
- `specs/openapi.yaml` — OpenAPI action schema uploaded to the GPT

---

## Lazy Per-Flow Data Loading

The eager `GET /context` full-snapshot pattern — fetching ~10 tables on every workflow turn — is retired for flow execution. See ADR-0018.

**Scope of `/context`:** menu essentials only — landlord name, and the template-diff flag (whether `GET /templates/diff` is non-empty). No properties list, no placeholder list, no tenant data.

**Per-flow targeted dependencies (`WorkflowDeps` pattern):** each flow declares the data it needs and loads it via targeted `invokeHandler` calls at the step where it is first needed:

| Flow | Lazy deps loaded |
|---|---|
| `generate_document` | `loadPlaceholderUnion(property_type, use_case)` at confirm step; active tenant via `properties.current_tenant_id` FK |
| `add_tenant` | Property list at first step |
| `template_sync` | Full diff result at session start (replaces current discard-and-ignore behavior) |
| `record_payment`, `view_overdue` | Tenant + payment data at first step |

**`loadPlaceholderUnion` (internal dep only):** resolves the set of placeholders used by templates matching `(property_type, use_case)`. This is an internal workflow dependency — not a public endpoint. The flow engine calls it via `invokeHandler`; there is no `GET /placeholders/union` route.

**No per-step `/context` snapshot.** Any flow step that previously called `loadContext` is refactored to use a targeted dep or carry data forward in `values`.

## Deterministic Derivation Engine

Derived placeholder values are computed by a deterministic server-side formula registry in the workflow layer. GPT is not involved in value computation. See ADR-0016, ADR-0017.

**Placement:** the derivation engine runs inside the `generate_document` flow, between collection and the confirm table. `POST /documents/generate` remains a pure substitution endpoint — it receives a fully-resolved `placeholders` map and substitutes tokens only.

**Formula registry (closed set):**

| Function | Inputs | Output |
|---|---|---|
| `identity` | any context path | Identity copy |
| `cpf_format` | CPF digits string | `XXX.XXX.XXX-XX` |
| `amount_in_words` | numeric amount | PT extenso (e.g. "mil e quinhentos reais") |
| `full_date_text` | date | "DD de mês de AAAA" |
| `end_date` | start date, duration in months | ISO date |

Adding a formula requires a code change and a new ADR. The registry is versioned; config-time validation at `POST /placeholders` rejects formulas referencing unknown registry functions.

**Resolution order (at flow time):**
1. Build the placeholder union for `(property_type, use_case)`.
2. Topologically sort by sibling dependencies.
3. Resolve asked values from collected input.
4. Resolve context paths from lazily loaded entity data.
5. Call registry functions for derived placeholders.
6. Apply `default` for anything still empty.
7. Show all resolved values in the confirm table.

## Scalability and Performance

Target scale: ~10 landlords, ~10 properties each, ~100 tenants total. No premature scaling infrastructure.

- **Edge Functions** — auto-scale on Supabase infrastructure; no configuration needed at this scale
- **Database** — standard Supabase PostgreSQL; no read replicas or connection pooling configuration required
- **Drive API** — rate limits are not a concern at this scale; basic retry with exponential backoff is sufficient
- **Autentique API** — same; basic retries cover transient failures
- **pg_cron** — trivial load at this scale
- **PDF operations** — pdf-lib runs in-process within Edge Functions; 256MB memory limit is sufficient for expected document sizes

No caching layer, no queue, no CDN. If landlord count grows beyond ~50, revisit connection pooling and Drive API batching.

---

## Third Party Services and Integrations

| Service | Purpose | Integration point |
|---------|---------|-------------------|
| Google OAuth 2.0 | Landlord identity | Supabase Auth provider |
| Google Drive API | Template storage, document generation, PDF export, signed PDF filing | Edge Functions via Google REST API |
| Google Drive Picker | Root folder selection during onboarding | Google-hosted JS library in setup HTML page |
| Autentique | E-signature submission, WhatsApp signing notifications, signed document webhook | Edge Functions via Autentique GraphQL API; per-landlord API key stored in `landlords.autentique_api_key` |
| Meta WhatsApp Business Cloud API | Payment reminder notifications | Edge Functions via Meta REST API |
| pg_cron | Scheduled payment reminders | Built into Supabase PostgreSQL |
| ChatGPT Custom GPT | Primary landlord interface | Calls Edge Functions via OpenAPI action with OAuth token |

**Adapter pattern** — Autentique is wrapped behind an adapter interface so the e-signature provider can be swapped without touching business logic.

---

## Out of Scope

- **ChatGPT Custom GPT configuration** — configured once on OpenAI's platform by the developer; `gpt/` folder in the repo holds the source of truth for system prompt and settings
- **Template authoring** — landlords create and edit Google Docs templates directly in Drive; no template editor in this repo
- **Tenant-facing UI** — tenants interact only via WhatsApp; no tenant portal, no tenant auth
- **Pix integration** — deferred to Phase 4
- **Multi-language support** — Portuguese (Brazil) only; no i18n infrastructure
- **Mobile app** — no React Native, no PWA; the setup page is a minimal HTML form
