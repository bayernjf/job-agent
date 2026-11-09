#!/bin/bash
# Chunked pg_dump for the Supabase pooler path.
#
# A plain `pg_dump` of public.job_postings over the Supabase pooler is killed
# after roughly two minutes ("SSL connection has been closed unexpectedly"),
# so the main dump excludes that table's data and its rows are exported in
# keyset-paginated CSV chunks instead. Artifact set per timestamp:
#   backup-<TS>.dump                      schema + every table except job_postings
#   backup-<TS>.job_postings.partNN.csv   the excluded rows
#   backup-<TS>.state                     resume point
#
# Resume: JA_TS=<ts> JA_SKIP_MAIN=1 re-runs only the chunk phase, continuing
# from the recorded boundary id.
# Env knobs: BACKUP_DIR (default ~/000mycodes-backups/job-agent), JA_CHUNK.
set -uo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR" || exit 1

DIR="${BACKUP_DIR:-$HOME/000mycodes-backups/job-agent}"
# 200 rows/chunk is the largest size observed to survive: 2000 was killed
# twice on chunk 1 (2026-11-09), 200 ran 13 chunks back to back. Each chunk is
# its own short connection, so the per-chunk overhead dominates either way.
CHUNK=${JA_CHUNK:-200}

set -a
# shellcheck disable=SC1091
source .env
set +a

mkdir -p "$DIR" || exit 1

TS=${JA_TS:-$(date +%Y%m%d-%H%M%S)}
MAIN="$DIR/backup-$TS.dump"
STATE="$DIR/backup-$TS.state"

if [ "${JA_SKIP_MAIN:-0}" != "1" ]; then
  echo "[1/2] main dump (public schema only + all tables except job_postings data)"
  # --schema=public keeps Supabase platform schemas (auth/storage/realtime/vault…)
  # out of the dump: they depend on platform-only extensions that a stock PG
  # image cannot restore. public has no extension dependency.
  if ! docker run --rm postgres:17-alpine pg_dump --no-owner --no-privileges --format=custom \
      --schema=public --exclude-table-data=public.job_postings "$DATABASE_URL" > "$MAIN"; then
    echo "MAIN DUMP FAILED"
    rm -f "$MAIN"
    exit 1
  fi
  ls -lh "$MAIN"
fi

echo "[2/2] chunked job_postings (keyset by text id, $CHUNK rows/chunk, ts=$TS)"
if [ -f "$STATE" ]; then
  # shellcheck disable=SC1090
  source "$STATE"
  echo "resuming from state: N=$N TOTAL=$TOTAL LAST=$LAST"
else
  LAST=''
  N=0
  TOTAL=0
fi

while true; do
  # Boundary pre-query: exact row count plus last id for this chunk. Index-only,
  # so it stays fast even though the table itself cannot be copied in one go.
  META=$(docker run --rm postgres:17-alpine psql -qAt --no-psqlrc "$DATABASE_URL" \
    -c "SELECT count(*), coalesce(max(id),'') FROM (SELECT id FROM public.job_postings WHERE id > '$LAST' ORDER BY id LIMIT $CHUNK) t" \
    2>"/tmp/ja-chunk-err.log")
  if [ $? -ne 0 ]; then
    echo "boundary query failed (last_id='$LAST'):"
    tail -3 "/tmp/ja-chunk-err.log"
    exit 3
  fi
  ROWS_IN=${META%%|*}
  NEWLAST=${META#*|}
  [ "$ROWS_IN" = "0" ] && break

  N=$((N+1))
  PART=$(printf "%s/backup-%s.job_postings.part%02d.csv" "$DIR" "$TS" "$N")
  ok=0
  for attempt in 1 2; do
    if docker run --rm postgres:17-alpine psql -q --no-psqlrc "$DATABASE_URL" \
        -c "\copy (SELECT * FROM public.job_postings WHERE id > '$LAST' ORDER BY id LIMIT $CHUNK) TO STDOUT WITH (FORMAT csv, NULL '\N')" \
        > "$PART" 2>"/tmp/ja-chunk-err.log"; then
      ok=1
      break
    fi
    echo "chunk $N attempt $attempt failed (last_id='$LAST'):"
    tail -3 "/tmp/ja-chunk-err.log"
    rm -f "$PART"
    sleep 2
  done
  if [ "$ok" -ne 1 ]; then
    echo "CHUNK $N FAILED twice; resume with JA_TS=$TS JA_SKIP_MAIN=1 after fixing; last boundary id='$LAST'"
    exit 2
  fi
  TOTAL=$((TOTAL+ROWS_IN))
  printf 'LAST=%s\nN=%d\nTOTAL=%d\n' "$NEWLAST" "$N" "$TOTAL" > "$STATE"
  echo "chunk $N: rows=$ROWS_IN last_id=$NEWLAST (cumulative=$TOTAL)"
  if [ "$ROWS_IN" -lt "$CHUNK" ]; then
    break
  fi
  LAST=$NEWLAST
done

echo "DONE ts=$TS job_postings_rows=$TOTAL parts=$N"
ls -lh "$DIR"/backup-"$TS"*
