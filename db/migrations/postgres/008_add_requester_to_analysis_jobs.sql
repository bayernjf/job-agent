-- Migration 008: add requester columns to analysis_jobs for demo mode
-- File: 008_add_requester_to_analysis_jobs.sql
-- Date: 2026-09-15 19:00
-- Dialect: Postgres
-- Depends on: 002, 006
-- Ref: docs/design-demo-mode-20260915.md §5/§8
-- Note: Postgres dialect. Idempotent ADD COLUMN IF NOT EXISTS. Historical/CLI
--       rows stay 'public' via a constant default. No hard FK (sessions may be purged).

ALTER TABLE analysis_jobs ADD COLUMN IF NOT EXISTS requester_kind TEXT NOT NULL DEFAULT 'public';
ALTER TABLE analysis_jobs ADD COLUMN IF NOT EXISTS demo_session_id TEXT;

COMMENT ON COLUMN analysis_jobs.requester_kind IS 'requester class: public (CLI/anonymous-era default) | demo | user(reserved)';
COMMENT ON COLUMN analysis_jobs.demo_session_id IS 'owning demo session id when requester_kind=demo, null otherwise';

CREATE INDEX IF NOT EXISTS idx_analysis_jobs_requester_status
  ON analysis_jobs (requester_kind, status);
CREATE INDEX IF NOT EXISTS idx_analysis_jobs_demo_session
  ON analysis_jobs (demo_session_id);

-- DOWN BEGIN
DROP INDEX IF EXISTS idx_analysis_jobs_demo_session;
DROP INDEX IF EXISTS idx_analysis_jobs_requester_status;
ALTER TABLE analysis_jobs DROP COLUMN IF EXISTS demo_session_id;
ALTER TABLE analysis_jobs DROP COLUMN IF EXISTS requester_kind;
-- DOWN END
