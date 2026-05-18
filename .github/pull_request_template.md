## Summary

<!-- What does this PR do? 1-3 bullets. -->

## Closes

Fixes #

## Test plan

- [ ] Tier 1 tests pass (`deno test --allow-all supabase/functions/ --filter "unit|integration"`)
- [ ] Tier 2 smoke tests pass (`deno test --allow-all supabase/functions/ --filter "e2e:smoke"`)
- [ ] No debug code or hardcoded secrets
- [ ] CHANGELOG.md updated under `## Unreleased`

## Security checklist

- [ ] All DB queries use parameterized queries — no raw SQL string concatenation
- [ ] `landlord_id` is sourced from the verified JWT, never from the request body
- [ ] No PII logged or echoed in error responses
- [ ] New migrations are forward-only (no destructive DROP/ALTER without compensating migration)
