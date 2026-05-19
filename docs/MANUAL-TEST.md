# Manual Test — Lease Assistant
> Runbook: execute flows in order against a live GPT + local Supabase instance.

Each flow builds on the previous — run them sequentially in a single session.
Mark **Pass / Fail** in the verify tables as you go.

## Pre-requisites

### Accounts
- Google account (your own — will be the landlord)
- Autentique account → grab API key from Account → Integrações
- Meta WhatsApp Business account with a registered phone number ID and token (Flow 9 only)

### Google Drive setup
1. Create a folder: **"Lease Assistant"** → copy its ID from the URL (`/folders/<ID>`)
2. Inside it, create a subfolder: **"Modelos"**
3. Inside **"Modelos"**, create a Google Doc with the content from the [Template](#template) section at the bottom of this file

### Local backend
```sh
supabase start
ngrok http 54321 --domain <your-domain>.ngrok-free.dev
```

In the GPT action settings, set the server URL to:
`https://<your-domain>.ngrok-free.dev/functions/v1`

---

## Test data

Use these values throughout. They are fake but format-valid.

| Field | Value |
|---|---|
| Root folder ID | _(ID of "Lease Assistant" folder)_ |
| Templates folder | Modelos |
| Autentique API key | _(from autentique.com.br)_ |
| Landlord WhatsApp | +5511987654321 |
| Property name | Casa Flores |
| Property address | Rua das Flores, 42 - Vila Madalena, São Paulo - SP |
| Tenant name | João Silva |
| Tenant CPF | 123.456.789-09 |
| Tenant WhatsApp | +5511912345678 |
| Monthly rent | 2500 |
| Lease start | 01/06/2026 |
| Lease duration | 30 meses |

---

## Flow 1 — Onboarding

**Goal:** Connect Google account, wire Drive folders, set Autentique key and WhatsApp.

**Say:** `Olá`

GPT calls `GET /context`, finds no landlord profile, and starts setup.

**Expected prompts and your inputs:**

| GPT asks | You answer |
|---|---|
| ID da pasta raiz no Drive | _(root folder ID)_ |
| Nome da pasta de modelos | Modelos |
| Chave de API do Autentique | _(API key)_ |
| WhatsApp | +5511987654321 |

Confirm with: `Sim`

**Verify:**

| Check | Pass | Notes |
|---|---|---|
| GPT greets you by name | | |
| GPT calls `GET /templates/diff` and detects the template doc | | |
| GPT lists detected placeholders and asks to configure each one | | |

---

## Flow 2 — Template sync

**Goal:** Configure all placeholder metadata so the GPT knows how to fill them.

GPT will show each detected token and ask for format, case, and whether it's required.
Configure them as follows:

| Placeholder | Format | Case | Required |
|---|---|---|---|
| nome do locador | text | título | sim |
| nome do inquilino | text | título | sim |
| cpf do inquilino | cpf | — | sim |
| endereço do imóvel | text | título | sim |
| valor do aluguel | currency | — | sim |
| valor por extenso | text | frase | sim |
| prazo do contrato | integer | — | sim |
| data por extenso | text | frase | sim |
| data de término | date | — | sim |

When asked about witnesses ("Testemunha 1", "Testemunha 2"), provide a WhatsApp for each
(can be your own number for testing purposes).

Confirm each step with: `Sim`

**Verify:**

| Check | Pass | Notes |
|---|---|---|
| GPT confirms each placeholder/witness saved | | |
| Restart chat → `GET /templates/diff` reports no changes (fast path) | | |

---

## Flow 3 — Add a property

**Goal:** Create a house property. Drive folder should be created under the root.

**Say:** `Adicionar imóvel`

| GPT asks | You answer |
|---|---|
| Tipo | Casa |
| Nome | Casa Flores |
| Endereço | Rua das Flores, 42 - Vila Madalena, São Paulo - SP |

Confirm with: `Sim`

**Verify:**

| Check | Pass | Notes |
|---|---|---|
| GPT confirms creation with property ID | | |
| Drive "Lease Assistant" folder contains a "Casa Flores" subfolder | | |

---

## Flow 4 — Add a tenant

**Goal:** Add a tenant to Casa Flores. Tenant Drive folder created and starred.

**Say:** `Adicionar inquilino`

| GPT asks | You answer |
|---|---|
| Imóvel | Casa Flores |
| Nome | João Silva |
| CPF | 123.456.789-09 |
| WhatsApp | +5511912345678 |

Confirm with: `Sim`

**Verify:**

| Check | Pass | Notes |
|---|---|---|
| GPT confirms creation | | |
| Drive: inside "Casa Flores", a "João Silva" folder exists and is starred (★) | | |

---

## Flow 5 — Generate contract

**Goal:** Generate the lease contract with all placeholders substituted.

**Say:** `Gerar contrato`

| GPT asks | You answer |
|---|---|
| Inquilino | João Silva |
| Nome do locador | _(your name)_ |
| Endereço do imóvel | Rua das Flores, 42 - Vila Madalena, São Paulo - SP |
| Valor do aluguel | 2500 |
| Data de início | 01/06/2026 |
| Prazo | 30 |

GPT derives before calling the API:
- `data de término` → 30/11/2028
- `valor por extenso` → dois mil e quinhentos reais
- `data por extenso` → 01 de junho de 2026

GPT shows full summary. Confirm with: `Sim`

**Verify:**

| Check | Pass | Notes |
|---|---|---|
| GPT returns a Drive link to the generated document | | |
| Open the doc: all `{{tokens}}` replaced, none remaining | | |
| "João Silva" appears in título case | | |
| CPF formatted as 123.456.789-09 | | |
| "dois mil e quinhentos reais" appears where `{{valor por extenso}}` was | | |

---

## Flow 6 — Record a payment (on time)

**Goal:** Record an on-time payment. Tenant should NOT appear as overdue.

**Say:** `Registrar pagamento`

| GPT asks | You answer |
|---|---|
| Inquilino | João Silva |
| Valor | 2500 |
| Mês de referência | 2026-06 |
| Data do pagamento | 2026-06-03 |

Confirm with: `Sim`

**Verify:**

| Check | Pass | Notes |
|---|---|---|
| GPT confirms payment recorded | | |
| Say: `Ver inadimplentes em junho de 2026` → João Silva does NOT appear | | |

---

## Flow 7 — View defaulters

**Goal:** Confirm overdue detection for a month with no payment.

**Say:** `Ver inadimplentes em julho de 2026`

**Verify:**

| Check | Pass | Notes |
|---|---|---|
| João Silva appears as overdue for July 2026 | | |
| GPT offers to send a WhatsApp reminder | | |

Say `Não` to skip the reminder for now — tested in Flow 9.

---

## Flow 8 — Signing (requires live Autentique account)

**Goal:** Send the generated contract for signing.

**Say:** `Enviar para assinatura`

| GPT asks | You answer |
|---|---|
| Inquilino | João Silva |

GPT lists signatories (tenant + landlord + witnesses) and their WhatsApp numbers.
Confirm with: `Sim`

**Verify:**

| Check | Pass | Notes |
|---|---|---|
| GPT confirms sent | | |
| Autentique dashboard shows a new document pending signature | | |
| After signing in Autentique: signed PDF appears in João Silva's Drive folder | | |

> If you don't want to sign for real, stop after confirming the send and verify
> the Autentique dashboard shows the pending document.

---

## Flow 9 — Ad-hoc payment reminder (requires Meta WhatsApp credentials)

**Goal:** Send a manual WhatsApp reminder for an overdue tenant.

**Pre-condition:** `META_WHATSAPP_TOKEN` and `META_WHATSAPP_PHONE_ID` set in your local `.env`.
João Silva is overdue for July 2026 (from Flow 7).

**Say:** `Enviar lembrete de pagamento para João Silva de julho de 2026`

**Verify:**

| Check | Pass | Notes |
|---|---|---|
| GPT confirms reminder sent | | |
| João Silva's WhatsApp receives the message | | |
| Say: `Ver inadimplentes em julho de 2026` → `last_reminder_sent_at` is populated | | |
| Sending again for the same month records a second entry (no dedup on ad-hoc) | | |

---

## Flow 10 — Reminder frequency configuration

**Goal:** Update the landlord's reminder frequency and confirm it's reflected in context.

**Say:** `Alterar frequência de lembretes para semanal`

**Verify:**

| Check | Pass | Notes |
|---|---|---|
| GPT confirms frequency updated to `weekly` | | |
| Say: `Ver configurações` → context shows `payment_reminder_frequency: weekly` | | |

---

## What is NOT tested here

These flows require infrastructure not available locally:

- Automatic payment reminders via pg_cron (requires a live Supabase deployment with pg_cron enabled)
- Webhook idempotency: duplicate Autentique webhook processed only once

---

## Session log

| Date | Tester | Flows run | Result | Notes |
|---|---|---|---|---|
| | | | | |

---

## Template

Create a new Google Doc in your "Modelos" folder and paste the content below exactly as-is.
The `{{tokens}}` are detected automatically by the GPT via `GET /templates/diff`.

```
CONTRATO DE LOCAÇÃO RESIDENCIAL

LOCADOR: {{nome do locador}}

LOCATÁRIO: {{nome do inquilino}}, inscrito no CPF sob o nº {{cpf do inquilino}},
doravante denominado LOCATÁRIO.

IMÓVEL: {{endereço do imóvel}}

VALOR DO ALUGUEL: R$ {{valor do aluguel}} ({{valor por extenso}})

VIGÊNCIA: {{prazo do contrato}} meses, com início em {{data por extenso}},
com término previsto para {{data de término}}.

DISPOSIÇÕES GERAIS

1. O aluguel deverá ser pago até o 5º dia útil de cada mês.
2. O imóvel destina-se exclusivamente a uso residencial.
3. É vedada a sublocação total ou parcial sem autorização prévia por escrito do LOCADOR.
4. O LOCATÁRIO declara ter vistoriado o imóvel e o aceita nas condições em que se encontra.
5. Ao término do contrato, o imóvel deverá ser entregue nas mesmas condições de entrada.

E por estarem justos e contratados, as partes assinam o presente instrumento.

São Paulo, {{data por extenso}}.


{{nome do locador}}
_________________________________
Locador


{{nome do inquilino}}
_________________________________
Locatário


_________________________________
Testemunha 1


_________________________________
Testemunha 2
```

### Placeholder reference

| Token | Format | Case | Required | Derived? |
|---|---|---|---|---|
| `{{nome do locador}}` | text | título | sim | no |
| `{{nome do inquilino}}` | text | título | sim | no |
| `{{cpf do inquilino}}` | cpf | — | sim | no |
| `{{endereço do imóvel}}` | text | título | sim | no |
| `{{valor do aluguel}}` | currency | — | sim | no |
| `{{valor por extenso}}` | text | frase | sim | derived from `valor do aluguel` |
| `{{prazo do contrato}}` | integer | — | sim | no |
| `{{data por extenso}}` | text | frase | sim | derived from `data de início` |
| `{{data de término}}` | date | — | sim | derived: `data de início` + `prazo do contrato` months |

`data de início` is collected by the GPT but not injected into the template directly —
it drives `data por extenso` and `data de término`.

The two `_________________________________` lines before "Testemunha 1" and "Testemunha 2"
trigger automatic witness detection in `GET /templates/diff`.
