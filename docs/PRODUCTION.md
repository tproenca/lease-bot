# Production Deployment — Lease Assistant

Everything in `docs/SETUP.md` covers local development. This document covers the
additional steps and differences when deploying to production.

---

## 1. Supabase — create a hosted project

1. Go to [supabase.com](https://supabase.com) → **New project**
2. Choose an organisation, name the project (e.g. `lease-assistant`), and pick a region
3. Copy the **Project ref** (the short ID in the project URL, e.g. `abcdefghijklmnop`)

### Push the database schema

```sh
supabase link --project-ref <project-ref>
supabase db push --linked
```

### Set Edge Function secrets

Instead of `supabase/.env.local`, production secrets are set via the CLI:

```sh
supabase secrets set GOOGLE_CLIENT_ID=... --project-ref <project-ref>
supabase secrets set GOOGLE_CLIENT_SECRET=... --project-ref <project-ref>
supabase secrets set AUTENTIQUE_WEBHOOK_SECRET=... --project-ref <project-ref>
supabase secrets set META_WHATSAPP_TOKEN=... --project-ref <project-ref>
supabase secrets set META_WHATSAPP_PHONE_ID=... --project-ref <project-ref>
```

### Deploy Edge Functions

```sh
supabase functions deploy --project-ref <project-ref>
```

Production API base URL: `https://<project-ref>.supabase.co/functions/v1`

---

## 2. Google Cloud Console — production settings

### OAuth consent screen

When going live, return to **APIs & Services → OAuth consent screen → Branding** and fill
in the fields that were left blank during local setup:

- **App domain**: your Supabase project URL (e.g. `<project-ref>.supabase.co`)
- **Authorized domains**: add `supabase.co` — required by Google to validate your
  redirect URI domain

  Leave both fields blank for local-only (Testing-status) apps; Google does not require
  them until you publish.

Click **Publish app** to move from Testing → Production. Google may show an "app not
verified" warning until you complete Google's verification process; for low-user-count
tools you can proceed without full verification.

### OAuth credentials — confirm production redirect URI

In **Credentials → your OAuth 2.0 Client ID → Authorized redirect URIs**, confirm:

```
https://<project-ref>.supabase.co/functions/v1/auth/callback
```

(This was included in `docs/SETUP.md § Create OAuth credentials` — just verify it is
saved before going live.)

---

## 3. Autentique — production webhook

Update the webhook URL from your ngrok domain to the Supabase production URL:

1. In Autentique → **Configurações → Webhooks**, edit your existing webhook
2. Change the URL to:
   `https://<project-ref>.supabase.co/functions/v1/webhooks/autentique`
3. The **Secret** and event (**Documento finalizado**) remain unchanged

---

## 4. Meta WhatsApp — moving out of sandbox

The test token and test sender number from `docs/SETUP.md` only work for pre-verified
sandbox recipients. For production:

1. **Permanent token** — in Meta Business Manager, create a System User with
   `whatsapp_business_messaging` permission and generate a permanent token; use it as
   `META_WHATSAPP_TOKEN`
2. **Verified phone number** — register and verify a real business phone number in
   WhatsApp Manager; use its Phone Number ID as `META_WHATSAPP_PHONE_ID`
3. **Message templates** — production messaging to unverified numbers requires a
   Meta-approved template; submit a template matching your payment reminder body in
   **WhatsApp Manager → Message Templates** and wait for approval (typically 1–2 business
   days)

---

## 5. Privacy policy — upload to production bucket

**This step is automated by the deploy workflow.** Every deploy run uploads
`docs/privacy-policy.html` to the `legal` storage bucket automatically, after the
database migrations run (which create the bucket). No manual action is needed on a
normal deploy.

Manual fallback (e.g. to upload without triggering a full deploy):

```sh
supabase storage cp docs/privacy-policy.html ss:///legal/privacy-policy.html \
  --project-ref <project-ref>
```

The public URL is:
```
https://<project-ref>.supabase.co/storage/v1/object/public/legal/privacy-policy.html
```

Set this URL in the Custom GPT → **Actions → Authentication → Privacy Policy URL**.

---

## 6. CI/CD — automated deploy workflow

Deployments to production are automated via `.github/workflows/deploy.yml`.

### Triggers

- **Automatic** — runs when the `CI` workflow completes successfully on `main`. The job
  is guarded by `github.event.workflow_run.conclusion == 'success'`, so a failed CI run
  never triggers a deploy.
- **Manual** — can be triggered at any time from **Actions → Deploy → Run workflow** in
  the GitHub UI (useful for hotfixes or re-deploys without a new commit).

### Required GitHub secrets

Add these in **Settings → Secrets and variables → Actions** of your repository:

| Secret | Value |
|---|---|
| `SUPABASE_PROJECT_REF` | Your Supabase project ref (e.g. `abcdefghijklmnop`) |
| `SUPABASE_ACCESS_TOKEN` | A Supabase personal access token (generate at supabase.com/dashboard/account/tokens) |

### What the workflow does

1. Links the project (`supabase link --project-ref <ref>`), then runs `supabase db push --linked` — applies any pending database migrations.
2. Uploads `docs/privacy-policy.html` to the `legal` storage bucket (`ss:///legal/privacy-policy.html`) — runs after DB push so the bucket created by migration `20260519230145_legal_storage_bucket.sql` already exists. The upload is idempotent; re-running overwrites the object.
3. Runs `supabase functions deploy --project-ref <ref>` — deploys all Edge Functions.

Migrations run first so the schema is up to date before new function code goes live.

---

## 7. Custom GPT — switch to production

1. In the Custom GPT → **Actions**, update the server URL to:
   `https://<project-ref>.supabase.co/functions/v1`
2. Remove the `ngrok-skip-browser-warning` custom header (only needed for ngrok tunnels)
3. Confirm the **Privacy Policy URL** is the production URL from § 5 above
