-- Migration 017: add profile removal-requested hold flag to profiles
-- File: 017_add_profile_removal_requested_at.sql
-- Date: 2026-10-01 23:57
-- Dialect: Postgres
-- Depends on: 016
-- Ref: docs/design-profile-removal-request-20261001.md (audit S3)
-- Note: Postgres dialect. Column name and type must match the SQLite migration
--       exactly (migrations-parity test); TEXT stays TEXT per dual-dialect
--       convention, no TIMESTAMPTZ. NULL = no open withdrawal request,
--       UTC ISO8601 = moment the first pending ticket was filed. Cleared again
--       when a ticket is rejected; approval deletes the profile outright.

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS removal_requested_at TEXT;

COMMENT ON COLUMN profiles.removal_requested_at IS 'soft hold: UTC ISO8601 moment a pending withdrawal request was filed (audit S3); NULL = no open request';

-- DOWN BEGIN
ALTER TABLE profiles DROP COLUMN IF EXISTS removal_requested_at;
-- DOWN END
