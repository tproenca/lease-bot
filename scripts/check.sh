#!/usr/bin/env bash
# Static checks for PRs and local development.
set -euo pipefail

echo "==> Format check"
deno fmt --check supabase/functions

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
