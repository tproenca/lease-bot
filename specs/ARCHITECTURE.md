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

## Custom GPT Architecture

**One GPT deployed by the developer** — single link shared with all landlords. Landlords do not configure their own GPT.

**Context loading:** at conversation start, the GPT calls `GET /context` which returns the landlord's full world:
```json
{
  "landlord": { "name": "...", "whatsapp": "..." },
  "properties": [...],
  "buildings": [...],
  "templates": [...],
  "placeholders": [...],
  "witnesses": [...],
  "account_config": { "payment_reminder_frequency": "weekly" }
}
```

**System prompt:** static, same for all landlords — behavior rules, Portuguese language, confirmation protocol, intent surface, derived field computation rules, API usage instructions.

**Repo artifacts:**
- `gpt/SYSTEM_PROMPT.md` — source of truth for GPT instructions
- `gpt/GPT_CONFIG.md` — name, description, conversation starters, capability settings
- `specs/openapi.yaml` — OpenAPI action schema uploaded to the GPT

---

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
