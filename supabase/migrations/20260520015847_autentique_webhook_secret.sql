-- Per-landlord Autentique webhook Endpoint Secret
--
-- Each landlord has their own Autentique account and creates their own webhook
-- (Configurações → Webhooks → Novo Webhook). Autentique generates a unique
-- Endpoint Secret per webhook (shown once on creation) that is used to sign
-- payloads via HMAC-SHA256 in the `x-autentique-signature` header.
--
-- The global `AUTENTIQUE_WEBHOOK_SECRET` env var cannot scale across multiple
-- landlords — each landlord's webhook must be verified with its own secret.
--
-- See issue #49 and specs/SECURITY.md § "Spoofed Webhooks".

alter table landlords
  add column autentique_webhook_secret text not null default '';

-- Drop the default once the column exists — new rows must always provide a
-- value explicitly (validated by /setup/complete). Existing rows (if any in
-- a fresh install there are none) get the empty default, which fails HMAC
-- verification and therefore rejects all webhooks until updated.
alter table landlords
  alter column autentique_webhook_secret drop default;
