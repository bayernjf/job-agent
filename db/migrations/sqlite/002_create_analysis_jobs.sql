-- Migration 002: create analysis_jobs table for async analysis task queue
-- File: 002_create_analysis_jobs.sql
-- Date: 2026-09-11 16:20
-- Ref: 技术选型-MVP 6.6「异步任务：数据库任务表 + Worker」/ AGENTS.md「迁移规范」
-- Note: SQLite dialect for MVP (inline comments for column meanings; Postgres COMMENT ON
--       adaptation tracked in docs/deferred-items.md). Worker polls/claims queued jobs,
--       no Redis in MVP. Status machine: queued -> running -> succeeded | failed.

CREATE TABLE IF NOT EXISTS analysis_jobs (
  -- jobId, generated when API receives a username; immutable
  id              TEXT PRIMARY KEY,
  -- evidence source platform: 'github' (P1: gitee / portfolio)
  subject_platform TEXT NOT NULL DEFAULT 'github',
  -- GitHub login of the subject to analyze
  subject_login    TEXT NOT NULL,
  -- job status: 'queued' | 'running' | 'succeeded' | 'failed'
  status           TEXT NOT NULL DEFAULT 'queued',
  -- current progress stage: 'L0' | 'L1' | 'complete' | null (queued/failed)
  stage            TEXT,
  -- number of attempts (worker claims + runs; failed jobs may be retried)
  attempts         INTEGER NOT NULL DEFAULT 0,
  -- associated profile id after successful analysis (FK -> profiles.id, not enforced)
  profile_id       TEXT,
  -- error message if status = 'failed'
  error_message    TEXT,
  -- budget used for this job, JSON object e.g. {"graphqlPoints": 42, "restCalls": 3}
  budget_used      TEXT,
  -- missing data layers, JSON array e.g. '["pull_requests","commits:some-org/repo"]'
  missing          TEXT,
  -- worker id / hostname that claimed this job (for debugging multi-worker)
  claimed_by       TEXT,
  -- created at (UTC ISO8601)
  created_at       TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  -- last updated at (UTC ISO8601)
  updated_at       TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  -- started at (UTC ISO8601), set when worker claims the job
  started_at       TEXT,
  -- finished at (UTC ISO8601), set when job succeeds or fails
  finished_at      TEXT
);

-- worker claim index: find oldest queued jobs
CREATE INDEX IF NOT EXISTS idx_analysis_jobs_status_created
  ON analysis_jobs (status, created_at ASC);

-- look up a subject's recent jobs (for dedup / status display)
CREATE INDEX IF NOT EXISTS idx_analysis_jobs_subject_created
  ON analysis_jobs (subject_platform, subject_login, created_at DESC);

-- DOWN BEGIN
DROP TABLE IF EXISTS analysis_jobs;
-- DOWN END
