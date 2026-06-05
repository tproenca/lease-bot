# ADR-0007: Meta WhatsApp Business Cloud API for Payment Reminders
Date: 2026-05-18
Status: Accepted

## Context
Payment reminders need to be sent to tenants via WhatsApp. Autentique's WhatsApp is signing-only — it cannot send standalone messages. A separate WhatsApp API is required for payment reminders.

## Decision
Use the official Meta WhatsApp Business Cloud API. Free tier covers 1,000 service conversations per month, which is sufficient for ~10 landlords and ~100 tenants. Tenants receive messages on their regular WhatsApp — no special app or account needed on their end.

## Alternatives Considered
- **Z-API (Brazilian unofficial provider):** Simple setup, flat monthly fee (~R$150-200), no per-message cost. Rejected because it connects a regular WhatsApp account and violates WhatsApp's Terms of Service — risk of phone number being banned in a production system.
- **Evolution API (open source, self-hosted):** Free but requires hosting and carries the same ToS risk as Z-API.
- **Twilio WhatsApp:** Uses Meta's official API as a BSP. More expensive than direct Meta integration with no added benefit at this scale.

## Consequences
- Official API — no ToS risk, no ban risk.
- Free tier (1,000 conversations/month) covers this project comfortably.
- Proactive messages (payment reminders) require pre-approved message templates submitted to Meta before launch.
- Requires a Meta Business account and phone number verification — one-time setup by the developer.
- Meta WhatsApp token stored as a Supabase Edge Function secret.
