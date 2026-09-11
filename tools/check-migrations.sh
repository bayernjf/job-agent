#!/usr/bin/env bash
#
# check-migrations.sh — Migration convention checker for this repository.
#
# With no argument it checks BOTH dialect directories under db/migrations
# (sqlite/ and postgres/) and additionally verifies that their file-name sets
# match one-to-one (design-storage-dual-dialect D3). With an explicit directory
# argument it checks only that directory.
#
# Per-file checks (MIGRATION_CONVENTION.md):
#   1. File naming:      NNN_verb_snake_case.sql
#   2. Numbering:        starts at 001, strictly incremental, no duplicates/skips
#   3. Header comment:   every file has `-- Migration NNN:`, `-- File:`, and
#                        `-- Date: YYYY-MM-DD HH:mm` (24h, minute precision)
#   4. Consistency:      `-- File:` matches the actual file name
#
# Usage:  ./check-migrations.sh [migration-dir]
# Exit:   0 = all checks passed, 1 = violations found
#
# The script only reads files; it never modifies them.

set -u

# Repository root detection: works whether this script lives in the repo root
# or in a <root>/tools/ subdirectory.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -d "$SCRIPT_DIR/db/migrations" ] || [ -d "$SCRIPT_DIR/supabase/migrations" ]; then
  ROOT="$SCRIPT_DIR"
elif [ -d "$(dirname "$SCRIPT_DIR")/db/migrations" ] || [ -d "$(dirname "$SCRIPT_DIR")/supabase/migrations" ]; then
  ROOT="$(dirname "$SCRIPT_DIR")"
else
  ROOT="$SCRIPT_DIR"
fi

FAIL=0
WARN=0

check_dir() {
  local DIR="$1"
  if [ ! -d "$DIR" ]; then
    echo "x Migration directory not found: $DIR"
    FAIL=$((FAIL + 1))
    return
  fi

  shopt -s nullglob
  local FILES=("$DIR"/*.sql)
  shopt -u nullglob

  if [ ${#FILES[@]} -eq 0 ]; then
    echo "i No migration files in $DIR"
    echo
    return
  fi

  echo "Checking ${#FILES[@]} migration file(s) in $DIR"

  local prev=0 first=1
  for f in "${FILES[@]}"; do
    local base num name n
    base="$(basename "$f")"
    local issues=()

    # --- 1. naming ---
    if [[ "$base" =~ ^([0-9]{3})_([a-z][a-z0-9_]*)\.sql$ ]]; then
      num="${BASH_REMATCH[1]}"
      name="${BASH_REMATCH[2]}"
    else
      issues+=("naming: expected NNN_snake_case.sql")
      num=""
      name=""
    fi

    # --- 2. numbering ---
    if [ -n "$num" ]; then
      n=$((10#$num))
      if [ "$first" -eq 1 ]; then
        if [ "$n" -ne 1 ]; then
          issues+=("numbering: first file must be 001, got ${num}")
        fi
        first=0
      else
        if [ "$n" -le "$prev" ]; then
          issues+=("numbering: ${num} is not strictly after previous ${prev} (duplicate or out of order)")
        elif [ "$n" -ne $((prev + 1)) ]; then
          issues+=("numbering: skip detected (${prev} -> ${num}), expected $((prev + 1))")
        fi
      fi
      prev="$n"
    fi

    # --- 3. header comment (first 12 lines) ---
    local hdr
    hdr="$(head -n 12 "$f")"

    if ! grep -q -- "-- Migration" <<<"$hdr"; then
      issues+=("header: missing '-- Migration NNN:' line")
    fi

    if ! grep -qE -- "-- Date: [0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}" <<<"$hdr"; then
      issues+=("header: missing or malformed '-- Date: YYYY-MM-DD HH:mm'")
    fi

    local fileline declared
    fileline="$(grep -m1 -- "-- File:" <<<"$hdr" || true)"
    if [ -z "$fileline" ]; then
      issues+=("header: missing '-- File:' line")
    else
      declared="$(sed -E 's/^.*-- File:[[:space:]]*//' <<<"$fileline")"
      if [ "$declared" != "$base" ]; then
        issues+=("header: '-- File:' is '$declared', expected '$base'")
      fi
    fi

    # --- verb-first warning (non-blocking) ---
    if [ -n "$name" ]; then
      local verb
      verb="$(printf '%s' "$name" | cut -d_ -f1)"
      case "$verb" in
        create|add|alter|fix|drop|set|update|rename|delete|migrate) ;;
        *) issues+=("warning: description should start with a verb (got '$verb')"); WARN=$((WARN+1));;
      esac
    fi

    # --- report ---
    if [ ${#issues[@]} -gt 0 ]; then
      echo "x $base"
      for i in "${issues[@]}"; do
        echo "    - $i"
      done
      FAIL=$((FAIL+1))
    fi
  done
  echo
}

# Cross-dialect parity: file-name sets must be identical.
check_parity() {
  local SQLITE_DIR="$1" PG_DIR="$2"
  if [ ! -d "$SQLITE_DIR" ] || [ ! -d "$PG_DIR" ]; then
    echo "x Parity check needs both $SQLITE_DIR and $PG_DIR"
    FAIL=$((FAIL + 1))
    return
  fi
  local sqlite_names pg_names diff_out
  sqlite_names="$( (cd "$SQLITE_DIR" && ls -- *.sql | sort) )"
  pg_names="$( (cd "$PG_DIR" && ls -- *.sql | sort) )"
  diff_out="$(diff <(printf '%s\n' "$sqlite_names") <(printf '%s\n' "$pg_names") || true)"
  if [ -n "$diff_out" ]; then
    echo "x sqlite/ and postgres/ migration file sets diverge:"
    printf '%s\n' "$diff_out" | sed 's/^/    /'
    FAIL=$((FAIL + 1))
  else
    echo "OK  sqlite/ and postgres/ migration file sets match."
    echo
  fi
}

ARG_DIR="${1:-}"

if [ -n "$ARG_DIR" ]; then
  check_dir "$ARG_DIR"
elif [ -d "$ROOT/db/migrations/sqlite" ]; then
  check_dir "$ROOT/db/migrations/sqlite"
  check_dir "$ROOT/db/migrations/postgres"
  check_parity "$ROOT/db/migrations/sqlite" "$ROOT/db/migrations/postgres"
elif [ -d "$ROOT/supabase/migrations" ]; then
  check_dir "$ROOT/supabase/migrations"
else
  echo "x No migration directory found (db/migrations/{sqlite,postgres} or supabase/migrations)."
  exit 1
fi

if [ "$FAIL" -eq 0 ]; then
  echo "OK  All migration checks pass (${WARN} warning(s))."
  exit 0
else
  echo "x ${FAIL} violation(s)."
  exit 1
fi
