# Lease Assistant

[![CI](https://github.com/tproenca/lease-bot/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/tproenca/lease-bot/actions/workflows/ci.yml)
[![Nightly](https://github.com/tproenca/lease-bot/actions/workflows/nightly.yml/badge.svg?branch=main)](https://github.com/tproenca/lease-bot/actions/workflows/nightly.yml)

Lease Assistant lets Brazilian landlords generate, sign, and track residential
and commercial lease documents through a ChatGPT Custom GPT. The landlord has a
conversation, confirms a summary, and the backend handles document substitution,
Drive filing, and e-signature — all in under 10 minutes.

All documents live in the landlord's own Google Drive. No proprietary file
storage.

---

## Tech Stack

| Layer          | Technology                                                   |
| -------------- | ------------------------------------------------------------ |
| Runtime        | Supabase Edge Functions (Deno / TypeScript)                  |
| Database       | Supabase PostgreSQL + pg_cron                                |
| Auth           | Supabase Auth (Google OAuth)                                 |
| Document store | Google Drive API                                             |
| E-signature    | Autentique (WhatsApp delivery)                               |
| Notifications  | Meta WhatsApp Business Cloud API                             |
| Interface      | ChatGPT Custom GPT (one deployment, shared by all landlords) |

---

## Prerequisites

- [Supabase CLI](https://supabase.com/docs/guides/cli)
  (`brew install supabase/tap/supabase`)
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (required by
  Supabase local dev)
- [Deno](https://deno.land/) v2.x
- [ngrok](https://ngrok.com) with a free permanent domain (required to connect the
  Custom GPT to your local backend)
- Google Cloud project with Drive API + OAuth credentials
- [Autentique](https://autentique.com.br) account (for e-signatures, Phase 2)
- Meta WhatsApp Business Cloud account (for payment reminders, Phase 3)

> **Setting up for the first time?** Follow [docs/SETUP.md](docs/SETUP.md) for
> step-by-step instructions on configuring all external services.

---

## Run Locally

```bash
# Start local Supabase (PostgreSQL + Auth + Edge Functions runtime)
supabase start

# Copy and fill in the required environment variables
cp .env.example supabase/.env.local

# Serve Edge Functions against the local Supabase instance
supabase functions serve --env-file supabase/.env.local

# Expose local functions to ChatGPT (required — ChatGPT cannot reach localhost)
ngrok http 54321 --url <your-domain>.ngrok-free.dev
```

The local API is available at `http://localhost:54321/functions/v1/`.

The onboarding page is served at `http://localhost:54321/functions/v1/setup`.

### Connecting the ChatGPT Custom GPT to your local backend

ChatGPT's servers cannot reach `localhost`, so ngrok is required for local
testing.

1. **Get your free static domain** — sign up at [ngrok.com](https://ngrok.com),
   go to Your Authtoken → Static Domain. Your domain (`abc.ngrok-free.dev`) is
   permanent and never changes between restarts.
2. **Start the tunnel** —
   `ngrok http 54321 --url <your-domain>.ngrok-free.dev`
3. **Update the GPT action URL** — in the Custom GPT → Actions, set the server
   URL to `https://<your-domain>.ngrok-free.dev/functions/v1`
4. **Add the bypass header** — in the GPT action config, add a custom header:
   `ngrok-skip-browser-warning: true` (skips the ngrok browser interstitial for
   machine callers)

Free tier limits: 1 static domain, 20k requests/month, 1 GB/month bandwidth.

---

## Run Tests

```bash
# Static checks (format, lint, typecheck)
scripts/check.sh

# Fast tests, no local Supabase required
scripts/test-unit.sh

# Local Supabase-backed PR tests
scripts/test-integration.sh
scripts/test-smoke.sh

# Regression tests + unit coverage — run nightly on main
scripts/test-nightly.sh
```

See [specs/TESTING.md](specs/TESTING.md) for the full testing strategy and
coverage expectations.

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
    ├── check.sh             — format, lint, explicit typecheck
    ├── test-unit.sh         — unit tests
    ├── test-integration.sh  — local Supabase integration tests
    ├── test-smoke.sh        — PR e2e smoke tests
    └── test-nightly.sh      — regression tests + unit coverage
```

---

## Deeper Context

- [docs/SETUP.md](docs/SETUP.md) — step-by-step setup for Google Cloud, Autentique,
  ngrok, and Meta WhatsApp
- [docs/MANUAL-TEST.md](docs/MANUAL-TEST.md) — manual test runbook (10 end-to-end
  flows against a live GPT + local Supabase)
- [specs/PRD.md](specs/PRD.md) — product goals, features, phasing, and risks
- [specs/ARCHITECTURE.md](specs/ARCHITECTURE.md) — system design and tech stack
  decisions
- [specs/DESIGN.md](specs/DESIGN.md) — database schema, API contracts, and user
  flows
- [gpt/openapi.yaml](gpt/openapi.yaml) — GPT-only OpenAPI 3.1 action schema (upload this to the Custom GPT)
- [specs/openapi.yaml](specs/openapi.yaml) — complete API spec (includes Autentique webhook; do not upload to the Custom GPT)
- [adr/](adr/) — Architecture Decision Records
