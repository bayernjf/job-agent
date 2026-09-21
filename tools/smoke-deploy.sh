#!/usr/bin/env bash
#
# smoke-deploy.sh — Automated post-deployment smoke checks for the JobAgent
# Form C deployment (Vercel same-origin app: Astro report site at / and the
# Hono API mounted at /api/*).
#
# It covers the automatable subset of Runbook section 10 (items 1 and 9-10):
#   1. GET /api/health                         -> 200 {"status":"ok"}
#   2. GET /  and  /en/  report pages          -> 200 HTML
#   3. GET /api/internal/cron/process-job
#        without token                        -> 401
#        with the correct CRON_SECRET         -> 200 (idle when the queue is
#                                                empty; this is safe and
#                                                claims at most one job)
#   4. GET /api/jobs/<random>                 -> 404 (proves routing + DB)
#   5. GET /api/demo/presets                  -> 200 (public read endpoint)
#
# Usage:
#   ./tools/smoke-deploy.sh <base-url> [--cron-secret <secret>]
# Example:
#   ./tools/smoke-deploy.sh https://app.job-agent.bayjf.com \
#       --cron-secret "$CRON_SECRET"
#
# Items requiring a real browser / real OAuth consent (Runbook 10.2-10.8,
# 10.10) cannot be automated here; they are printed as a manual checklist at
# the end.
#
# Exit: 0 when every automated check passes, 1 otherwise.

set -u

BASE_URL=""
CRON_SECRET=""
while [ $# -gt 0 ]; do
  case "$1" in
    --cron-secret)
      [ $# -ge 2 ] || { echo "error: --cron-secret requires a value" >&2; exit 1; }
      CRON_SECRET="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,30p' "$0"; exit 0 ;;
    *)
      if [ -z "$BASE_URL" ]; then BASE_URL="$1"; shift; else
        echo "error: unexpected argument: $1" >&2; exit 1; fi ;;
  esac
done

if [ -z "$BASE_URL" ]; then
  echo "usage: $0 <base-url> [--cron-secret <secret>]" >&2
  exit 1
fi
BASE_URL="${BASE_URL%/}"  # strip trailing slash

if ! command -v curl >/dev/null 2>&1; then
  echo "error: curl is required but was not found in PATH" >&2
  exit 1
fi

PASS=0
FAIL=0
BODY_FILE="$(mktemp -t ja-smoke.XXXXXX)"
trap 'rm -f "$BODY_FILE"' EXIT

# check <name> <expected_status> <curl-args...>
check() {
  local name="$1" expected="$2"; shift 2
  local status
  status="$(curl -sS --max-time 20 -o "$BODY_FILE" -w '%{http_code}' "$@")"
  if [ "$status" = "$expected" ]; then
    echo "PASS  $name (HTTP $status)"
    PASS=$((PASS + 1))
  else
    echo "FAIL  $name (expected $expected, got $status)"
    sed 's/^/        /' "$BODY_FILE" | head -5
    FAIL=$((FAIL + 1))
  fi
}

# check_contains <name> <expected_status> <needle> <curl-args...>
check_contains() {
  local name="$1" expected="$2" needle="$3"; shift 3
  local status
  status="$(curl -sS --max-time 20 -o "$BODY_FILE" -w '%{http_code}' "$@")"
  if [ "$status" = "$expected" ] && grep -q "$needle" "$BODY_FILE"; then
    echo "PASS  $name (HTTP $status, body matches '$needle')"
    PASS=$((PASS + 1))
  else
    echo "FAIL  $name (expected $status + '$needle', got $status)"
    sed 's/^/        /' "$BODY_FILE" | head -5
    FAIL=$((FAIL + 1))
  fi
}

echo "== Smoking $BASE_URL =="
echo

# 1. API health through the same-origin /api mount
check_contains "GET /api/health" 200 '"status":"ok"' "$BASE_URL/api/health"

# 2. Report SSR pages
check "GET / (report home)" 200 "$BASE_URL/"
check "GET /en/ (English report home)" 200 "$BASE_URL/en/"

# 3. Cron endpoint authorization
check "GET cron process-job without token -> 401" 401 \
  "$BASE_URL/api/internal/cron/process-job"
if [ -n "$CRON_SECRET" ]; then
  check "GET cron process-job with token -> 200" 200 \
    "$BASE_URL/api/internal/cron/process-job?token=$CRON_SECRET"
else
  echo "SKIP  cron process-job with token (pass --cron-secret to enable)"
fi

# 4. Routing + database reachability: unknown job must be a clean 404
check "GET /api/jobs/unknown -> 404" 404 \
  "$BASE_URL/api/jobs/job-does-not-exist-smoke"

# 5. Public read endpoint
check "GET /api/demo/presets -> 200" 200 "$BASE_URL/api/demo/presets"

echo
echo "Automated checks: $PASS passed, $FAIL failed"
echo
echo "Manual checklist (Runbook section 10, needs a real browser):"
echo "  [ ] 10.2 Anonymous report: conclusions/skills/match/resume public;"
echo "          evidence links/interview questions/interview-kit show the login"
echo "          wall; interview-kit.md returns 401 when logged out"
echo "  [ ] 10.3 GitHub login -> callback -> identity shown -> trigger own"
echo "          analysis (no demo quota used) -> claim profile -> verified badge"
echo "  [ ] 10.4 Gitee login + claim (if the Gitee OAuth app is configured)"
echo "  [ ] 10.5 Demo session: three quota gates work; platform=all costs 2"
echo "  [ ] 10.6 One real analysis per source (github/gitee/all) completes and"
echo "          the share link opens"
echo "  [ ] 10.7 Run jobs sync / demo cleanup / auth cleanup once (Actions or"
echo "          cron endpoint), exit code 0"
echo "  [ ] 10.8 Resume AI polish when LLM_* is set; graceful rule-based"
echo "          fallback otherwise"
echo "  [ ] 10.10 Vercel logs show per-minute cron invocations without"
echo "          FUNCTION_INVOCATION_TIMEOUT"

if [ "$FAIL" -ne 0 ]; then
  exit 1
fi
