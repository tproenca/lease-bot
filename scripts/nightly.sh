#!/usr/bin/env bash
# Tier 3: full e2e suite + coverage check (≥80%) — run nightly on main.
# Requires: supabase start
# On failure, appends a bug entry to issues.md.
set -euo pipefail

COVERAGE_THRESHOLD=80
COVERAGE_DIR="coverage"

check_supabase() {
  if ! supabase status &>/dev/null; then
    echo "ERROR: local Supabase is not running. Run: supabase start" >&2
    exit 1
  fi
}

append_bug_issue() {
  local reason="$1"
  local date
  date=$(date +%Y-%m-%d)
  cat >> issues.md <<EOF

## BUG — nightly failure ($date)
**Detected:** $date
**Reason:** $reason
**Priority:** high
**Dependencies:** none
EOF
  echo "==> Bug entry appended to issues.md"
}

check_supabase

rm -rf "$COVERAGE_DIR"

echo "==> Tier 3: full e2e suite"
if ! deno test --allow-all supabase/functions/ "--coverage=$COVERAGE_DIR"; then
  append_bug_issue "Tier 3 tests failed"
  exit 1
fi

echo "==> Generating coverage report"
deno coverage "$COVERAGE_DIR" --lcov > "$COVERAGE_DIR/lcov.info"

# Extract line coverage percentage from lcov output
COVERED=$(grep -c "^DA:[0-9]*,[^0]" "$COVERAGE_DIR/lcov.info" || true)
TOTAL=$(grep -c "^DA:" "$COVERAGE_DIR/lcov.info" || true)

if [[ "$TOTAL" -eq 0 ]]; then
  echo "WARNING: no coverage data found — skipping threshold check"
else
  PCT=$(( COVERED * 100 / TOTAL ))
  echo "==> Coverage: ${PCT}% (threshold: ${COVERAGE_THRESHOLD}%)"
  if [[ "$PCT" -lt "$COVERAGE_THRESHOLD" ]]; then
    append_bug_issue "Coverage ${PCT}% is below the ${COVERAGE_THRESHOLD}% threshold"
    exit 1
  fi
fi

echo "==> nightly.sh passed"
