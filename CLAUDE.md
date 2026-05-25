# CLAUDE.md — Lease Assistant

See [AGENTS.md](AGENTS.md) for all project rules: setup, repo layout, testing, deployment, branching, commit format, and agent workflow guidelines.

## Shortcuts

| Phrase | Action |
|---|---|
| `gen prompt` | Run `deno run --allow-read --allow-write --allow-run scripts/generate-system-prompt.ts` and report the char count and clipboard status |
| `s-check` | Run `ls -lt ~/Desktop/Screenshot*.png`, read only screenshots newer than the last tracked one (stored in memory), report findings, update the tracker |
