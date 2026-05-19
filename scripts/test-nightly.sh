#!/usr/bin/env bash
# Full regression suite + coverage check. Run nightly on main or manually.
set -euo pipefail

COVERAGE_THRESHOLD=80
COVERAGE_DIR="coverage"
REGRESSION_FILTER="/e2e:regression:/"

UNIT_FILES=()
while IFS= read -r file; do
  UNIT_FILES+=("$file")
done < <(
  find supabase/functions -name '*.test.ts' \
    ! -name '*.integration.test.ts' \
    ! -path 'supabase/functions/e2e/*' \
    -type f | sort
)

INTEGRATION_FILES=()
while IFS= read -r file; do
  INTEGRATION_FILES+=("$file")
done < <(
  find supabase/functions -name '*.integration.test.ts' -type f | sort
)

E2E_FILES=()
while IFS= read -r file; do
  E2E_FILES+=("$file")
done < <(
  find supabase/functions/e2e -name '*.test.ts' -type f | sort
)
if [[ "${#UNIT_FILES[@]}" -eq 0 ]]; then
  echo "ERROR: no unit test files found." >&2
  exit 1
fi
if [[ "${#INTEGRATION_FILES[@]}" -eq 0 ]]; then
  echo "ERROR: no integration test files found." >&2
  exit 1
fi
if [[ "${#E2E_FILES[@]}" -eq 0 ]]; then
  echo "ERROR: no e2e test files found." >&2
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

rm -rf "$COVERAGE_DIR"

echo "==> E2E regression tests"
if ! REGRESSION_OUTPUT="$(deno test --allow-all "${E2E_FILES[@]}" --filter "$REGRESSION_FILTER" 2>&1)"; then
  printf '%s\n' "$REGRESSION_OUTPUT"
  exit 1
fi
printf '%s\n' "$REGRESSION_OUTPUT"

if grep -Eq "ok \| 0 passed \| 0 failed" <<<"$REGRESSION_OUTPUT"; then
  echo "ERROR: e2e regression test filter matched zero tests. Check test names or filter ${REGRESSION_FILTER}." >&2
  exit 1
fi

rm -rf "$COVERAGE_DIR"

echo "==> Unit suite with coverage"
if ! UNIT_OUTPUT="$(deno test --allow-all "${UNIT_FILES[@]}" "--coverage=$COVERAGE_DIR" --filter "/unit:/" 2>&1)"; then
  printf '%s\n' "$UNIT_OUTPUT"
  exit 1
fi
printf '%s\n' "$UNIT_OUTPUT"

echo "==> Integration tests"
if ! INTEGRATION_OUTPUT="$(deno test --allow-all "${INTEGRATION_FILES[@]}" --filter "/integration:/" 2>&1)"; then
  printf '%s\n' "$INTEGRATION_OUTPUT"
  exit 1
fi
printf '%s\n' "$INTEGRATION_OUTPUT"

echo "==> E2E tests"
if ! OUTPUT="$(deno test --allow-all "${E2E_FILES[@]}" --filter "/e2e:/" 2>&1)"; then
  printf '%s\n' "$OUTPUT"
  exit 1
fi
printf '%s\n' "$OUTPUT"

echo "==> Generating coverage report"
deno coverage "$COVERAGE_DIR" --lcov > "$COVERAGE_DIR/lcov.info"

COVERED="$(grep -c "^DA:[0-9]*,[^0]" "$COVERAGE_DIR/lcov.info" || true)"
TOTAL="$(grep -c "^DA:" "$COVERAGE_DIR/lcov.info" || true)"

if [[ "$TOTAL" -eq 0 ]]; then
  echo "ERROR: no coverage data found." >&2
  exit 1
fi

PCT=$(( COVERED * 100 / TOTAL ))
echo "==> Coverage: ${PCT}% (threshold: ${COVERAGE_THRESHOLD}%)"
if [[ "$PCT" -lt "$COVERAGE_THRESHOLD" ]]; then
  echo "::error::Coverage ${PCT}% is below the ${COVERAGE_THRESHOLD}% threshold"
  exit 1
fi

echo "==> test-nightly.sh passed"
