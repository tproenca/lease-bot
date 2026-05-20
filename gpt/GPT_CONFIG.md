# GPT Configuration — Lease Assistant

Copy these values into the OpenAI Custom GPT configuration panel.

---

## Name

Lease Assistant

## Description

Assistente de contratos de aluguel para proprietários brasileiros. Gera contratos,
coordena assinaturas e acompanha pagamentos — tudo pelo chat.

## Instructions

See `SYSTEM_PROMPT.md` — paste the full contents into the Instructions field.

## Knowledge files

Upload `gpt/contract-rules.md` as a Knowledge file in the Custom GPT configuration panel (Knowledge → Upload files). The Instructions field references it by name (`contract-rules.md`); the GPT will retrieve the derivation and formatting rules from it at runtime. Re-upload the file whenever `gpt/contract-rules.md` changes.

## Conversation Starters

- Gerar contrato para um inquilino
- Ver quem está inadimplente este mês
- Enviar contrato para assinatura
- Escanear templates no Drive

## Capabilities

- [ ] Web Search — disabled
- [ ] Code Interpreter — disabled
- [x] Actions — enabled (upload `specs/openapi.yaml` as the action schema)

## Action Authentication

- Type: OAuth
- Client ID: (Google OAuth client ID from Google Cloud Console)
- Client Secret: (Google OAuth client secret)
- Authorization URL: `https://accounts.google.com/o/oauth2/v2/auth`
- Token URL: `https://oauth2.googleapis.com/token`
- Scope: `openid email profile https://www.googleapis.com/auth/drive`
- Privacy Policy URL: `https://<project-ref>.supabase.co/storage/v1/object/public/legal/privacy-policy.html`

## Notes for developer

- After uploading `specs/openapi.yaml` as the action schema, set the server URL to
  your Supabase project: `https://<project-ref>.supabase.co/functions/v1`
- The GPT is shared via a single link with all landlords — do not create separate
  GPTs per landlord
- Update the Instructions field whenever `gpt/SYSTEM_PROMPT.md` changes

### Local development

To point the GPT at your local Supabase instance during development:

1. Start ngrok: `ngrok http 54321 --domain <your-domain>.ngrok-free.dev`
2. Set the action server URL to: `https://<your-domain>.ngrok-free.dev/functions/v1`
3. Add a custom action header: `ngrok-skip-browser-warning: true`

Your ngrok dev domain is free and permanent (no URL changes between restarts).
See README.md → "Run Locally" for the full setup flow.
