# ADR-0006: Autentique for E-Signatures
Date: 2026-05-18
Status: Accepted

## Context
The signing flow requires a Brazilian e-signature platform that is legally valid under Brazilian law (MP 2.200-2/2001 and Lei 14.063/2020) and can notify signers via WhatsApp.

## Decision
Use Autentique as the e-signature provider. Documents are submitted via Autentique's GraphQL API with `DELIVERY_METHOD_WHATSAPP`. Signing reminders are configured as `DAILY` or `WEEKLY` at document creation. Signed documents are delivered back via HMAC-SHA256-verified webhooks.

## Alternatives Considered
- **DocuSign:** Globally recognized but expensive, no native WhatsApp delivery, not optimized for the Brazilian market.
- **D4Sign:** Brazilian platform, legally valid, but less developer-friendly API and no native WhatsApp delivery.
- **ClickSign:** Brazilian platform with good API, but WhatsApp delivery requires an additional integration. Higher per-signature cost.

## Consequences
- Each landlord creates their own Autentique account using their Google account (same identity used for Drive). Their API key is stored per-landlord in `landlords.autentique_api_key` (encrypted via Supabase Vault) — not a shared developer credential.
- Signed documents are owned by the landlord's Autentique account; they can view signing history directly on autentique.com.br independent of this system.
- Native WhatsApp delivery eliminates the need for a separate WhatsApp API for signing notifications.
- Autentique's HMAC-SHA256 webhook verification (`x-autentique-signature` header) provides strong webhook authenticity guarantees. The webhook secret remains a single global environment variable — all landlords configure the same webhook URL and secret in their Autentique account.
- Autentique charges per signature via WhatsApp (~$0.02/signer). At this scale, cost is negligible.
- Wrapped in an adapter interface so the provider can be swapped without touching business logic if needed.
- Autentique is signing-only — no standalone WhatsApp messaging API, so payment reminders require a separate service (see ADR-0007).
