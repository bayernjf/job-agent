#!/bin/bash
# Weekly launchd wrapper for backup-db.sh.
#
# backup-db.sh falls back to `docker run postgres:17-alpine` when no local
# pg_dump is installed, so the daemon has to be up before the dump starts.
# Nothing else guarantees Docker is running at 03:00 on a Sunday, so wait for
# the socket here rather than letting the dump die on an unrelated error that
# looks like a database problem.
set -u

# launchd starts with a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin). The Docker
# CLI lives in /usr/local/bin, so without this the daemon check below would pass
# (it uses an absolute path) while backup-db.sh still reports "neither pg_dump
# nor Docker is available".
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

DOCKER=/usr/local/bin/docker
TIMEOUT_SECONDS=${DOCKER_WAIT_SECONDS:-180}

waited=0
while [ "$waited" -lt "$TIMEOUT_SECONDS" ]; do
  if "$DOCKER" info >/dev/null 2>&1; then
    break
  fi
  sleep 5
  waited=$((waited + 5))
done

if ! "$DOCKER" info >/dev/null 2>&1; then
  echo "backup-db-launchd.sh: docker daemon not ready after ${TIMEOUT_SECONDS}s" >&2
  exit 1
fi

# The plain dump cannot finish here: the Supabase pooler kills the long COPY of
# public.job_postings after roughly two minutes, so the weekly job runs the
# chunked variant by default. BACKUP_SCRIPT can point it back at the plain
# script once the pooler stops truncating large tables.
#
# 2026-11-17 hardening: the local egress to the Supabase pooler (both ports)
# intermittently gets its PostgreSQL startup packet RST'ed mid-path — TCP and
# even TLS connect fine, but libpq's first data packet is killed (production
# /api/health?deep=1 stays `db: ok` at the same moment, so it is a local-path
# protocol block, not a database outage). The first scheduled run (2026-11-15)
# failed with exactly this. Two mitigations here:
#   1. Retry within the window (BACKUP_RETRY_TIMES x BACKUP_RETRY_SLEEP) — the
#      block is intermittent by day.
#   2. On final failure write a persistent marker into the backup dir itself
#      (LAST-RUN-FAILED.txt) — /tmp logs vanish on reboot; the marker makes a
#      broken week visible next to the artifacts. Success clears the marker.

BACKUP_DIR="${BACKUP_DIR:-$HOME/000mycodes-backups/job-agent}"
RETRY_TIMES=${BACKUP_RETRY_TIMES:-2}
RETRY_SLEEP=${BACKUP_RETRY_SLEEP:-300}
MARKER="$BACKUP_DIR/LAST-RUN-FAILED.txt"

status=1
attempt=0
while [ "$attempt" -le "$RETRY_TIMES" ]; do
  if [ "$attempt" -gt 0 ]; then
    echo "backup-db-launchd.sh: retry $attempt/$RETRY_TIMES after ${RETRY_SLEEP}s (previous attempt failed)" >&2
    sleep "$RETRY_SLEEP"
  fi
  # 注意：不要写成 `if chunked; then status=0; fi; status=$?` —— 条件为假且无 else
  # 分支时 if 语句整体返回 0，$? 会把失败误报成成功（2026-11-17 实测踩过）。
  /bin/bash "$(dirname "$0")/${BACKUP_SCRIPT:-backup-db-chunked.sh}" "$@"
  status=$?
  if [ "$status" -eq 0 ]; then
    break
  fi
  attempt=$((attempt + 1))
done

if [ "$status" -ne 0 ]; then
  mkdir -p "$BACKUP_DIR"
  {
    echo "backup FAILED at $(date -u +%Y-%m-%dT%H:%M:%SZ) (exit $status, attempts $((attempt + 1)))"
    echo "known cause since 2026-11-13: local egress to the Supabase pooler gets its"
    echo "PostgreSQL startup packet RST'ed (TCP/TLS fine); production is healthy —"
    echo "retry manually when the network path recovers, or run the dump from a"
    echo "different egress (proxy tunnel / hotspot)."
  } > "$MARKER"
  echo "backup-db-launchd.sh: FAILED (exit $status); marker written to $MARKER" >&2
else
  rm -f "$MARKER"
fi
exit "$status"
