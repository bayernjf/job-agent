-- Migration 023: add is_admin flag to accounts
-- File: 023_add_account_is_admin.sql
-- Date: 2026-10-03 09:00
-- Depends on: 022
-- Ref: docs/design-llm-model-provisioning-20261003.md §4.2 (admin 面)
-- Note: SQLite dialect. Adds the platform-admin flag for the LLM catalog admin
--       surface (decision #21-5: first admin granted via ADMIN_ACCOUNT_LOGINS env
--       whitelist at login). SQLite has no ADD COLUMN IF NOT EXISTS, so this
--       statement is not idempotent by itself; the migrator records the version,
--       which is what makes repeated application a no-op.

ALTER TABLE accounts ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;

-- DOWN BEGIN
ALTER TABLE accounts DROP COLUMN is_admin;
-- DOWN END
