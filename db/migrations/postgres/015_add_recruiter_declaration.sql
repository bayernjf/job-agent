-- Migration 015: add recruiter self-declaration timestamp to accounts
-- File: 015_add_recruiter_declaration.sql
-- Date: 2026-09-30 01:52
-- Depends on: 010
-- Ref: docs/design-recruiter-roles-20260925.md §3 (F10, decision #17 phase 1)
-- Note: Postgres dialect. Column set and names must match the SQLite migration
--       exactly (migrations-parity test). TEXT stays TEXT per dual-dialect
--       convention, no TIMESTAMPTZ. NULL = not declared; UTC ISO8601 = declared.
--       upsertFromProvider never writes this column; deleteUnclaimed excludes
--       declared accounts so re-login and cleanup can never silently reset it.

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS recruiter_declared_at TEXT;

COMMENT ON COLUMN accounts.recruiter_declared_at IS 'UTC ISO8601 self-declaration moment for recruiter-facing access (F10); NULL = not declared';

-- DOWN BEGIN
ALTER TABLE accounts DROP COLUMN IF EXISTS recruiter_declared_at;
-- DOWN END
