-- Migration 037: link interviews to a recruiter-published posting
-- File: 037_add_interviews_posting_id.sql
-- Date: 2026-10-13 19:41
-- Dialect: SQLite
-- Depends on: 012, 036
-- Ref: docs/design-b-side-full-loop-20261007.md §3 (B3-a follow-up), decision #25 (adopted 2026-10-13)
-- Note: SQLite dialect. Closes the gap the first B-side slice left open: a published JD and
--       the interviews it produced carried no relation (interviews only held the denormalized
--       target_title/target_company text), so a posting could not answer "who is in my pipeline
--       for this role". Nullable on purpose — interviews predating the account/publishing path,
--       and interviews scheduled against a role not published here, stay NULL. This column
--       carries NO pipeline state: applications keep belonging to the candidate (2026-10-08
--       walkthrough decision) and the stage event table stays deferred until a real recruiter
--       asks for it. No foreign key: dual-dialect convention keeps these columns plain TEXT.

ALTER TABLE interviews ADD COLUMN posting_id TEXT;

CREATE INDEX IF NOT EXISTS idx_interviews_posting
  ON interviews (posting_id);

-- DOWN BEGIN
DROP INDEX IF EXISTS idx_interviews_posting;
ALTER TABLE interviews DROP COLUMN posting_id;
-- DOWN END
