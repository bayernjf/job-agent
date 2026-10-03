-- Migration 023: add is_admin flag to accounts
-- File: 023_add_account_is_admin.sql
-- Date: 2026-10-03 09:00
-- Dialect: Postgres
-- Depends on: 022
-- Ref: docs/design-llm-model-provisioning-20261003.md §4.2 (admin 面)
-- Note: Postgres dialect. Column set must match the SQLite migration exactly
--       (migrations-parity test). Adds the platform-admin flag for the LLM
--       catalog admin surface (decision #21-5). Idempotence is guaranteed by the
--       migrator recording the version.

ALTER TABLE accounts ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN accounts.is_admin IS 'platform admin flag for the LLM catalog admin surface (decision #21-5; granted via ADMIN_ACCOUNT_LOGINS env whitelist at login)';

-- DOWN BEGIN
ALTER TABLE accounts DROP COLUMN is_admin;
-- DOWN END
