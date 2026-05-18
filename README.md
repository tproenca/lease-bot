# Lease Assistant

Lease Assistant lets Brazilian landlords generate, sign, and track residential and commercial lease documents through a ChatGPT Custom GPT. The landlord has a conversation, confirms a summary, and the backend handles document substitution, Drive filing, and e-signature — all in under 10 minutes.

All documents live in the landlord's own Google Drive. No proprietary file storage.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Supabase Edge Functions (Deno / TypeScript) |
| Database | Supabase PostgreSQL + pg_cron |
| Auth | Supabase Auth (Google OAuth) |
| Document store | Google Drive API |
| E-signature | Autentique (WhatsApp delivery) |
| Notifications | Meta WhatsApp Business Cloud API |
| Interface | ChatGPT Custom GPT (one deployment, shared by all landlords) |

---

## Prerequisites

- [Supabase CLI](https://supabase.com/docs/guides/cli) (`brew install supabase/tap/supabase`)
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (required by Supabase local dev)
- [Deno](https://deno.land/) v1.40+
- A Google Cloud project with Drive API enabled and OAuth credentials configured
- An [Autentique](https://autentique.com.br) account and API key
- A Meta WhatsApp Business Cloud account and approved message templates

---

## Run Locally

```bash
# Start local Supabase (PostgreSQL + Auth + Edge Functions runtime)
supabase start

# Copy and fill in the required environment variables
cp .env.example .env.local

# Deploy Edge Functions to the local Supabase instance
supabase functions serve --env-file .env.local
```

The local API is available at `http://localhost:54321/functions/v1/`.

The onboarding page is served at `http://localhost:54321/functions/v1/setup`.

---

## Run Tests

```bash
# Tier 1 + Tier 2 (unit, integration, critical e2e — run before every merge)
scripts/ci.sh

# Tier 3 (full e2e suite — run nightly on main)
scripts/nightly.sh
```

See [specs/TESTING.md](specs/TESTING.md) for the full testing strategy and coverage expectations.

---

## Folder Structure

```
.
├── supabase/
│   ├── functions/       — Edge Functions (one folder per endpoint)
│   └── migrations/      — PostgreSQL schema migrations
├── gpt/
│   ├── SYSTEM_PROMPT.md — GPT system prompt (source of truth)
│   └── GPT_CONFIG.md    — GPT name, description, conversation starters
├── specs/               — Design documents (PRD, architecture, API, security, testing, DevOps)
├── adr/                 — Architecture Decision Records
└── scripts/
    ├── ci.sh            — Tier 1 + Tier 2 tests
    └── nightly.sh       — Tier 3 full e2e suite
```

---

## Deeper Context

- [specs/PRD.md](specs/PRD.md) — product goals, features, phasing, and risks
- [specs/ARCHITECTURE.md](specs/ARCHITECTURE.md) — system design and tech stack decisions
- [specs/DESIGN.md](specs/DESIGN.md) — database schema, API contracts, and user flows
- [specs/openapi.yaml](specs/openapi.yaml) — OpenAPI 3.1 action schema (uploaded to the Custom GPT)
- [adr/](adr/) — Architecture Decision Records
