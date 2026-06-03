# Product Requirements Document — Lease Assistant

## Problem Statement and Goals

Brazilian landlords spend significant time manually creating lease documents: copying templates, filling in tenant data, computing dates and totals, exporting to PDF, coordinating signatures, and filing the signed result. The process is error-prone and slow.

Lease Assistant automates this end-to-end through a conversational interface. A ChatGPT Custom GPT guides the landlord through data collection, a backend API handles document generation and Drive filing, and an e-signature flow (Autentique) handles the signing lifecycle. The landlord's data never leaves their own Google Drive.

**Primary goal:** A landlord can go from zero to all parties notified for signing in under 10 minutes.

---

## Target Users

Brazilian landlords managing residential or commercial properties. Initial target: up to 10 landlords, each managing up to ~10 properties. The product is designed for landlords who are comfortable with WhatsApp and Google Drive but are not technical.

---

## Core Features

### 1. First-Time Setup

A minimal onboarding flow (no frontend framework required). The landlord:
1. Signs in with Google OAuth — their only identity in the system
2. Picks their Google Drive root folder and optionally names their templates subfolder (defaults to `Templates/`)
3. Provides their WhatsApp number for signing notifications (tenants are also notified via WhatsApp only)

Once submitted, their account is active. All subsequent interaction happens through the GPT.

### 2. Custom GPT Interface

A ChatGPT Custom GPT is the primary interface for all landlord interactions — document generation, payment tracking, and reminders. The GPT is a thin conversational shell: it parses free-text input, routes intents, and renders messages returned by the backend. It does not compute values.

All flow logic, collection, validation, derivation, and assembly run server-side through `POST /workflow/next`. The GPT relays user messages and displays what the backend returns.

### 3. Document Generation

The backend assembles all placeholder values — collecting asked inputs, auto-filling context values (tenant name, CPF, etc.), computing derived values (end date, amount in words, formatted CPF, full date text) via a deterministic server-side formula registry, and applying defaults. The landlord reviews a complete confirm table before generation is triggered.

The generation endpoint receives the fully-resolved placeholder map and substitutes tokens into all templates matching the property type and use case. Generated documents are saved to the landlord's Drive, organized by property and tenant. Regeneration overwrites the existing file.

Templates are Google Docs managed directly by the landlord in Drive. Placeholders follow a `{{nome do campo}}` syntax; definitions and metadata are stored in the database. When templates change, the system detects the diff at session start and walks the landlord through configuration interactively (Flow 2 — Template Sync) before rendering the menu.

The system supports three use cases per template: `initial` (new lease), `renewal`, and `termination`.

### 4. E-Signature Flow

After document generation, the GPT can initiate signing:
1. All generated documents are exported to PDF and merged into a single bundle
2. The bundle is submitted to Autentique with all signers: tenant, landlord, and the landlord's fixed set of witnesses
3. Autentique notifies all parties via WhatsApp
4. When everyone signs, the signed PDF is automatically saved back to the landlord's Drive

### 5. Manual Payment Tracking

The landlord reports payments conversationally ("João pagou o aluguel de maio"). The system records the payment against the tenant and reference month. The GPT can query who hasn't paid and send WhatsApp reminders.

---

## Non-Goals (Out of Scope for Phase 1)

- **Tenant portal** — tenants never log into the system
- **In-app template editing** — landlords manage templates directly in Google Drive
- **Pix webhook integration** — deferred to Phase 4 (milestone M7); payments are recorded manually
- **Mobile app** — interaction is through the Custom GPT only; setup is a web page
- **Multi-language support** — Portuguese (Brazil) only
- **Template creation from scratch** — landlords bring their own Google Docs templates
- **Per-template `required` overrides** — `required` is global per placeholder; a `template_placeholders` join table is deferred unless a real template needs per-document requiredness
- **Arbitrary derivation expressions** — only the closed formula registry is supported; new formulas require a code change and an ADR; anything unsupported is an asked field
- **GPT in the value pipeline** — GPT stays at the conversational boundary; it never computes values that land in the database or a legal document
- **Tenant lease-start/status field** — "active" is expressed solely by `properties.current_tenant_id`; no `tenants.is_active` flag

---

## Success Metrics

- **Primary:** A landlord completes the full flow (conversation → documents generated → all parties notified for signing) in under 10 minutes
- **Secondary:** Zero documents generated without explicit landlord confirmation in chat
- **Secondary:** Signed PDFs are saved to Drive automatically within 5 minutes of the last signature

---

## Constraints and Assumptions

- Brazil-only: Autentique for e-signatures, WhatsApp for notifications, Portuguese UI
- All document storage is in the landlord's own Google Drive — no proprietary storage
- Google OAuth is the sole identity mechanism — no username/password login
- One Custom GPT deployed by the developer, shared across all landlords via a single link; landlords authenticate via OAuth built into the GPT action
- At conversation start, the GPT calls `GET /context` for menu essentials (landlord name, template-diff flag); all other data is loaded lazily per-flow by the server-side engine — the GPT system prompt is static
- The backend is a server-driven flow engine: all collection, validation, derivation, and assembly run server-side. `POST /documents/generate` is a pure substitution endpoint; derivation runs in the workflow layer before the generation call
- The landlord interacts with the system exclusively through the GPT after initial setup
- Witnesses are discovered from templates (hardcoded names below signature lines); their WhatsApp numbers are collected once by the GPT when a new witness name is first detected
- Scale: ~10 landlords, ~10 properties each — no high-availability or horizontal scaling required in Phase 1

---

## Milestones and Phasing

### M1 — Auth: signup / sign-in / re-auth
Verify auth boundaries end-to-end through `/workflow/next`: unregistered → onboarding, expired Google → reauth, invalid JWT → 401. Error surfacing reorder + ERROR_MAP contract test. Remove legacy direct `/setup` flow.

### M1.5 — CI/CD Pipeline
Lint + test + deploy on merge. Enables continuous delivery from M2 onward.

### M2 — Templates, Placeholders, and Derived Fields *(blocks M3)*
Landlords can configure templates with property types and use cases, define derived placeholder formulas via a guided numbered menu, and see all detected template/placeholder changes synced interactively at session start before the main menu appears.

### M3 — Add Tenant / Add Property / Generate Contract *(depends on M2)*
Full end-to-end contract generation: the assistant resolves placeholder values automatically (context auto-fill + derived formulas), shows a confirmation table, and allows the landlord to edit any individual field before submitting. Adding a tenant flows directly into generating the contract and sending for signature.

### M4 — Production Deployment and Monitoring
Deploy workflow finalized. BetterStack `/health/cron` monitor.

### M5 — Signing
Expand `send_signature`: signer listing (tenant/landlord/witnesses), ask missing WhatsApp, chain from generate.

### M6 — WhatsApp and Payment Reminders
`record_payment` flow (Flow 5). `view_overdue` flow (Flow 6) with reminder confirmation. `update_account_config` flow (Flow 10, NL-triggered).

### M7 — Pix Integration
Pix QR code generation. Pix webhook integration.

---

## Key Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Autentique API changes or downtime | Wrap in an adapter so the provider can be swapped; add retries |
| Signature position markers not found in PDF | Fall back to manual position specification; log failures for review |
| Derivation engine produces wrong values (e.g. wrong end date) | Deterministic formula registry with unit tests per formula; landlord reviews confirm table before generation; no GPT in the value pipeline |
| Landlord's Drive folder structure changes | Store folder IDs (not paths) — stable even if folders are renamed or moved |

---

## Prototype Gate

No high-risk assumptions require spiking before writing specs. The Autentique and Google Drive APIs are well-documented and used in production by other apps.
