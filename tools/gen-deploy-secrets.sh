#!/usr/bin/env bash
#
# gen-deploy-secrets.sh — Generate the random server-side secrets required by
# the Form C production deployment (Vercel + Supabase).
#
# Generates three independent 256-bit values:
#   CRON_SECRET        shared token for /api/internal/cron/* invocations
#   AUTH_STATE_SECRET  HMAC key for OAuth state cookies (must be fixed across
#                      serverless instances, otherwise in-flight logins break
#                      on cold starts)
#   DEMO_IP_SALT       salt for the IP rate-limit sliding window hash
#
# Usage:
#   ./tools/gen-deploy-secrets.sh                 # print export lines only
#   ./tools/gen-deploy-secrets.sh --out .env.production.secrets
#                                                 # also write KEY=VALUE lines
#                                                 # to a file (chmod 600)
#
# Notes:
# - The script never prints existing values and never reads them back; it only
#   creates fresh random bytes with openssl.
# - Files named .env* are gitignored (except .env.example); never paste these
#   values into Git, the client bundle, or the Vercel NEXT_PUBLIC_* namespace.
# - Paste each value into the Vercel project environment variables UI; do not
#   commit the output file.
#
# Exit: 0 on success, 1 on usage/openssl error.

set -u

OUT_FILE=""
if [ "${1:-}" = "--out" ]; then
  if [ $# -ne 2 ] || [ -z "${2:-}" ]; then
    echo "usage: $0 [--out <file>]" >&2
    exit 1
  fi
  OUT_FILE="$2"
elif [ $# -ne 0 ]; then
  echo "usage: $0 [--out <file>]" >&2
  exit 1
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "error: openssl is required but was not found in PATH" >&2
  exit 1
fi

CRON_SECRET="$(openssl rand -hex 32)"
AUTH_STATE_SECRET="$(openssl rand -hex 32)"
DEMO_IP_SALT="$(openssl rand -hex 32)"

if [ -n "$OUT_FILE" ]; then
  if [ -e "$OUT_FILE" ]; then
    echo "error: $OUT_FILE already exists; refuse to overwrite an existing file" >&2
    exit 1
  fi
  {
    echo "# JobAgent Form C production secrets — generated $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "# Paste into the Vercel project env vars, then delete this file. Never commit it."
    echo "CRON_SECRET=$CRON_SECRET"
    echo "AUTH_STATE_SECRET=$AUTH_STATE_SECRET"
    echo "DEMO_IP_SALT=$DEMO_IP_SALT"
  } > "$OUT_FILE"
  chmod 600 "$OUT_FILE"
  echo "Wrote $OUT_FILE (chmod 600). Paste the values into Vercel, then delete the file."
  echo
fi

cat <<EOF
# Copy into the Vercel project Environment Variables (Production):
CRON_SECRET=$CRON_SECRET
AUTH_STATE_SECRET=$AUTH_STATE_SECRET
DEMO_IP_SALT=$DEMO_IP_SALT

# Reminder: apps/report/vercel.json cron path must carry the same CRON_SECRET
# as ?token=<CRON_SECRET> (or configure the schedules in the Vercel cron UI).
EOF
