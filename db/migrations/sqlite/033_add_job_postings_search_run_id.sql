-- Migration 033: add search_run_id to job_postings for per-run result lookup
-- File: 033_add_job_postings_search_run_id.sql
-- Date: 2026-10-08 00:20
-- Dialect: SQLite
-- Depends on: 032
-- Ref: docs/design-websearch-job-discovery-20261008.md (§4 GET /agent/search/:id/results)
-- Note: SQLite dialect. Links job_postings rows inserted by a websearch run back
--       to that search_run, so the results endpoint can return exactly what one
--       user-initiated search produced (not a time-window approximation).
--       NULL for all non-websearch rows. SQLite has no ADD COLUMN IF NOT EXISTS;
--       the migrator version record prevents re-execution.

ALTER TABLE job_postings ADD COLUMN search_run_id TEXT;

CREATE INDEX IF NOT EXISTS idx_job_postings_search_run
  ON job_postings (search_run_id);

-- DOWN BEGIN
DROP INDEX IF EXISTS idx_job_postings_search_run;
ALTER TABLE job_postings DROP COLUMN search_run_id;
-- DOWN END
