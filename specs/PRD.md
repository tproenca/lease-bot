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

A ChatGPT Custom GPT is the primary interface for all landlord interactions — document generation, payment tracking, and reminders. The GPT:

- Knows the landlord's properties, templates, and placeholder definitions
- Asks only for values the templates actually need
- Computes all derived values (date arithmetic, amounts in full, totals) before generating documents
- Shows a complete summary and requires one explicit confirmation before calling the API

### 3. Document Generation

The backend receives pre-computed values from the GPT and substitutes them into all templates in the landlord's Templates folder. Generated documents are saved to the landlord's Drive, organized by property and tenant. Regeneration overwrites the existing file.

Templates are Google Docs managed directly by the landlord in Drive. Placeholders follow a simple `{{nome do campo}}` syntax; definitions and metadata are stored in the database. When a template changes, the GPT detects it and asks the landlord to confirm any added or removed placeholders before proceeding.

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
- **Pix webhook integration** — deferred to Phase 2; payments are recorded manually
- **Mobile app** — interaction is through the Custom GPT only; setup is a web page
- **Multi-language support** — Portuguese (Brazil) only
- **Template creation from scratch** — landlords bring their own Google Docs templates

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
- Landlord-specific context (properties, templates, placeholders) is fetched dynamically from the API at conversation start — the GPT system prompt is static
- The backend API is a pure substitution engine — all field computation is the GPT's responsibility
- The landlord interacts with the system exclusively through the GPT after initial setup
- Witnesses are discovered from templates (hardcoded names below signature lines); their WhatsApp numbers are collected once by the GPT when a new witness name is first detected
- Scale: ~10 landlords, ~10 properties each — no high-availability or horizontal scaling required in Phase 1

---

## Milestones and Phasing

### Phase 1 — Core Product
1. Onboarding (Google OAuth, Drive folder selection, notification config)
2. Placeholder management (sync with Drive templates, definitions in DB)
3. Template → property type mapping (conversational setup via GPT)
4. Document generation (substitution engine + Drive filing, folder structure per property type)
5. Manual payment tracking (record payments, query status)

### Phase 2 — E-Signature
1. PDF export and merge (pdf-lib)
2. Signature position detection (scan PDF for line pattern + signer label)
3. Autentique integration (document submission, signer notification via WhatsApp)
4. Signed PDF webhook (save signed bundle back to Drive)

### Phase 3 — WhatsApp Reminders
1. Meta WhatsApp Business Cloud API integration
2. Automatic payment reminders via pg_cron (configurable frequency per landlord)
3. Ad-hoc reminder from GPT
4. "Ver inadimplentes" with last reminder date

### Phase 4 — Pix Integration
1. Pix webhook integration (automatic payment detection via API Pix + PSP integration)
2. QR code generation per tenant/month for unambiguous payment matching

---

## Key Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Autentique API changes or downtime | Wrap in an adapter so the provider can be swapped; add retries |
| Signature position markers not found in PDF | Fall back to manual position specification; log failures for review |
| GPT sends incorrect values to the generation API | API validates all required placeholders are present before substituting |
| Landlord's Drive folder structure changes | Store folder IDs (not paths) — stable even if folders are renamed or moved |

---

## Prototype Gate

No high-risk assumptions require spiking before writing specs. The Autentique and Google Drive APIs are well-documented and used in production by other apps.
