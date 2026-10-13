-- Migration 036: add account ownership to job_postings for recruiter-published JDs
-- File: 036_add_job_postings_recruiter_ownership.sql
-- Date: 2026-10-13 19:05
-- Depends on: 005, 010, 035
-- Ref: docs/design-b-side-full-loop-20261007.md §3 B3-a, decision #25 (adopted 2026-10-13)
-- Note: SQLite dialect. A declared recruiter can publish their own job description so
--       the recruiter side can rank candidates against that JD instead of only browsing
--       the accumulated pool. The private row must never enter the public pool that C-side
--       consumers read, so the discriminator is this ownership column (NULL = pool row from
--       aggregation or websearch), NOT the `source` value — every pool read, per-source
--       count and markStale sweep now filters `created_by_account_id IS NULL` inside the
--       repository. Nullable on purpose: no pre-existing row has an author. Index supports
--       "list my postings" scoped by status.

ALTER TABLE job_postings ADD COLUMN created_by_account_id TEXT;

CREATE INDEX IF NOT EXISTS idx_job_postings_created_by
  ON job_postings (created_by_account_id, status);

-- DOWN BEGIN
DROP INDEX IF EXISTS idx_job_postings_created_by;
ALTER TABLE job_postings DROP COLUMN created_by_account_id;
-- DOWN END
