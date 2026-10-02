-- Migration 019: create job_runs table for the job-search run state machine
-- File: 019_create_job_runs.sql
-- Date: 2026-10-03 09:25
-- Dialect: Postgres
-- Depends on: 018
-- Ref: docs/设计-求职Agent-20261002.md §5.3 (阶段 1 求职工作台)
-- Note: Postgres dialect. Column set and index names must match the SQLite
--       migration exactly (migrations-parity test). One row = one run instance of
--       the state machine in design §5.2; every transition also appends a row to
--       job_run_events (020) so the run can be replayed. No CHECK constraint on
--       `status` (value domain owned by JOB_RUN_STATUSES_DB in packages/storage).
--       last_scan_at is nullable on purpose: it is the scheduler cursor for
--       "never scanned yet" (queries order NULLS FIRST explicitly, because
--       Postgres sorts NULLs last on ASC); last_error carries an explicit failure
--       reason. No foreign keys; cascade delete is application-side.

CREATE TABLE IF NOT EXISTS job_runs (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL,
  profile_id    TEXT NOT NULL,
  preference_id TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'created',
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  last_scan_at  TEXT,
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE job_runs IS 'Job-search run instances of the design §5.2 state machine; transitions are replayed via job_run_events';
COMMENT ON COLUMN job_runs.id IS 'run id (run-<uuid>)';
COMMENT ON COLUMN job_runs.account_id IS 'owning account (accounts.id)';
COMMENT ON COLUMN job_runs.profile_id IS 'profile snapshot the run scores against (profiles.id)';
COMMENT ON COLUMN job_runs.preference_id IS 'bound preference set (job_preferences.id)';
COMMENT ON COLUMN job_runs.status IS 'run state machine: created|configured|watching|recommending|awaiting_approval|submitting|submitted|tracking|archived|cancelled|failed';
COMMENT ON COLUMN job_runs.attempts IS 'attempts spent in the current scan round';
COMMENT ON COLUMN job_runs.last_error IS 'explicit failure reason; NULL when healthy';
COMMENT ON COLUMN job_runs.last_scan_at IS 'last completed scan time (UTC ISO8601), NULL = never scanned (scheduler cursor, ordered NULLS FIRST)';
COMMENT ON COLUMN job_runs.created_at IS 'row created at (UTC ISO8601)';
COMMENT ON COLUMN job_runs.updated_at IS 'row last updated at (UTC ISO8601)';

CREATE INDEX IF NOT EXISTS idx_jr_status
  ON job_runs (status, last_scan_at);

CREATE INDEX IF NOT EXISTS idx_jr_account
  ON job_runs (account_id, created_at);

-- DOWN BEGIN
DROP INDEX IF EXISTS idx_jr_account;
DROP INDEX IF EXISTS idx_jr_status;
DROP TABLE IF EXISTS job_runs;
-- DOWN END
