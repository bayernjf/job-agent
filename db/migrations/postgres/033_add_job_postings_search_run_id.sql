-- Migration 033: add search_run_id to job_postings for per-run result lookup
-- File: 033_add_job_postings_search_run_id.sql
-- Date: 2026-10-08 00:20
-- Dialect: Postgres
-- Depends on: 032
-- Ref: docs/design-websearch-job-discovery-20261008.md (§4 GET /agent/search/:id/results)
-- Note: Postgres dialect. Column set must match the SQLite migration exactly
--       (migrations-parity test). Links websearch-inserted job_postings rows to
--       their originating search_run; NULL for all non-websearch rows.

ALTER TABLE job_postings ADD COLUMN search_run_id TEXT;

CREATE INDEX IF NOT EXISTS idx_job_postings_search_run
  ON job_postings (search_run_id);

COMMENT ON COLUMN job_postings.search_run_id IS 'Originating websearch run (search_runs.run_id); NULL for non-websearch rows';

-- DOWN BEGIN
DROP INDEX IF EXISTS idx_job_postings_search_run;
ALTER TABLE job_postings DROP COLUMN search_run_id;
-- DOWN END
