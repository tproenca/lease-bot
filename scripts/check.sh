#!/usr/bin/env bash
# Static checks for PRs and local development.
set -euo pipefail

echo "==> Format check"
deno fmt --check \
  supabase/functions \
  scripts/check.sh \
  scripts/test-unit.sh \
  scripts/test-integration.sh \
  scripts/test-smoke.sh \
  scripts/test-nightly.sh \
  .github/workflows/ci.yml \
  .github/workflows/nightly.yml \
  deno.json \
  AGENTS.md \
  README.md \
  specs/DEVOPS.md \
  specs/TESTING.md \
  specs/TESTING_PLAN.md

echo "==> Lint"
deno lint supabase/functions

echo "==> Type check"
FILES="$(find supabase/functions -name '*.ts' -type f | sort)"
if [[ -z "$FILES" ]]; then
  echo "ERROR: no TypeScript files found under supabase/functions." >&2
  exit 1
fi

# shellcheck disable=SC2086
deno check $FILES

echo "==> check.sh passed"
