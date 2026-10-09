#!/usr/bin/env bash
#
# verify-cron-consumers.sh — Assert every cron consumer produced a fresh
# heartbeat after a given instant.
#
# Why: the Cloudflare cron Worker is deployed out of band (by hand, or by the
# deploy-cron-worker workflow). A stale bundle, a rotated secret or a cron that
# stopped firing leaves no user-visible error: on 2026-10-10 a Worker built
# from 10-08 code kept `process-job`/`agent-tick`/`watchdog` healthy while the
# newer `search-tick` consumer never ran at all, so every websearch run sat in
# `queued` forever. The heartbeat is written per consumer on every attempt, so
# reading it answers "did this consumer ever run?" — a consumer that was never
# called has no row in `cronHeartbeat`, which a plain `/api/health` 200 hides.
#
# Usage:
#   ./tools/verify-cron-consumers.sh --since 2026-10-10T05:26:00Z
#   ./tools/verify-cron-consumers.sh --since "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
#   ORIGIN=http://localhost:3000 ./tools/verify-cron-consumers.sh --since ...
#
# Options:
#   --since <iso>          Required. Instant the deploy (or the wait) began.
#                          Any ISO 8601 form; an offset is honoured, a bare
#                          timestamp without one is read as UTC.
#   --origin <url>         Default: https://app.job-agent.bayjf.com
#   --consumers a,b,c      Default: process-job,agent-tick,search-tick,watchdog
#   --timeout-seconds N    Default 480 (two 5-minute ticks plus slack).
#   --interval-seconds N   Default 20.
#
# Exit: 0 all consumers fresh, 1 usage/config error, 2 timed out.

set -u

ORIGIN="${ORIGIN:-https://app.job-agent.bayjf.com}"
SINCE=""
CONSUMERS="process-job,agent-tick,search-tick,watchdog"
TIMEOUT_SECONDS=480
INTERVAL_SECONDS=20

while [ $# -gt 0 ]; do
  case "$1" in
    --since) SINCE="${2:-}"; shift 2 ;;
    --origin) ORIGIN="${2:-}"; shift 2 ;;
    --consumers) CONSUMERS="${2:-}"; shift 2 ;;
    --timeout-seconds) TIMEOUT_SECONDS="${2:-}"; shift 2 ;;
    --interval-seconds) INTERVAL_SECONDS="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [ -z "$SINCE" ]; then
  echo "usage: $0 --since <ISO-8601 UTC instant> [--origin URL]" >&2
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required to parse the health payload" >&2
  exit 1
fi

DEADLINE=$(( $(date +%s) + TIMEOUT_SECONDS ))
ATTEMPT=0
LAST_REPORT=""

while :; do
  ATTEMPT=$((ATTEMPT + 1))
  BODY="$(curl -fsS -m 30 "$ORIGIN/api/health?deep=1" 2>/dev/null || true)"
  if [ -n "$BODY" ]; then
    LAST_REPORT="$(
      SINCE="$SINCE" CONSUMERS="$CONSUMERS" python3 - "$BODY" <<'PY'
import json, os, sys

from datetime import datetime, timezone


def parse_instant(value):
    """Parse an ISO 8601 instant; assume UTC when no offset is given."""
    text = (value or "").strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed


try:
    payload = json.loads(sys.argv[1])
except Exception:
    print("UNPARSEABLE health payload")
    raise SystemExit(0)

since = parse_instant(os.environ["SINCE"])
if since is None:
    print("UNPARSEABLE --since value: " + os.environ["SINCE"])
    raise SystemExit(4)

needed = [c.strip() for c in os.environ["CONSUMERS"].split(",") if c.strip()]
heartbeats = {h.get("consumer"): h for h in payload.get("cronHeartbeat", [])}

missing = [c for c in needed if c not in heartbeats]
stale = []
for c in needed:
    if c not in heartbeats:
        continue
    last = parse_instant(heartbeats[c].get("lastSuccessAt"))
    if last is None or last <= since:
        stale.append(c)
errors = [
    f"{c} ({heartbeats[c]['lastError']})"
    for c in needed
    if c in heartbeats and heartbeats[c].get("lastError")
]
for c in needed:
    hb = heartbeats.get(c)
    if hb is None:
        print(f"  {c:13} missing  (never called)")
    else:
        print(f"  {c:13} {hb.get('lastSuccessAt')}  {hb.get('lastResult')}")

if not missing and not stale:
    print("OK: every consumer heartbeat is newer than " + os.environ["SINCE"])
    if errors:
        print("note: recorded errors: " + "; ".join(errors))
    raise SystemExit(0)
print("WAIT: missing=" + ",".join(missing) + " stale=" + ",".join(stale))
raise SystemExit(3)
PY
    )"
    RC=$?
    printf '%s\n' "$LAST_REPORT"
    if [ "$RC" -eq 0 ]; then
      exit 0
    fi
    if [ "$RC" -eq 4 ]; then
      exit 1
    fi
  else
    LAST_REPORT="health endpoint did not answer"
    echo "  health endpoint did not answer (attempt $ATTEMPT)"
  fi

  if [ "$(date +%s)" -ge "$DEADLINE" ]; then
    echo "FAILED: consumers not fresh after ${TIMEOUT_SECONDS}s since $SINCE" >&2
    echo "$LAST_REPORT" >&2
    exit 2
  fi
  sleep "$INTERVAL_SECONDS"
done
