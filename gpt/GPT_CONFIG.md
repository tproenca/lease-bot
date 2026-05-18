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

## Notes for developer

- After uploading `specs/openapi.yaml` as the action schema, set the server URL to
  your Supabase project: `https://<project-ref>.supabase.co/functions/v1`
- The GPT is shared via a single link with all landlords — do not create separate
  GPTs per landlord
- Update the Instructions field whenever `gpt/SYSTEM_PROMPT.md` changes
