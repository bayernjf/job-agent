-- Migration 020: create job_run_events table for replayable run transitions
-- File: 020_create_job_run_events.sql
-- Date: 2026-10-03 09:40
-- Depends on: 019
-- Ref: docs/设计-求职Agent-20261002.md §5.3 (阶段 1 求职工作台)
-- Note: SQLite dialect. Append-only audit log of job_runs transitions (design
--       §5.2): the run row only keeps the current state, this table keeps the
--       replayable history (event, from/to status, actor, structured payload).
--       The first event of a run has no previous status, so from_status is
--       nullable. payload is a JSON object stored as TEXT and coerces to {} when
--       absent. No foreign keys; cascade delete is application-side.

CREATE TABLE IF NOT EXISTS job_run_events (
  -- event id (evt-<uuid>)
  id          TEXT PRIMARY KEY,
  -- owning run (job_runs.id)
  run_id      TEXT NOT NULL,
  -- transition kind: validate|start|candidates_ready|generated|approve|reject|rescan|submitted|track|archive|fail|cancel
  -- (value domain owned by JOB_RUN_EVENT_KINDS in @jobagent/shared; no CHECK — see file Note)
  event       TEXT NOT NULL,
  -- status before the transition; null for the first event of a run
  from_status TEXT,
  -- status after the transition
  to_status   TEXT NOT NULL,
  -- who moved the run: user|agent|system
  actor       TEXT NOT NULL,
  -- JSON object: structured payload (counts, ids, reasons)
  payload     TEXT NOT NULL DEFAULT '{}',
  -- append time (UTC ISO8601)
  created_at  TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

-- event stream for one run, oldest first
CREATE INDEX IF NOT EXISTS idx_jre_run
  ON job_run_events (run_id, created_at);

-- DOWN BEGIN
DROP INDEX IF EXISTS idx_jre_run;
DROP TABLE IF EXISTS job_run_events;
-- DOWN END
