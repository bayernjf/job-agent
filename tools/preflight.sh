#!/usr/bin/env bash
#
# preflight.sh — One-command local launch gate for this repository.
#
# Runs the fast, deterministic checks that must be green before deploying
# (form C: Vercel + Supabase). It does NOT hit the network for tests and does
# NOT start any service; unit tests use recorded fixtures/fakes only.
#
# Stages (in order):
#   1. pnpm -r typecheck                 TypeScript strict across all workspaces
#   2. bash tools/check-migrations.sh    Migration naming/numbering/header checks
#   3. pnpm -r test                      All co-located Vitest unit suites
#   4. pnpm -r build                     Build every workspace
#   5. pnpm audit --audit-level=high     Dependency vulnerability audit
#      (pinned to the official npm registry so the check also works when the
#      install registry is a mirror such as registry.npmmirror.com, which does
#      not implement the audit endpoint)
#
# Usage:  ./tools/preflight.sh [--e2e]
#   --e2e  Additionally run both Playwright suites after the fast stages:
#          report E2E (`pnpm e2e`) and extension E2E (`pnpm e2e:extension`).
# Exit:   0 = every stage passed, 1 = at least one stage failed (the first
#          failing stage is reported and the script stops immediately).
#
# Run under the authoritative Node version (.nvmrc), e.g.:
#   eval "$(fnm env)" && fnm use && bash tools/preflight.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/pnpm-workspace.yaml" ]; then
  ROOT="$SCRIPT_DIR"
elif [ -f "$(dirname "$SCRIPT_DIR")/pnpm-workspace.yaml" ]; then
  ROOT="$(dirname "$SCRIPT_DIR")"
else
  echo "preflight: cannot locate repository root (pnpm-workspace.yaml)." >&2
  exit 1
fi
cd "$ROOT"

RUN_E2E=0
if [ "${1:-}" = "--e2e" ]; then
  RUN_E2E=1
fi

GREEN="\033[32m"; RED="\033[31m"; BOLD="\033[1m"; RESET="\033[0m"
FAILED=0

stage() {
  # $1 = stage label, remaining args = command
  local label="$1"; shift
  echo
  printf "${BOLD}▶ %s${RESET}\n" "$label"
  if "$@"; then
    printf "${GREEN}✔ %s passed${RESET}\n" "$label"
  else
    printf "${RED}✘ %s FAILED${RESET}\n" "$label"
    FAILED=1
    return 1
  fi
}

echo "preflight: repo root $ROOT"
echo "preflight: node $(node -v 2>/dev/null || echo 'not found'), pnpm $(pnpm -v 2>/dev/null || echo 'not found')"

stage "typecheck"           pnpm -r typecheck || exit 1
stage "migration checks"    bash tools/check-migrations.sh || exit 1
stage "unit tests"          pnpm -r test || exit 1
stage "build"               pnpm -r build || exit 1
stage "dependency audit"    pnpm audit --audit-level=high --registry https://registry.npmjs.org || exit 1

if [ "$RUN_E2E" -eq 1 ]; then
  stage "report E2E"     pnpm e2e || exit 1
  stage "extension E2E"  pnpm e2e:extension || exit 1
fi

echo
if [ "$FAILED" -eq 0 ]; then
  printf "${GREEN}${BOLD}preflight: all gates passed — safe to deploy.${RESET}\n"
  exit 0
fi
printf "${RED}${BOLD}preflight: gates failed.${RESET}\n"
exit 1
