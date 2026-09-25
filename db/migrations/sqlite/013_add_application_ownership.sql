-- Migration 013: add account ownership to applications
-- File: 013_add_application_ownership.sql
-- Date: 2026-09-25 05:10
-- Depends on: 009, 010
-- Ref: docs/design-c-side-first-20260925.md §9 (T01), decision #17-F11 (adopted 2026-09-25)
-- Note: SQLite dialect. The column is nullable on purpose: every row written before
--       this migration predates the account spine (009 says "No accounts yet"), so
--       its original author cannot be reconstructed and history is left NULL rather
--       than back-filled with a guess. Ownership is enforced inside the repository
--       layer, never by callers assembling SQL. No index: both the write path and
--       the ownership check go through the primary key, and no listing-by-account
--       surface exists yet (that is item60 T17).

ALTER TABLE applications ADD COLUMN created_by_account_id TEXT;

-- DOWN BEGIN
ALTER TABLE applications DROP COLUMN created_by_account_id;
-- DOWN END
