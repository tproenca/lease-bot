# CLAUDE.md — Lease Assistant

See [AGENTS.md](AGENTS.md) for all project rules: setup, repo layout, testing, deployment, branching, commit format, and agent workflow guidelines.

## Shortcuts

| Phrase | Action |
|---|---|
| `gen prompt` | Run `deno run --allow-read --allow-write --allow-run scripts/generate-system-prompt.ts` and report the char count and clipboard status |
| `s-check` | Run `ls -lt ~/Desktop/Screenshot*.png`, read only screenshots newer than the last tracked one (stored in memory), report findings, update the tracker |
| `gen doc sample` | Run `deno run --allow-read --allow-write scripts/generate-shared.ts` to regenerate `supabase/functions/_shared/sample-contract-content.ts` from `docs/sample-contract.md` |
| `gpt:c-prompt` | Read Prompt 1 from `gpt/WORKFLOW.md` and execute it: rewrite `gpt/SYSTEM_PROMPT.md` from scratch based on source docs, then run `gen prompt` |
| `gpt:r-prompt` | Run `s-check` to read the latest screenshot(s), use them to fill the failure fields of Prompt 2 from `gpt/WORKFLOW.md` (WHAT THE GPT DID = screenshot content; ask the user for WHAT IT SHOULD HAVE DONE if not obvious), then execute Prompt 2 — fix source docs, update `SYSTEM_PROMPT.md`, run `gen prompt`. Always check `docs/GPT-BEHAVIOR.md`, `docs/GPT-FLOWS.md`, and `gpt/WORKFLOW.md` |
