-- Migration 028: add outcome feedback columns to applications
-- File: 028_add_application_outcome_feedback.sql
-- Date: 2026-10-04 05:10
-- Dialect: Postgres
-- Depends on: 022
-- Ref: docs/设计-求职Agent-20261002.md §5.3/§10.4 D1 (decision #20-3)
-- Note: Postgres dialect. Column set must match the SQLite migration exactly
--       (migrations-parity test). Stage-2 outcome write-back: no_response|
--       interview|offer|rejected; NULL = no feedback yet. D2 recalibration
--       stays OFF until >=20 rows carry an outcome and the user confirms.

ALTER TABLE applications ADD COLUMN IF NOT EXISTS outcome_feedback TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS outcome_feedback_at TEXT;

CREATE INDEX IF NOT EXISTS idx_applications_outcome
  ON applications (outcome_feedback);

COMMENT ON COLUMN applications.outcome_feedback IS 'recruiter outcome write-back for review: no_response|interview|offer|rejected; NULL until recorded (D1, decision #20-3)';
COMMENT ON COLUMN applications.outcome_feedback_at IS 'UTC ISO8601 timestamp of the outcome write-back';

-- DOWN BEGIN
DROP INDEX IF EXISTS idx_applications_outcome;
ALTER TABLE applications DROP COLUMN IF EXISTS outcome_feedback_at;
ALTER TABLE applications DROP COLUMN IF EXISTS outcome_feedback;
-- DOWN END
