-- Migration 035: one agent-generated application per submit intent
-- File: 035_add_application_submit_intent_unique_index.sql
-- Date: 2026-10-13 16:00
-- Dialect: SQLite
-- Depends on: 034
-- Ref: docs/设计-求职Agent-20261002.md §10 (mark-submitted idempotency)
-- Note: SQLite dialect. The mark-submitted route used to INSERT the application
--       before the submit_intents CAS; a crash or retry in that window could
--       leave two applications for one intent. Remove such historical
--       duplicates first (keep the earliest row by created_at, tie-break id),
--       then add the partial unique index. Rows with NULL submit_intent_id
--       (manual/report/extension) are excluded by the WHERE clause.

DELETE FROM applications
WHERE submit_intent_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM applications AS b
    WHERE b.submit_intent_id = applications.submit_intent_id
      AND (
        b.created_at < applications.created_at
        OR (b.created_at = applications.created_at AND b.id < applications.id)
      )
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_applications_submit_intent_unique
  ON applications (submit_intent_id)
  WHERE submit_intent_id IS NOT NULL;

-- DOWN BEGIN
DROP INDEX IF EXISTS idx_applications_submit_intent_unique;
-- DOWN END
