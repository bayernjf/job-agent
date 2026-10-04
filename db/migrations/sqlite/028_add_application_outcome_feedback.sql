-- Migration 028: add outcome feedback columns to applications
-- File: 028_add_application_outcome_feedback.sql
-- Date: 2026-10-04 05:10
-- Depends on: 022
-- Ref: docs/设计-求职Agent-20261002.md §5.3/§10.4 D1 (decision #20-3)
-- Note: SQLite dialect. Stage-2 semi-automatic submission writes the recruiter
--       outcome back onto the application row: no_response|interview|offer|
--       rejected. NULL means no feedback recorded yet. D2 weight recalibration
--       stays OFF until at least 20 rows carry an outcome and the user confirms.
--       SQLite has no ADD COLUMN IF NOT EXISTS; the migrator version record
--       prevents re-execution.

ALTER TABLE applications ADD COLUMN outcome_feedback TEXT;
ALTER TABLE applications ADD COLUMN outcome_feedback_at TEXT;

CREATE INDEX IF NOT EXISTS idx_applications_outcome
  ON applications (outcome_feedback);

-- DOWN BEGIN
DROP INDEX IF EXISTS idx_applications_outcome;
ALTER TABLE applications DROP COLUMN outcome_feedback_at;
ALTER TABLE applications DROP COLUMN outcome_feedback;
-- DOWN END
