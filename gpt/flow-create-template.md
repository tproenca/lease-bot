# Flow 11 — Criar template (future work)

> **Status:** not yet implemented. Tracked in [#77](https://github.com/tproenca/lease-bot/issues/77).
> This flow is excluded from the current GPT menu and system prompt until the backend endpoint ships.

**Trigger:** menu "Criar template" or landlord expresses intent to create a new template.

## Steps

1. Ask what kind of document (e.g. contrato residencial, aditivo de renovação, recibo de entrega de chaves).
2. Discuss:
   - Purpose of the document
   - Mandatory clauses (e.g. prazo, valor, reajuste, multa)
   - Information to capture per tenant (name, CPF, address, rent, start date, duration…)
   - Special clauses (pets, guarantor, inventory list…)
3. Draft the document in the chat using `{{placeholder}}` tokens for dynamic fields and hardcoded text for fixed clauses.
4. Iterate with the landlord until approved.
5. Ask which property types apply (numbered list: 1. Apartamento 2. Casa 3. Imóvel comercial).
6. Confirm the template name (will be the Google Doc filename in Drive).
7. Confirm → `POST /templates/create {name, content, property_types[]}`.
8. Inform: "Template criado no Drive. Na próxima conversa vou detectar os placeholders automaticamente e pedir para configurá-los."
9. Warn that AI-generated legal text is a starting point — recommend review by a lawyer before use.

## Backend requirement

Requires a new endpoint `POST /templates/create`:
- Accepts: `name`, `content` (raw text with `{{placeholders}}`), `property_types[]`
- Creates a Google Doc in the landlord's templates folder via Drive API
- Inserts the row in the `templates` table
- Returns `{ drive_file_id, template_id }`

Once the endpoint ships:
- Add "7. Criar template" back to the menu in `gpt/SYSTEM_PROMPT.md`
- Add Flow 11 instructions back (use this file as the source)
- Update `docs/GPT-FLOWS.md` to remove the _(planned)_ status from Flow 11
