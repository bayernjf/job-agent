-- Migration 002: create analysis_jobs table for async analysis task queue
-- File: 002_create_analysis_jobs.sql
-- Date: 2026-09-11 19:55
-- Dialect: Postgres
-- Ref: 技术选型-MVP 6.6「异步任务：数据库任务表 + Worker」/ AGENTS.md「迁移规范」
-- Note: Postgres dialect. Worker polls/claims queued jobs, no Redis in MVP.
--       Status machine: queued -> running -> succeeded | failed.

CREATE TABLE IF NOT EXISTS analysis_jobs (
  id               TEXT PRIMARY KEY,
  subject_platform TEXT NOT NULL DEFAULT 'github',
  subject_login    TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'queued',
  stage            TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0,
  profile_id       TEXT,
  error_message    TEXT,
  budget_used      TEXT,
  missing          TEXT,
  claimed_by       TEXT,
  created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at       TEXT,
  finished_at      TEXT
);

COMMENT ON TABLE analysis_jobs IS 'Async analysis task queue consumed by the worker';
COMMENT ON COLUMN analysis_jobs.id IS 'jobId, generated when API receives a username; immutable';
COMMENT ON COLUMN analysis_jobs.subject_platform IS 'evidence source platform: github';
COMMENT ON COLUMN analysis_jobs.subject_login IS 'login of the subject to analyze';
COMMENT ON COLUMN analysis_jobs.status IS 'queued | running | succeeded | failed';
COMMENT ON COLUMN analysis_jobs.stage IS 'L0 | L1 | complete | null (queued/failed)';
COMMENT ON COLUMN analysis_jobs.attempts IS 'claim/run attempts; jobs are not retried past the limit';
COMMENT ON COLUMN analysis_jobs.profile_id IS 'associated profile id after success (FK not enforced)';
COMMENT ON COLUMN analysis_jobs.error_message IS 'error message when status = failed';
COMMENT ON COLUMN analysis_jobs.budget_used IS 'budget used, JSON object e.g. {"graphqlPoints":42}';
COMMENT ON COLUMN analysis_jobs.missing IS 'missing data layers, JSON array';
COMMENT ON COLUMN analysis_jobs.claimed_by IS 'worker id / hostname that claimed the job';
COMMENT ON COLUMN analysis_jobs.created_at IS 'created at, UTC ISO8601';
COMMENT ON COLUMN analysis_jobs.updated_at IS 'last updated at, UTC ISO8601';
COMMENT ON COLUMN analysis_jobs.started_at IS 'started at, set when a worker claims the job';
COMMENT ON COLUMN analysis_jobs.finished_at IS 'finished at, set when the job succeeds or fails';

-- worker claim index: find oldest queued jobs
CREATE INDEX IF NOT EXISTS idx_analysis_jobs_status_created
  ON analysis_jobs (status, created_at ASC);

-- look up a subject's recent jobs (dedup / status display)
CREATE INDEX IF NOT EXISTS idx_analysis_jobs_subject_created
  ON analysis_jobs (subject_platform, subject_login, created_at DESC);

-- DOWN BEGIN
DROP TABLE IF EXISTS analysis_jobs;
-- DOWN END
