# DevOps — Lease Assistant

## Environments

| Environment | Purpose | Infrastructure |
|-------------|---------|---------------|
| `local` | Development and testing | Supabase CLI + local Docker (`supabase start`) |
| `production` | Live system | Supabase project, region `sa-east-1` (São Paulo) |

No staging environment — scale (~10 landlords) doesn't justify it. All validation happens locally before deploying to production.

---

## Deployment

All deployment is manual, performed by the developer via Supabase CLI.

**Deploy Edge Functions:**
```sh
supabase functions deploy --project-ref <project-ref>
```

**Apply DB migrations:**
```sh
supabase db push --project-ref <project-ref>
```

**Deploy everything:**
```sh
supabase deploy --project-ref <project-ref>
```

No CI/CD pipeline at this scale. Deployment is intentional and developer-triggered.

---

## Environment Variables and Secrets

All secrets are stored as Supabase Edge Function secrets — never hardcoded or committed.

**Set a secret:**
```sh
supabase secrets set KEY=value --project-ref <project-ref>
```

**Required secrets:**

| Variable | Description | Required |
|----------|-------------|---------|
| `GOOGLE_CLIENT_ID` | Google OAuth app client ID | Required |
| `GOOGLE_CLIENT_SECRET` | Google OAuth app client secret | Required |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (internal use) | Required |
| `META_WHATSAPP_TOKEN` | Meta WhatsApp Business Cloud API token | Required (Phase 3) |
| `META_WHATSAPP_PHONE_ID` | Meta WhatsApp sender phone number ID | Required (Phase 3) |

**Per-landlord secrets:** Both the Autentique API key (`landlords.autentique_api_key`) and the per-landlord Autentique webhook Endpoint Secret (`landlords.autentique_webhook_secret`) are stored per-landlord, not in environment variables. Each landlord registers their own webhook in their own Autentique account during onboarding (the unique Endpoint Secret is shown once on creation and pasted into the GPT / setup page).

**Local development:** secrets are set in `supabase/.env.local` (gitignored). See `.env.example` for the full list with placeholder values and [docs/SETUP.md](../docs/SETUP.md) for step-by-step instructions on obtaining each value.

---

## Rollback Strategy

**Edge Functions:** redeploy the previous version by checking out the previous git commit and redeploying:
```sh
git checkout <previous-commit>
supabase functions deploy --project-ref <project-ref>
```

**DB migrations:** migrations are forward-only. No destructive changes (DROP, ALTER with data loss) without a compensating migration that restores the previous state. If a migration causes issues, write a new migration to fix it — never revert a migration manually.

---

## Monitoring and Alerting

| Signal | Source | How to access |
|--------|--------|--------------|
| Edge Function logs | Supabase dashboard → Functions → Logs | Real-time and searchable |
| DB query performance | Supabase dashboard → Database → Query Performance | Review periodically |
| pg_cron failures | `cron_errors` table in DB | Surfaced in `GET /context` response to GPT |
| Drive API errors | Edge Function logs (tagged `[drive]`) | Supabase dashboard |
| Autentique webhook failures | Edge Function logs (tagged `[autentique]`) | Supabase dashboard |

No external alerting service at this scale. The `cron_errors` table surfaced in the GPT context ensures the landlord (and developer) are aware of scheduler failures at the next conversation.

---

## Dependency Management

Dependencies are Deno modules imported via URL or `deno.json` import map. No automated dependency update tool (no Dependabot/Renovate in local mode).

**Manual update workflow:**
1. Check for updates periodically (monthly or when a security advisory is published)
2. Before updating any dependency, check which Edge Functions import it (`grep -r "module-name" supabase/functions/`)
3. Do not update dependencies while agents are actively working in affected files — coordinate to avoid conflicts
4. After updating, run `scripts/check.sh && scripts/test-unit.sh && scripts/test-integration.sh && scripts/test-smoke.sh` to verify all tests still pass before merging
5. Update the import map version pin in `deno.json` and commit with message: `chore: update <module> to <version>`
