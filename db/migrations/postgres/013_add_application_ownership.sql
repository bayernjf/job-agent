-- Migration 013: add account ownership to applications
-- File: 013_add_application_ownership.sql
-- Date: 2026-09-25 05:10
-- Dialect: Postgres
-- Depends on: 009, 010
-- Ref: docs/design-c-side-first-20260925.md §9 (T01), decision #17-F11 (adopted 2026-09-25)
-- Note: Postgres dialect. Column set and names must match the SQLite migration
--       exactly (migrations-parity test). Nullable on purpose: rows predating the
--       account spine (009 says "No accounts yet") cannot have their original
--       author reconstructed, so history stays NULL instead of a back-filled guess.
--       Text columns stay TEXT per the dual-dialect convention, no TIMESTAMPTZ/UUID.

ALTER TABLE applications ADD COLUMN IF NOT EXISTS created_by_account_id TEXT;

COMMENT ON COLUMN applications.created_by_account_id IS 'accounts.id of the logged-in creator; NULL for anonymous or pre-account rows';

-- DOWN BEGIN
ALTER TABLE applications DROP COLUMN IF EXISTS created_by_account_id;
-- DOWN END
