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
exec /bin/bash "$(dirname "$0")/${BACKUP_SCRIPT:-backup-db-chunked.sh}" "$@"
