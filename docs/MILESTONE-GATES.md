# Milestone Release Gates

Use this guide at the end of each milestone before starting the next one. It is a
manual acceptance layer on top of the automated checks in `specs/TESTING.md`.

The detailed end-to-end runbook remains `docs/MANUAL-TEST.md`. This file slices that
runbook by milestone so each milestone has a clear deliverable the developer can test
manually.

## Gate Rules

Run a milestone gate only after:

- All GitHub issues assigned to the milestone are closed.
- `scripts/check.sh`, `scripts/test-unit.sh`, `scripts/test-integration.sh`, and
  `scripts/test-smoke.sh` pass where applicable.
- The Custom GPT action schema and server URL point at the environment being tested.
- Any required external accounts are available for that gate.

Record each gate result in the milestone gate issue using:

| Date | Tester | Environment | Result | Notes / follow-ups |
|---|---|---|---|---|
| | | local / production | Pass / Fail / Blocked | |

Exit criteria:

- Every required checklist item is marked pass.
- Failures are either fixed before the gate closes or converted into follow-up GitHub
  issues linked from the gate.
- Operational secrets or credentials are never pasted into GitHub, docs, commits, or
  screenshots.

## M2 - Templates, Placeholders, and Derived Fields

Goal: prove template changes are detected and configured through the server-driven
`template_sync` flow before the main menu appears.

Preconditions:

- A landlord account is onboarded locally or in the target environment.
- The landlord's Drive Templates folder contains at least one editable Google Doc
  template.
- The GPT is configured with the current `gpt/openapi.yaml` and system prompt.

Manual checklist:

- Start a fresh GPT conversation and send `Oi`.
- Edit or add a template so `GET /templates/diff` is non-empty.
- Verify the GPT enters template sync before showing the main menu.
- Verify all detected changes are listed before the GPT walks through them.
- For an added template, configure property type and use case from numbered choices.
- For an added placeholder, configure format, case, required/default/options, and a
  derived value through the numbered formula menu when applicable.
- For an added witness, provide WhatsApp and confirm it is saved.
- Verify every write requires an explicit `Sim` confirmation.
- Restart the chat and verify no template changes remain pending.
- Open the generated placeholder reference document in Drive and confirm the new
  placeholder metadata is visible.

## M3 - Add Property, Add Tenant, Generate Contract

Goal: prove the landlord can create property data, create a tenant, generate documents,
edit the confirm table, and inspect the generated Drive output.

Preconditions:

- M2 gate passed.
- At least one template is mapped to the property type and use case being tested.

Manual checklist:

- Add a house property and verify its Drive folder is created under the landlord root.
- Add a tenant to that property and verify the tenant folder is created and starred.
- If replacing an active tenant, verify the GPT warns before replacement and the old
  tenant folder is no longer the active folder.
- Start contract generation from the menu for the active tenant.
- Verify the flow asks for use case and only asks placeholders that cannot be resolved
  from context, defaults, or formulas.
- Verify derived values are present in the confirmation table.
- Reply with a field number or label at the confirmation table and verify the GPT re-asks
  that field, re-derives dependent values, and returns to confirmation.
- Confirm with `Sim`.
- Open each generated Drive document and verify no `{{placeholder}}` token remains.
- Verify generated documents are saved in the active tenant folder.
- Verify the GPT offers to continue to signing.

## M4 - Production Deployment and Monitoring

Goal: prove the production environment is usable and observable before product flows
continue depending on it.

Preconditions:

- A hosted Supabase project exists in the production region.
- Deployment workflow has run successfully on `main`.
- Production credentials exist for the external services being verified.

Manual checklist:

- Verify the production privacy policy URL is publicly accessible.
- Verify the Custom GPT action server URL, OAuth authorization URL, and token URL all
  use the production Supabase project domain.
- Complete a production OAuth sign-in from the GPT.
- Verify Google Cloud OAuth production settings are complete: app domain, authorized
  domain, published consent screen, and production redirect URI.
- Verify production Edge Function secrets are set in Supabase and no secret values are
  committed to the repo.
- Verify Autentique webhook configuration points to the production webhook URL required
  by the current implementation.
- Verify BetterStack or the chosen uptime monitor calls the cron health endpoint with
  service-role authorization and alerts on non-2xx responses.
- Verify no unexpected production `cron_errors` rows appear after the next scheduled
  payment-reminder run.
- If issue #232 chooses the Supabase Cron Route A design, close issue #231 as superseded
  and verify `docs/PRODUCTION.md` no longer instructs developers to seed `app_config`.

## M5 - Signing

Goal: prove the signing handoff is ready for a real landlord flow.

Preconditions:

- M3 gate passed.
- A generated contract exists in the active tenant's Drive folder.
- Autentique credentials and webhook are configured for the tested environment.

Manual checklist:

- From the post-generation prompt, choose to send for signature.
- Verify the flow lists tenant, landlord, and witnesses with roles and WhatsApp numbers.
- If the tenant WhatsApp is missing, provide it and verify it is persisted.
- Verify landlord and witness WhatsApp values are loaded from stored records, not re-asked.
- Verify the summary lists the documents being submitted.
- Confirm with `Sim`.
- Verify Autentique shows the pending document.
- Complete signing in Autentique.
- Verify the signed PDF is saved back into the tenant Drive folder.
- Verify the GPT explains that signers received WhatsApp links.

## M6 - WhatsApp and Payment Reminders

Goal: prove manual payment tracking, overdue detection, reminder sending, and reminder
frequency configuration work together.

Preconditions:

- M3 gate passed.
- Meta WhatsApp credentials are configured for the tested environment.
- A tenant exists with a valid WhatsApp number.

Manual checklist:

- Record an on-time payment and verify the tenant does not appear overdue for that month.
- Query a later month with no payment and verify the tenant appears overdue.
- Send a manual WhatsApp reminder and verify the tenant receives it.
- Query the overdue month again and verify `last_reminder_sent_at` is populated.
- Send a second manual reminder for the same month and verify the system records the
  second attempt.
- Change reminder frequency through natural language and verify context reflects the
  updated value.
- Verify scheduled reminder behavior according to the final #232 implementation:
  Supabase Cron direct invocation if Route A was selected, or `app_config` seeding if
  the old DB-function path remains.

## M7 - Pix

Goal: prove Pix can be used as the payment collection path without breaking manual
payment tracking.

Preconditions:

- M6 gate passed.
- Pix provider credentials and webhook configuration are available.

Manual checklist:

- Generate a Pix QR code for an active tenant and reference month.
- Verify the GPT returns the payment instructions/link expected by the implementation.
- Simulate or complete a Pix payment through the provider.
- Verify the Pix webhook records the payment against the correct tenant and month.
- Verify duplicate webhook delivery is idempotent.
- Query overdue tenants for that month and verify the paid tenant is excluded.
- Verify manual payment recording still works for tenants not using Pix.
