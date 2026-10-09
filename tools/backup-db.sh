#!/usr/bin/env bash
#
# backup-db.sh — Snapshot the application database with pg_dump.
#
# B4: Supabase Free tier has no platform-managed backups, so keep timestamped
# local dumps as the manual safety net. Dumps land in ./backups/ (gitignored)
# and old ones are pruned beyond BACKUP_KEEP (default 7).
# ROUTINE: run this every week (e.g. Sunday) — Free tier has no automatic
# backups. DATABASE_URL can live in the local .env (gitignored); see handoff
# "当前状态" for the reminder.
#
# Usage:
#   ./tools/backup-db.sh                 # dump using DATABASE_URL from .env
#   DATABASE_URL=postgres://… ./tools/backup-db.sh
#   ./tools/backup-db.sh --dry-run       # print the planned actions only
#   BACKUP_KEEP=14 ./tools/backup-db.sh  # keep 14 dumps instead of 7
#   BACKUP_DIR=/abs/path ./tools/backup-db.sh
#
# Notes:
# - DATABASE_URL must be a session-mode URL: the Supabase direct connection
#   or the 5432 Session pooler. The 6543 Transaction pooler cannot be used —
#   pg_dump needs a dedicated session. The script warns when it detects 6543.
# - pg_dump runs through Docker (`postgres:17-alpine`) when no local pg_dump
#   is installed; a local pg_dump >= 15 is used when present. pg_dump is
#   backward compatible, so the 17 image can dump older servers.
# - Never commit dumps or the DATABASE_URL; backups/ is gitignored.
# - --dry-run prints the planned actions only and never shows the URL.
#
# Exit: 0 on success, 1 on usage/config error, 2 on dump failure.

set -u

BACKUP_DIR="${BACKUP_DIR:-./backups}"
BACKUP_KEEP="${BACKUP_KEEP:-7}"
DRY_RUN=0
if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=1
fi

# 1. Resolve DATABASE_URL from the environment or .env (without sourcing it,
#    so no arbitrary .env content is ever executed).
if [ -z "${DATABASE_URL:-}" ]; then
  if [ -f .env ]; then
    DATABASE_URL="$(grep -E '^DATABASE_URL=' .env | head -n 1 | cut -d= -f2- | tr -d '"')"
  fi
fi
if [ -z "${DATABASE_URL:-}" ]; then
  echo "backup-db.sh: DATABASE_URL is not set (pass it inline or add it to .env)" >&2
  exit 1
fi
if printf '%s' "$DATABASE_URL" | grep -q ':6543'; then
  echo "backup-db.sh: warning: DATABASE_URL points at the 6543 Transaction pooler;" >&2
  echo "             pg_dump needs the 5432 Session pooler or a direct connection" >&2
fi

# 2. Locate pg_dump: local binary first, Docker fallback.
PGDUMP=""
if command -v pg_dump >/dev/null 2>&1; then
  PGDUMP="local"
elif command -v docker >/dev/null 2>&1; then
  PGDUMP="docker"
else
  echo "backup-db.sh: neither pg_dump nor Docker is available" >&2
  exit 1
fi

# 3. Prepare the output location (name sorts by time: YYYYMMDD-HHMMSS).
mkdir -p "$BACKUP_DIR"
BACKUP_DIR_ABS="$(cd "$BACKUP_DIR" && pwd)"
TS="$(date +%Y%m%d-%H%M%S)"
OUT="$BACKUP_DIR/backup-$TS.dump"
OUT_NAME="$(basename "$OUT")"

run_dump() {
  if [ "$DRY_RUN" -eq 1 ]; then
    if [ "$PGDUMP" = "local" ]; then
      echo "would run: pg_dump (custom format, no-owner) -> $OUT"
    else
      echo "would run: docker pg_dump (custom format, no-owner) -> $OUT"
    fi
    return 0
  fi
  if [ "$PGDUMP" = "local" ]; then
    pg_dump --no-owner --no-privileges --format=custom -f "$OUT" "$DATABASE_URL"
  else
    docker run --rm -e DATABASE_URL="$DATABASE_URL" \
      -v "$BACKUP_DIR_ABS:/out" postgres:17-alpine \
      pg_dump --no-owner --no-privileges --format=custom -f "/out/$OUT_NAME" "$DATABASE_URL"
  fi
}

if ! run_dump; then
  echo "backup-db.sh: dump failed (see output above)" >&2
  rm -f "$OUT"
  exit 2
fi

# 4. Prune old dumps, keeping the newest BACKUP_KEEP.
extra="$(ls -1 "$BACKUP_DIR"/backup-*.dump 2>/dev/null | sort -r | tail -n +$((BACKUP_KEEP + 1)))"
if [ -n "$extra" ]; then
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '%s\n' "$extra" | sed 's/^/would remove: /'
  else
    printf '%s\n' "$extra" | xargs rm -f
  fi
fi

# 5. Report (never echoes the URL).
if [ "$DRY_RUN" -eq 1 ]; then
  echo "dry-run: would keep the newest $BACKUP_KEEP dump(s) in $BACKUP_DIR"
else
  SIZE="$(du -h "$OUT" | cut -f1)"
  echo "backup-db.sh: wrote $OUT ($SIZE)"
  echo "backup-db.sh: keeping the newest $BACKUP_KEEP dump(s) in $BACKUP_DIR"
fi

exit 0
