#!/usr/bin/env bash
# Fast tests for pure functions and fully mocked handlers.
set -euo pipefail

FILTER="/unit:/"

TEST_FILES=()
while IFS= read -r file; do
  TEST_FILES+=("$file")
done < <(
  find supabase/functions -name '*.test.ts' \
    ! -name '*.integration.test.ts' \
    ! -path 'supabase/functions/e2e/*' \
    -type f | sort
)
if [[ "${#TEST_FILES[@]}" -eq 0 ]]; then
  echo "ERROR: no unit test files found." >&2
  exit 1
fi

echo "==> Unit tests"
OUTPUT="$(deno test --allow-all "${TEST_FILES[@]}" --filter "$FILTER" 2>&1)" || {
  printf '%s\n' "$OUTPUT"
  exit 1
}
printf '%s\n' "$OUTPUT"

if grep -Eq "ok \| 0 passed \| 0 failed" <<<"$OUTPUT"; then
  echo "ERROR: unit test filter matched zero tests. Check test names or filter ${FILTER}." >&2
  exit 1
fi

echo "==> test-unit.sh passed"
