#!/usr/bin/env bash
# Broad, shallow critical-path tests for PR CI.
set -euo pipefail

FILTER="/e2e:smoke:/"

TEST_FILES=()
while IFS= read -r file; do
  TEST_FILES+=("$file")
done < <(
  find supabase/functions/e2e -name '*.test.ts' -type f | sort
)
if [[ "${#TEST_FILES[@]}" -eq 0 ]]; then
  echo "ERROR: no e2e smoke test files found." >&2
  exit 1
fi

if ! supabase status &>/dev/null; then
  echo "ERROR: local Supabase is not running. Run: supabase start" >&2
  exit 1
fi

eval "$(supabase status --output env | grep -E '^(API_URL|ANON_KEY|SERVICE_ROLE_KEY)=')"
export SUPABASE_URL="$API_URL"
export SUPABASE_ANON_KEY="$ANON_KEY"
export SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY"

echo "==> E2E smoke tests"
OUTPUT="$(deno test --allow-all "${TEST_FILES[@]}" --filter "$FILTER" 2>&1)" || {
  printf '%s\n' "$OUTPUT"
  exit 1
}
printf '%s\n' "$OUTPUT"

if grep -Eq "ok \| 0 passed \| 0 failed" <<<"$OUTPUT"; then
  echo "ERROR: e2e smoke test filter matched zero tests. Check test names or filter ${FILTER}." >&2
  exit 1
fi

echo "==> test-smoke.sh passed"
