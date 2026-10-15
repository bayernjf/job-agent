-- Migration 039: recruiter pipeline stage + append-only application event stream
-- File: 039_add_application_stage_and_events.sql
-- Date: 2026-10-14 15:00
-- Dialect: SQLite
-- Depends on: 038
-- Ref: docs/design-b3b-pipeline-state-machine-20261014.md
-- Note: SQLite dialect. applications.stage is the recruiter-side pipeline stage
--       (new|screening|interview|offer|hired|rejected, value domain owned by
--       APPLICATION_STAGES in @jobagent/storage; no CHECK -- see file Note of 020).
--       NULL = not in any recruiter pipeline (legacy rows, manual/external apps).
--       application_events is an append-only audit stream aligned with
--       job_run_events (migration 020): a stage transition is CAS'd on the
--       current stage and its event is written in the same transaction, so the
--       row only keeps the current state and this table keeps replayable history.

ALTER TABLE applications ADD COLUMN stage TEXT;

CREATE TABLE IF NOT EXISTS application_events (
  -- event id (evt-<uuid>)
  id             TEXT PRIMARY KEY,
  -- owning application (applications.id)
  application_id TEXT NOT NULL,
  -- transition kind: stage_change (single kind this batch; reserved for extension)
  event          TEXT NOT NULL,
  -- stage before the transition; null for the first advance of an application
  from_stage     TEXT,
  -- stage after the transition
  to_stage       TEXT NOT NULL,
  -- who moved the stage: user|recruiter|system
  actor          TEXT NOT NULL,
  -- JSON object: structured payload ({ note?, postingId })
  payload        TEXT NOT NULL DEFAULT '{}',
  -- append time (UTC ISO8601)
  created_at     TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

-- event stream for one application, oldest first
CREATE INDEX IF NOT EXISTS idx_app_evt_application ON application_events (application_id, created_at);

-- B3-b 读侧：招聘方按自建岗位列投递（GET /job-postings/recruiter/:id/applications）
CREATE INDEX IF NOT EXISTS idx_applications_job ON applications (job_id);

-- DOWN BEGIN
DROP INDEX IF EXISTS idx_applications_job;
DROP INDEX IF EXISTS idx_app_evt_application;
DROP TABLE IF EXISTS application_events;
ALTER TABLE applications DROP COLUMN stage;
-- DOWN END
