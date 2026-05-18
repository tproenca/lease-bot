# ADR-0002: One Shared Custom GPT for All Landlords
Date: 2026-05-18
Status: Accepted

## Context
The product uses a ChatGPT Custom GPT as the primary landlord interface. The question was whether each landlord should create and configure their own GPT (with a personalized system prompt), or whether the developer deploys one GPT shared by all landlords.

## Decision
Deploy one Custom GPT. All landlords use the same link. The system prompt is static. Landlord-specific context (properties, templates, placeholders, witnesses) is fetched dynamically from the API at the start of each conversation via `GET /context`. Authentication uses Custom GPT's native OAuth support.

## Alternatives Considered
- **One GPT per landlord:** Fully personalized system prompt, no API call needed for context. Rejected because: each landlord needs a ChatGPT Plus account, setup is manual per landlord, the developer cannot push updates, and it doesn't scale as a product.

## Consequences
- Developer controls the GPT — updates to behavior, instructions, and the OpenAPI action schema apply to all landlords instantly.
- `GET /context` is called at every conversation start — a fast, lightweight query.
- Landlords need a ChatGPT account (free tier supports Custom GPTs) but do not need to configure anything themselves.
- The system prompt must be written to work generically for any landlord, relying on the context payload for specifics.
