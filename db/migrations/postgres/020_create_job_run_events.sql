-- Migration 020: create job_run_events table for replayable run transitions
-- File: 020_create_job_run_events.sql
-- Date: 2026-10-03 09:40
-- Dialect: Postgres
-- Depends on: 019
-- Ref: docs/设计-求职Agent-20261002.md §5.3 (阶段 1 求职工作台)
-- Note: Postgres dialect. Column set and index names must match the SQLite
--       migration exactly (migrations-parity test). Append-only audit log of
--       job_runs transitions (design §5.2): the run row only keeps the current
--       state, this table keeps the replayable history. `event`/`actor` domains
--       are owned by JOB_RUN_EVENT_KINDS / JOB_RUN_ACTORS in packages/storage, no
--       CHECK constraint. from_status is nullable because the first event of a run
--       has no previous status. payload is a JSON object stored as TEXT. No
--       foreign keys; cascade delete is application-side.

CREATE TABLE IF NOT EXISTS job_run_events (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL,
  event       TEXT NOT NULL,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  actor       TEXT NOT NULL,
  payload     TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE job_run_events IS 'Append-only audit log of job_runs state transitions (design §5.2), replayable per run';
COMMENT ON COLUMN job_run_events.id IS 'event id (evt-<uuid>)';
COMMENT ON COLUMN job_run_events.run_id IS 'owning run (job_runs.id)';
COMMENT ON COLUMN job_run_events.event IS 'transition kind: validate|start|candidates_ready|generated|approve|reject|rescan|submitted|track|archive|fail|cancel (domain owned by JOB_RUN_EVENT_KINDS in @jobagent/shared)';
COMMENT ON COLUMN job_run_events.from_status IS 'status before the transition; NULL for the first event of a run';
COMMENT ON COLUMN job_run_events.to_status IS 'status after the transition';
COMMENT ON COLUMN job_run_events.actor IS 'who moved the run: user|agent|system';
COMMENT ON COLUMN job_run_events.payload IS 'JSON object: structured payload (counts, ids, reasons)';
COMMENT ON COLUMN job_run_events.created_at IS 'append time (UTC ISO8601)';

CREATE INDEX IF NOT EXISTS idx_jre_run
  ON job_run_events (run_id, created_at);

-- DOWN BEGIN
DROP INDEX IF EXISTS idx_jre_run;
DROP TABLE IF EXISTS job_run_events;
-- DOWN END
