-- Migration 037: link interviews to a recruiter-published posting
-- File: 037_add_interviews_posting_id.sql
-- Date: 2026-10-13 19:41
-- Dialect: Postgres
-- Depends on: 012, 036
-- Ref: docs/design-b-side-full-loop-20261007.md §3 (B3-a follow-up), decision #25 (adopted 2026-10-13)
-- Note: Postgres dialect. Column set must match the SQLite migration exactly
--       (migrations-parity test). Links an interview to the recruiter's own published JD
--       (job_postings.id, source='recruiter'), so a posting can answer "who is in my
--       pipeline for this role". Nullable on purpose: pre-existing interviews and interviews
--       for roles not published here stay NULL. Carries NO pipeline state — stage/event
--       tables stay deferred, and applications keep belonging to the candidate.

ALTER TABLE interviews ADD COLUMN IF NOT EXISTS posting_id TEXT;

CREATE INDEX IF NOT EXISTS idx_interviews_posting
  ON interviews (posting_id);

COMMENT ON COLUMN interviews.posting_id IS 'job_postings.id of the recruiter-published JD this interview belongs to; NULL when unrelated to a published posting';

-- DOWN BEGIN
DROP INDEX IF EXISTS idx_interviews_posting;
ALTER TABLE interviews DROP COLUMN IF EXISTS posting_id;
-- DOWN END
