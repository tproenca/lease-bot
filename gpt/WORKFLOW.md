# GPT Development Workflow

Practical guide for regenerating, iterating, and debugging the Lease Assistant system prompt.

Source of truth:
- `docs/GPT-BEHAVIOR.md` — identity, general behavior, error handling, restrictions
- `docs/GPT-FLOWS.md` — every conversation flow (initialization, contract, signature, payment…)
- `gpt/contract-rules.md` — placeholder derivation and formatting rules (uploaded as a Knowledge file)
- `gpt/config.yaml` — constants: `prompt_version`, `onboarding_url`, `max_chars`

**Never edit `gpt/SYSTEM_PROMPT.md` directly.** Edit the source docs, then regenerate.

---

## Platform constraints (read before editing the prompt)

These are hard limits enforced by ChatGPT. Violating them causes silent failures or upload errors.

Reference docs (require OpenAI login — read manually before a full regeneration):
- https://help.openai.com/en/articles/8554397-creating-and-editing-gpts
- https://help.openai.com/en/articles/9442513-configuring-actions-in-gpts

### Instructions field
- **8 000 character hard limit.** The UI silently truncates anything above it — the GPT receives an incomplete prompt with no warning.
- Markdown is not rendered visually in the Instructions editor, but the model does use headers and bold as structural cues. Keep markdown formatting — it helps the model parse sections. Just don't write it for human readability.
- Knowledge files are NOT automatically injected into context. The model retrieves them on demand when it judges them relevant. Critical rules must be in the Instructions field, not only in a Knowledge file.

### Knowledge files
- Max 20 files per GPT.
- Files are retrieved by semantic search — exact lookup is not guaranteed. Do not rely on a Knowledge file for step-by-step instructions the GPT must always follow.
- `gpt/contract-rules.md` is uploaded as a Knowledge file. The Instructions field references it by name so the model knows to retrieve it during contract generation.

### Actions — OpenAPI schema
- Max **300 characters** per endpoint `description` or `summary` field.
- Max **700 characters** per parameter `description` field.
- Request and response payloads must be under **100 000 characters** each.
- Schema must be valid OpenAPI 3.x (JSON or YAML).

### Actions — OAuth
- Both callback URLs must be registered in the OAuth app:
  - `https://chat.openai.com/aip/{g-GPT-ID}/oauth/callback`
  - `https://chatgpt.com/aip/{g-GPT-ID}/oauth/callback`
- The `state` parameter is mandatory — OpenAI enforces it.
- **Domain constraint:** authorization URL, token URL, and the action API server must share the same root domain. Exceptions: Google, Microsoft, Adobe. This is why the OAuth proxy endpoints live under the same ngrok/Supabase domain as the API.
- The token response must include `access_token`, `token_type`, `refresh_token`, `expires_in`.

---

## 1 — Regenerate SYSTEM_PROMPT.md from scratch

Use this prompt when the source docs have been significantly updated or the prompt needs to be rebuilt.

```
Read gpt/WORKFLOW.md (Platform constraints section), docs/GPT-BEHAVIOR.md,
docs/GPT-FLOWS.md, and gpt/contract-rules.md.

Rewrite gpt/SYSTEM_PROMPT.md from scratch following these rules:

STRUCTURE
- The very first section must be the initialization block titled
  "## OBRIGATÓRIO — Chame getContext antes de qualquer resposta".
  It must instruct the GPT to call getContext before any greeting, menu, or
  reply — including "oi", "olá", and any other opener. No exceptions.
- All other sections follow after the initialization block.

CONTENT
- Implement every flow from GPT-FLOWS.md as numbered, actionable instructions.
  Do not summarize — each step the GPT must take must be explicit.
- Apply all general behavior rules from GPT-BEHAVIOR.md.
- For contract generation, reference contract-rules.md by name (do not inline
  the derivation rules — the file is uploaded as a GPT Knowledge file).
- Use {SETUP_URL} as a placeholder wherever the setup URL appears (never
  hardcode a URL). Add "v{PROMPT_VERSION}" as the very first line of the file.

LANGUAGE AND STYLE
- All instructions are in Brazilian Portuguese (pt-BR).
- Be direct. Avoid filler phrases. Every sentence must tell the GPT what to do.

CONSTRAINTS (from platform docs)
- Hard limit: 8000 characters after placeholder substitution. The UI silently
  truncates above this — an incomplete prompt causes wrong behavior with no error.
- Knowledge files are not auto-injected. Any rule the GPT must always follow
  must be in the Instructions field, not only in a Knowledge file.
- After writing, run `gen prompt` to validate char count and copy to clipboard.
  If over limit, trim redundant wording — never drop a required flow step.
```

---

## 2 — Iteration workflow

Use this cycle every time behavior in ChatGPT is wrong.

```
Step 1 — Observe
  Run the failing scenario in ChatGPT. Write down exactly:
  - What you said
  - What the GPT did
  - What it should have done instead

Step 2 — Classify
  Wrong or missing flow step      → fix docs/GPT-FLOWS.md
  Wrong identity or tone          → fix docs/GPT-BEHAVIOR.md
  Wrong error message             → fix docs/GPT-BEHAVIOR.md (Error Handling section)
  Wrong contract field value      → fix gpt/contract-rules.md
  Initialization not called first → fix docs/GPT-BEHAVIOR.md (General Behavior) and
                                    regenerate — never edit SYSTEM_PROMPT.md directly
  Action not being called         → make the trigger more explicit in docs/GPT-FLOWS.md

Step 3 — Fix the source doc
  Make the minimal change that addresses the observed failure.
  One failure → one fix. Do not refactor unrelated sections.

Step 4 — Regenerate
  gen prompt
  Check the char count. If over 8000, trim from the section you just edited.

Step 5 — Increment version
  Bump prompt_version in gpt/config.yaml.

Step 6 — Upload and retest
  Paste the clipboard contents into the ChatGPT Instructions field.
  Click Update (top-right) — the prompt is not live until you do.
  Test in the Preview panel first before sharing the link.
  Rerun the exact scenario that failed. Then test the adjacent flows to
  check for regressions.

Step 7 — Repeat from Step 1 if still wrong.
```

---

## 3 — Fix a specific wrong interaction

Use this prompt when you have a concrete failure to diagnose and fix. Fill in the
bracketed fields from the ChatGPT session before running it.

```
The GPT did something wrong. Here is the failure:

WHAT I SAID
[paste your exact message to the GPT]

WHAT THE GPT DID
[paste the GPT's response]

WHAT IT SHOULD HAVE DONE
[describe the correct behavior]

WHICH FLOW WAS INVOLVED
[e.g. Flow 2 — Send for Signature, or Flow 1 — Initialization]

---

Read gpt/WORKFLOW.md (Platform constraints section), docs/GPT-FLOWS.md,
and docs/GPT-BEHAVIOR.md.

1. Identify the exact rule or flow step that caused this failure.
2. Fix the relevant source doc (GPT-FLOWS.md or GPT-BEHAVIOR.md). Make the
   smallest change that prevents this failure without breaking adjacent flows.
3. Run `gen prompt`. If over 8000 chars, trim from the section you just edited.
4. Confirm what was changed and why.
```
