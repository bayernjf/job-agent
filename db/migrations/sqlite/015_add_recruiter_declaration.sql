-- Migration 015: add recruiter self-declaration timestamp to accounts
-- File: 015_add_recruiter_declaration.sql
-- Date: 2026-09-30 01:52
-- Depends on: 010
-- Ref: docs/design-recruiter-roles-20260925.md §3 (F10, decision #17 phase 1)
-- Note: SQLite dialect. Nullable, no CHECK (adding one requires a table rebuild on
--       SQLite); value domain is guaranteed by Zod and repository methods.
--       NULL = not declared; UTC ISO8601 = declaration moment. upsertFromProvider
--       never touches this column, and deleteUnclaimed filters declared rows out,
--       so re-login and the cleanup cron can never silently reset it. No index:
--       gates look the single logged-in account up by primary key.

ALTER TABLE accounts ADD COLUMN recruiter_declared_at TEXT;

-- DOWN BEGIN
ALTER TABLE accounts DROP COLUMN recruiter_declared_at;
-- DOWN END
