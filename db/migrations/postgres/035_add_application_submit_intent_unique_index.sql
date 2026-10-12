-- Migration 035: one agent-generated application per submit intent
-- File: 035_add_application_submit_intent_unique_index.sql
-- Date: 2026-10-13 16:00
-- Dialect: Postgres
-- Depends on: 034
-- Ref: docs/设计-求职Agent-20261002.md §10 (mark-submitted idempotency)
-- Note: Postgres dialect. Column set is unchanged; index semantics must match
--       the SQLite migration exactly. The mark-submitted route used to INSERT
--       the application before the submit_intents CAS; a crash or retry in
--       that window could leave two applications for one intent. Remove such
--       historical duplicates first (keep the earliest row by created_at,
--       tie-break id), then add the partial unique index. Rows with NULL
--       submit_intent_id (manual/report/extension) stay unconstrained.

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

COMMENT ON INDEX idx_applications_submit_intent_unique IS 'One agent-generated application per submit intent (035). Partial index: manual/report/extension rows keep NULL submit_intent_id and are excluded.';

-- DOWN BEGIN
DROP INDEX IF EXISTS idx_applications_submit_intent_unique;
-- DOWN END
