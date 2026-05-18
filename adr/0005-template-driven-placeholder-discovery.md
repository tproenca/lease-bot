# ADR-0005: Template-Driven Placeholder Discovery
Date: 2026-05-18
Status: Accepted

## Context
The system needs to know which placeholders exist, their definitions (format, required, derived formula, case), and which templates use them. This schema could be defined upfront by the developer, defined by the landlord in a config file, or discovered dynamically from the templates themselves.

## Decision
Placeholders are discovered by scanning Google Docs templates for `{{name}}` patterns. Definitions (format, required, case, derived formula) are stored in the database per landlord, shared across all templates that use the same name. The GPT detects template changes via `GET /templates/diff` (comparing Drive `modifiedTime` against the DB) and asks the landlord to define new placeholders or confirm removals conversationally.

A reference document (`Guia de Placeholders`) is auto-generated in the Templates folder and updated whenever placeholders change, giving landlords a reference while editing templates in Drive.

## Alternatives Considered
- **Developer-defined schema (hardcoded):** Simple but requires a code deploy every time a landlord adds a new field to their template. Rejected.
- **Config file in Drive (e.g. `placeholders.json`):** Landlord-editable without developer involvement, but non-technical landlords are unlikely to edit JSON correctly. Rejected.
- **GPT system prompt as schema:** Requires manually updating the GPT config per landlord. Rejected after deciding on a single shared GPT (ADR-0002).

## Consequences
- Landlords can add new placeholders by simply adding `{{new field}}` to their template — the system detects and prompts for the definition automatically.
- Placeholder definitions are shared across templates — one definition for `{{nome do inquilino}}` regardless of how many templates use it.
- `GET /templates/diff` has a fast path (all `modifiedTime` values match) and a slow path (re-reads changed templates from Drive). Unchanged templates contribute their placeholder names from the DB cache.
- The `Guia de Placeholders` doc must be excluded from template scanning (matched by fixed name).
