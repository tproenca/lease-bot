#!/usr/bin/env bash
# Tier 1 (unit + integration) + Tier 2 (e2e smoke) — run before every merge.
# Requires: supabase start
set -euo pipefail

TIER="${1:-all}"

check_supabase() {
  if ! supabase status &>/dev/null; then
    echo "ERROR: local Supabase is not running. Run: supabase start" >&2
    exit 1
  fi
}

run_tier1() {
  echo "==> Tier 1: unit + integration"
  deno test --allow-all supabase/functions/ --filter "unit|integration"
}

run_tier2() {
  echo "==> Tier 2: e2e smoke"
  deno test --allow-all supabase/functions/ --filter "e2e:smoke"
}

check_supabase

case "$TIER" in
  "--tier 1"|"1") run_tier1 ;;
  "--tier 2"|"2") run_tier2 ;;
  *)
    run_tier1
    run_tier2
    ;;
esac

echo "==> ci.sh passed"
