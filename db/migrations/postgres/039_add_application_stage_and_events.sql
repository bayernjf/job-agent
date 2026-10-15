-- Migration 039: recruiter pipeline stage + append-only application event stream
-- File: 039_add_application_stage_and_events.sql
-- Date: 2026-10-14 15:00
-- Dialect: Postgres
-- Depends on: 038
-- Ref: docs/design-b3b-pipeline-state-machine-20261014.md
-- Note: Postgres dialect. Columns must match the SQLite migration exactly
--       (migrations-parity test). applications.stage is the recruiter-side
--       pipeline stage (new|screening|interview|offer|hired|rejected, domain
--       owned by APPLICATION_STAGES in @jobagent/storage); NULL = not in any
--       recruiter pipeline. application_events is an append-only audit stream
--       aligned with job_run_events (migration 020): CAS + same-transaction
--       event insert.

ALTER TABLE applications ADD COLUMN IF NOT EXISTS stage TEXT;

COMMENT ON COLUMN applications.stage IS 'Recruiter-side pipeline stage (new|screening|interview|offer|hired|rejected); NULL = not in any recruiter pipeline';

CREATE TABLE IF NOT EXISTS application_events (
  id             TEXT PRIMARY KEY,
  application_id TEXT NOT NULL,
  event          TEXT NOT NULL,
  from_stage     TEXT,
  to_stage       TEXT NOT NULL,
  actor          TEXT NOT NULL,
  payload        TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX IF NOT EXISTS idx_app_evt_application ON application_events (application_id, created_at);

-- B3-b 读侧：招聘方按自建岗位列投递（GET /job-postings/recruiter/:id/applications）
CREATE INDEX IF NOT EXISTS idx_applications_job ON applications (job_id);

-- DOWN BEGIN
DROP INDEX IF EXISTS idx_applications_job;
DROP INDEX IF EXISTS idx_app_evt_application;
DROP TABLE IF EXISTS application_events;
ALTER TABLE applications DROP COLUMN IF EXISTS stage;
-- DOWN END
