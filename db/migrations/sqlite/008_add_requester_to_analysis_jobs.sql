-- Migration 008: add requester columns to analysis_jobs for demo mode
-- File: 008_add_requester_to_analysis_jobs.sql
-- Date: 2026-09-15 19:00
-- Depends on: 002, 006
-- Ref: docs/design-demo-mode-20260915.md §5/§8
-- Note: SQLite dialect. Historical/CLI rows stay 'public' via a constant default,
--       so existing behaviour is unchanged. ADD COLUMN with a constant NOT NULL
--       DEFAULT is valid in SQLite. No hard FK (sessions may be purged).

-- requester identity class: public (CLI/anonymous-era default) | demo | user(reserved)
ALTER TABLE analysis_jobs ADD COLUMN requester_kind TEXT NOT NULL DEFAULT 'public';
-- owning demo session id when requester_kind='demo'; null otherwise
ALTER TABLE analysis_jobs ADD COLUMN demo_session_id TEXT;

-- worker priority ordering (formal first) and demo concurrency count
CREATE INDEX IF NOT EXISTS idx_analysis_jobs_requester_status
  ON analysis_jobs (requester_kind, status);
-- scope "jobs created by this demo session"
CREATE INDEX IF NOT EXISTS idx_analysis_jobs_demo_session
  ON analysis_jobs (demo_session_id);

-- DOWN BEGIN
-- SQLite refuses DROP COLUMN on a column referenced by an index, so drop the
-- two indexes first. SQLite 3.35+ supports DROP COLUMN (bundled better-sqlite3);
-- executed at most once during rollback.
DROP INDEX IF EXISTS idx_analysis_jobs_demo_session;
DROP INDEX IF EXISTS idx_analysis_jobs_requester_status;
ALTER TABLE analysis_jobs DROP COLUMN demo_session_id;
ALTER TABLE analysis_jobs DROP COLUMN requester_kind;
-- DOWN END
