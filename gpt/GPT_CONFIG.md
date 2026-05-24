# GPT Configuration — Lease Assistant

Copy these values into the OpenAI Custom GPT configuration panel.

---

## Name

Lease Assistant

## Description

Assistente de contratos de aluguel para proprietários. Gera contratos,
coordena assinaturas e acompanha pagamentos — tudo pelo chat.

## Instructions

Run the generation script to get the ready-to-upload prompt on your clipboard:

```bash
deno run --allow-read --allow-write --allow-run scripts/generate-system-prompt.ts
```

The script reads `gpt/config.yaml` (set `onboarding_url` to match your deployment),
substitutes `{SETUP_URL}` and `{PROMPT_VERSION}` in `gpt/SYSTEM_PROMPT.md`, validates
the 8 000-char limit, and copies the result to the clipboard. Paste into the Instructions
field. The generated file `gpt/SYSTEM_PROMPT.generated.md` is gitignored.

## Knowledge files

Upload `gpt/contract-rules.md` as a Knowledge file in the Custom GPT configuration panel (Knowledge → Upload files). The Instructions field references it by name (`contract-rules.md`); the GPT will retrieve the derivation and formatting rules from it at runtime. Re-upload the file whenever `gpt/contract-rules.md` changes.

## Conversation Starters

- Gerar contrato para um inquilino
- Ver quem está inadimplente este mês
- Enviar contrato para assinatura
- Escanear templates no Drive

## Capabilities

- [ ] Web Search — disabled
- [ ] Canvas — disabled
- [ ] Image Generation — disabled
- [ ] Code Interpreter & Data Analysis — disabled
- [x] Actions — enabled (upload `gpt/openapi.yaml` as the action schema)

> **Note:** `gpt/openapi.yaml` is the GPT-only subset. `specs/openapi.yaml` is the complete API spec — do not upload that one as it includes the Autentique webhook endpoint which is not GPT-callable and will cause a validation warning.

## Action Authentication

- Type: OAuth
- Client ID: (Google OAuth client ID from Google Cloud Console)
- Client Secret: (Google OAuth client secret)
- Authorization URL: `https://<your-domain>/functions/v1/oauth/authorize`
- Token URL: `https://<your-domain>/functions/v1/oauth/token`
- Scope: `openid email profile https://www.googleapis.com/auth/drive`
- Privacy Policy URL: `https://<project-ref>.supabase.co/storage/v1/object/public/legal/privacy-policy.html`

> **Note:** The Authorization URL and Token URL above are thin proxy endpoints
> hosted on the same domain as the API (`<your-domain>/functions/v1`). They
> forward requests to Google's real OAuth endpoints
> (`accounts.google.com/o/oauth2/v2/auth` and `oauth2.googleapis.com/token`).
> This setup only works when the Authorization URL, Token URL, and API server
> are all served from the same root domain in the GPT action config. For
> production, replace `<your-domain>` with your Supabase project URL
> (e.g. `https://<project-ref>.supabase.co`). For local development, use your
> ngrok URL. If the domain changes, update all three URLs together.

## Notes for developer

- After uploading `gpt/openapi.yaml` as the action schema, set the server URL to
  your Supabase project: `https://<project-ref>.supabase.co/functions/v1`
- The GPT is shared via a single link with all landlords — do not create separate
  GPTs per landlord
- The onboarding prompt must point users to `/setup` on the same action domain;
  do not depend on the model to infer a base URL at runtime
- Update the Instructions field whenever `gpt/SYSTEM_PROMPT.md` changes

### Local development

To point the GPT at your local Supabase instance during development:

1. Start ngrok: `ngrok http 54321 --domain <your-domain>.ngrok-free.dev`
2. Set the action server URL to: `https://<your-domain>.ngrok-free.dev/functions/v1`
3. Add a custom action header: `ngrok-skip-browser-warning: true`

Your ngrok dev domain is free and permanent (no URL changes between restarts).
See README.md → "Run Locally" for the full setup flow.
