-- Migration 019: create job_runs table for the job-search run state machine
-- File: 019_create_job_runs.sql
-- Date: 2026-10-03 09:25
-- Depends on: 018
-- Ref: docs/设计-求职Agent-20261002.md §5.3 (阶段 1 求职工作台)
-- Note: SQLite dialect. One row = one run instance of the state machine in design
--       §5.2 (created -> configured -> watching -> recommending ->
--       awaiting_approval -> ...); every transition also appends a row to
--       job_run_events (020) so the run can be replayed. `status` has no CHECK
--       constraint (would force a table rebuild on SQLite); the value domain is
--       guaranteed by JOB_RUN_STATUSES_DB in packages/storage. last_scan_at is
--       nullable on purpose: it is the scheduler cursor for "never scanned yet"
--       (NULL sorts first), while last_error carries an explicit failure reason
--       so a failed run is never mistaken for a successful one. No foreign keys;
--       cascade delete is application-side.

CREATE TABLE IF NOT EXISTS job_runs (
  -- run id (run-<uuid>)
  id            TEXT PRIMARY KEY,
  -- owning account (accounts.id)
  account_id    TEXT NOT NULL,
  -- profile snapshot the run scores against (profiles.id)
  profile_id    TEXT NOT NULL,
  -- bound preference set (job_preferences.id)
  preference_id TEXT NOT NULL,
  -- run state machine: created|configured|watching|recommending|awaiting_approval|submitting|submitted|tracking|archived|cancelled|failed
  status        TEXT NOT NULL DEFAULT 'created',
  -- attempts spent in the current scan round
  attempts      INTEGER NOT NULL DEFAULT 0,
  -- explicit failure reason; null when healthy
  last_error    TEXT,
  -- last completed scan time (UTC ISO8601), null = never scanned
  last_scan_at  TEXT,
  -- row created at (UTC ISO8601)
  created_at    TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  -- row last updated at (UTC ISO8601)
  updated_at    TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

-- scheduler queue: pick the oldest run per status (NULL last_scan_at first)
CREATE INDEX IF NOT EXISTS idx_jr_status
  ON job_runs (status, last_scan_at);

-- list one account's runs, newest first
CREATE INDEX IF NOT EXISTS idx_jr_account
  ON job_runs (account_id, created_at);

-- DOWN BEGIN
DROP INDEX IF EXISTS idx_jr_account;
DROP INDEX IF EXISTS idx_jr_status;
DROP TABLE IF EXISTS job_runs;
-- DOWN END
