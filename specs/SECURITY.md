# Security — Lease Assistant

## Threat Model (OWASP Top 10 + Project-Specific)

### Broken Access Control
**Risk:** Landlord A accesses landlord B's data (properties, tenants, documents).

**Mitigation:**
- Every Edge Function extracts `landlord_id` from the verified JWT — never from the request body or query params
- All DB queries include `WHERE landlord_id = $jwt_landlord_id`
- Supabase Row Level Security (RLS) enabled on all tables as a second line of defense

### Injection
**Risk:** SQL injection via API inputs; template placeholder injection if document content is eval'd.

**Mitigation:**
- All DB queries use Supabase's parameterized query interface — no raw SQL string concatenation
- The substitution engine performs string replacement only (`str.replace(placeholder, value)`) — never eval or dynamic code execution
- Placeholder names are validated against the `placeholders` table before substitution; unknown keys are rejected

### Sensitive Data Exposure
**Risk:** Tenant CPF, WhatsApp numbers, and Google refresh tokens exposed in logs or error responses.

**Mitigation:**
- PII fields (CPF, WhatsApp) are never included in log output
- Error responses never echo back raw input values
- Google OAuth refresh tokens and Autentique API keys: Vault encryption is deferred (see ADR-0010); both columns are protected by infrastructure-level AES-256 encryption and are inaccessible to landlord JWTs via RLS
- Environment variables hold all remaining secrets (webhook secret, Meta WhatsApp token, Supabase service key) — never hardcoded

### Broken Authentication
**Risk:** Forged or expired JWTs used to access the API.

**Mitigation:**
- All Edge Functions verify the JWT using Supabase Auth before processing any request
- JWTs are short-lived; Supabase Auth handles refresh
- The Custom GPT uses OAuth — tokens are issued and rotated by the OAuth flow

### Spoofed Webhooks
**Risk:** Attacker sends a fake Autentique webhook to `POST /webhooks/autentique`, triggering a fraudulent signed PDF save.

**Mitigation:**
- Verify `x-autentique-signature` header on every incoming webhook
- Signature: `HMAC-SHA256(raw_request_body, AUTENTIQUE_WEBHOOK_SECRET)`
- Use timing-safe comparison (`crypto.timingSafeEqual`) to prevent timing attacks
- Reject any webhook where signature verification fails with `401`
- `AUTENTIQUE_WEBHOOK_SECRET` stored as an Edge Function environment variable

### Drive Token Exposure
**Risk:** Google OAuth refresh token stolen from the database gives attacker full Drive access for a landlord.

**Mitigation:**
- Refresh tokens stored in `landlords.google_refresh_token` (plain text column). **Vault encryption is deferred — see ADR-0010.** Interim mitigations: Supabase PostgreSQL storage is AES-256 encrypted at rest at the infrastructure level; RLS prevents any landlord JWT from reading the column; the value is never logged or included in error responses.
- RLS ensures refresh tokens are only readable by the service role, not by the landlord's own JWT
- If a token is suspected compromised, the landlord can revoke it via Google Account settings

### Insecure Direct Object References
**Risk:** API caller passes a `tenant_id` or `property_id` belonging to another landlord.

**Mitigation:**
- Before any operation on a resource, verify `resource.landlord_id = jwt_landlord_id`
- This check is enforced both in Edge Function logic and via RLS policies

### Rate Limiting
**Risk:** GPT action or webhook endpoint flooded with requests.

**Mitigation:**
- Supabase Edge Functions have built-in rate limiting at the platform level
- Webhook endpoints return `200` immediately and process asynchronously where possible to reduce amplification risk
- At this scale (~10 landlords), additional rate limiting is not required in Phase 1

---

## Authentication and Authorization

| Actor | Auth mechanism | Access |
|-------|---------------|--------|
| Landlord (via GPT) | Google OAuth → Supabase JWT | Own data only (RLS enforced) |
| Autentique webhook | HMAC-SHA256 signature verification | `POST /webhooks/autentique` only |
| pg_cron | Supabase service role (internal) | Payment reminder job only |
| Tenant | None | No login; receives WhatsApp messages only |

---

## Approved Service-Role Key Usage in Edge Functions

The Supabase service-role key bypasses Row Level Security and must only be used
in narrowly justified cases. Every approved usage is listed here.

| Endpoint | Reason | Scope |
|----------|--------|-------|
| `POST /setup/complete` | Initial insert of the `landlords` row. RLS cannot grant the insert because the row does not yet exist — `auth.uid()` has no matching `landlord_id` to satisfy `id = auth.uid()`. The Edge Function binds `id = user.id` from the verified JWT, so the new row is owned by the authenticated user from that point on. | Single `INSERT` into `landlords`; followed by a `SELECT` on the same row only in the idempotent retry branch. |
| `GET /setup` (post-auth state check) | Checking whether the landlord row exists before the row is created. Same rationale as above — RLS returns no row for an unauthenticated landlord, so the service role is used to determine which page state to render. | Single `SELECT id, templates_folder_id FROM landlords WHERE id = $user_id`. |
| `GET /auth/callback` (refresh-token persist) | Storing the Google refresh token in auth user metadata via `auth.admin.updateUserById`. Supabase's admin API requires the service role. | Single `updateUserById` targeting only the authenticated user's record. |

---

## Data Privacy and PII Handling

**PII in this system:**
- Landlord: email, name, WhatsApp, Google refresh token
- Tenant: name, CPF, WhatsApp
- Witness: name, WhatsApp

**Rules:**
- PII is never logged (Edge Function logs must exclude request bodies for PII endpoints)
- PII is never included in error responses returned to the GPT
- CPF is stored as plain text (required for document generation); no masking in DB
- Tenant WhatsApp is used only for signing notifications (via Autentique) and payment reminders (via Meta WhatsApp API) — never shared with third parties beyond these two integrations
- All data is stored in Supabase (sa-east-1 — São Paulo), keeping data residency in Brazil

**Data retention:** no explicit retention policy in Phase 1. Landlord can delete tenants and payments manually via GPT. Full account deletion is a manual operation by the developer.

---

## Input Validation

| Endpoint | Validation |
|----------|-----------|
| All endpoints | JWT verified before any processing |
| `POST /tenants` | CPF format validated (XXX.XXX.XXX-XX); WhatsApp validated as E.164 Brazilian number |
| `POST /payments` | `reference_month` must be a valid date; `amount` must be positive |
| `POST /documents/generate` | All `required: true` placeholders must be present in payload; unknown placeholder keys rejected |
| `POST /webhooks/autentique` | HMAC signature verified before any payload processing |
| `POST /setup/complete` | `root_folder_id` verified to exist in landlord's Drive before storing; `autentique_api_key` validated against Autentique API (test call) before storing |

---

## Security Assumptions and Non-Goals

**Assumptions:**
- Supabase handles encryption at rest and TLS in transit for all DB connections
- OpenAI's Custom GPT platform securely stores and transmits the landlord's OAuth token
- Google OAuth is the trust anchor — account compromise at Google level is out of scope

**Non-goals:**
- Tenant authentication — tenants are not users of this system
- End-to-end encryption of documents — Google Drive's built-in encryption is sufficient
- Audit logging — not required at this scale in Phase 1
- GDPR compliance — Brazil-only product; governed by LGPD; full LGPD compliance deferred to a later phase
