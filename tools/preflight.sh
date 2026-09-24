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
# Usage:  ./tools/preflight.sh [--e2e] [--deploy]
#   --e2e    Additionally run both Playwright suites after the fast stages:
#            report E2E (`pnpm e2e`) and extension E2E (`pnpm e2e:extension`).
#   --deploy Additionally run the pre-launch artifact gates (form C):
#            6. Astro build with the Vercel adapter (ASTRO_ADAPTER=vercel),
#               proving the serverless bundle still builds
#            7. Postgres dialect gate on a throwaway docker container:
#               migrations applied twice (idempotency) plus the storage
#               suites against a real Postgres. Skipped when docker is not
#               reachable, mirroring the postgres-behavior skip rule.
#            8. Extension CWS release zip (EXTENSION_RELEASE=1), which refuses
#               to package a localhost API base. Passes --force because this is
#               a local artifact gate: replacing the previous
#               release/jobagent-extension-v*.zip is the point. Override the
#               baked origin with PREFLIGHT_EXTENSION_API_BASE /
#               PREFLIGHT_EXTENSION_SITE_ORIGIN once the production domain is
#               final.
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
RUN_DEPLOY=0
for arg in "$@"; do
  case "$arg" in
    --e2e) RUN_E2E=1 ;;
    --deploy) RUN_DEPLOY=1 ;;
    -h|--help)
      # Print the header comment block; stops at the first non-comment line so
      # the range never goes stale when the header grows.
      awk 'NR > 1 && !/^#/ { exit } NR > 1 { print }' "$0"; exit 0 ;;
    *) echo "preflight: unknown argument: $arg (expected --e2e and/or --deploy)" >&2; exit 1 ;;
  esac
done

GREEN="\033[32m"; RED="\033[31m"; YELLOW="\033[33m"; BOLD="\033[1m"; RESET="\033[0m"
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

# Production placeholders for the release build; override once the real
# form C domain exists (see docs/部署执行单-形态C-20260921.md stage F).
EXT_API_BASE="${PREFLIGHT_EXTENSION_API_BASE:-https://app.job-agent.bayjf.com/api}"
EXT_SITE_ORIGIN="${PREFLIGHT_EXTENSION_SITE_ORIGIN:-https://app.job-agent.bayjf.com}"

PG_CONTAINER="ja-preflight-pg"
PG_PORT="${PREFLIGHT_PG_PORT:-55432}"
PG_URL="postgres://jobagent:jobagent@127.0.0.1:${PG_PORT}/jobagent"

postgres_gate() {
  if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
    printf "${YELLOW}  SKIP: docker is not reachable; the Postgres dialect gate did not run.${RESET}\n"
    return 0
  fi
  docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true
  if ! docker run -d --name "$PG_CONTAINER" \
      -e POSTGRES_USER=jobagent -e POSTGRES_PASSWORD=jobagent -e POSTGRES_DB=jobagent \
      -p "${PG_PORT}:5432" postgres:16-alpine >/dev/null; then
    echo "  could not start postgres:16-alpine" >&2
    return 1
  fi
  # Always tear the throwaway container down, whatever the gate decides.
  trap 'docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true' RETURN

  local waited=0
  until docker exec "$PG_CONTAINER" pg_isready -U jobagent >/dev/null 2>&1; do
    waited=$((waited + 1))
    if [ "$waited" -gt 60 ]; then
      echo "  postgres did not become ready within 60s" >&2
      return 1
    fi
    sleep 1
  done

  echo "  applying migrations twice (idempotency) against ${PG_URL}"
  DATABASE_URL="$PG_URL" pnpm migrate:pg:up >/dev/null || return 1
  DATABASE_URL="$PG_URL" pnpm migrate:pg:up >/dev/null || return 1
  echo "  running storage suites against real Postgres"
  DATABASE_TEST_URL="$PG_URL" pnpm --filter @jobagent/storage test || return 1
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

if [ "$RUN_DEPLOY" -eq 1 ]; then
  stage "vercel adapter build" \
    env ASTRO_ADAPTER=vercel pnpm --filter @jobagent/report build || exit 1
  stage "postgres dialect gate" postgres_gate || exit 1
  stage "extension release zip" \
    env EXTENSION_RELEASE=1 EXTENSION_API_BASE="$EXT_API_BASE" \
        EXTENSION_SITE_ORIGIN="$EXT_SITE_ORIGIN" \
        pnpm --filter @jobagent/extension exec node scripts/release.mjs --force || exit 1
fi

echo
if [ "$FAILED" -eq 0 ]; then
  printf "${GREEN}${BOLD}preflight: all gates passed — safe to deploy.${RESET}\n"
  exit 0
fi
printf "${RED}${BOLD}preflight: gates failed.${RESET}\n"
exit 1
