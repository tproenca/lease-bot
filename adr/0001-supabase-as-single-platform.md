# ADR-0001: Supabase as Single Platform
Date: 2026-05-18
Status: Accepted

## Context
The project needed a runtime for API endpoints, a relational database, an auth layer, and a job scheduler. These could be assembled from separate services (e.g. Railway for compute, Neon for Postgres, Auth0 for auth, an external cron service) or sourced from a single platform.

## Decision
Use Supabase for everything: Edge Functions (Deno) for API endpoints, PostgreSQL for the database, Supabase Auth for Google OAuth, and pg_cron for scheduled payment reminders.

## Alternatives Considered
- **Separate services (Railway + Neon + Auth0 + cron):** More flexibility per layer but significantly higher operational complexity — multiple dashboards, multiple billing accounts, multiple failure points.
- **Vercel + Neon + Clerk:** Popular stack but adds cost and complexity without benefit at this scale.
- **Self-hosted VPS:** Maximum control but requires DevOps work that is not justified for ~10 landlords.

## Consequences
- Single dashboard, single deployment command, single billing account.
- pg_cron is available out of the box — no external scheduler needed.
- Tied to Supabase's platform and pricing. If scale grows significantly, revisit.
- Edge Functions run on Deno — TypeScript is the only language option.
