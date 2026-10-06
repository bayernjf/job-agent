-- Migration 030: add last_viewed_at to job_runs for unread candidate batching
-- File: 030_add_job_run_last_viewed_at.sql
-- Date: 2026-10-06 12:48
-- Dialect: Postgres
-- Depends on: 019
-- Ref: docs/设计-求职Agent-20261002.md §5.2 (workbench attention signal)
-- Note: Postgres dialect. Column must match the SQLite migration exactly
--       (migrations-parity test). Stamped by an explicit view endpoint when the
--       owner opens a run awaiting approval; never drives the state machine and
--       never bumps updated_at.

ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS last_viewed_at TEXT;

COMMENT ON COLUMN job_runs.last_viewed_at IS 'UTC ISO8601 timestamp the owner last viewed the run; a candidate batch is unseen while status=awaiting_approval and this is older than updated_at (or NULL)';

-- DOWN BEGIN
ALTER TABLE job_runs DROP COLUMN IF EXISTS last_viewed_at;
-- DOWN END
