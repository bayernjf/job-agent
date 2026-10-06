-- Migration 030: add last_viewed_at to job_runs for unread candidate batching
-- File: 030_add_job_run_last_viewed_at.sql
-- Date: 2026-10-06 12:48
-- Depends on: 019
-- Ref: docs/设计-求职Agent-20261002.md §5.2 (workbench attention signal)
-- Note: SQLite dialect. The cron agent lands a new candidate batch by moving a
--       run into awaiting_approval, but the user only learns that by opening the
--       workbench. last_viewed_at records when the owner last looked at the run;
--       an unseen batch is awaiting_approval with last_viewed_at older than the
--       state change (or never viewed). It is stamped by an explicit view
--       endpoint and never drives the state machine. Viewing does not bump
--       updated_at. SQLite has no ADD COLUMN IF NOT EXISTS; the migrator
--       version record prevents re-execution.

ALTER TABLE job_runs ADD COLUMN last_viewed_at TEXT;

-- DOWN BEGIN
ALTER TABLE job_runs DROP COLUMN last_viewed_at;
-- DOWN END
