-- Migration 022: add submit_intent_id to applications
-- File: 022_add_application_submit_intent.sql
-- Date: 2026-10-03 10:10
-- Depends on: 021
-- Ref: docs/设计-求职Agent-20261002.md §5.3 (阶段 1 求职工作台)
-- Note: SQLite dialect. Links a tracked application back to the submit ticket
--       that produced it (submit_intents.id, migration 021). Nullable: every row
--       written before this migration, and every manual/report/extension row,
--       legitimately has no ticket. No index: lookups go the other way (from the
--       ticket to its application). No FK, consistent with the rest of the
--       schema. SQLite has no ADD COLUMN IF NOT EXISTS, so this statement is not
--       idempotent by itself; the migrator records the version, which is what
--       keeps a re-run from executing it twice.

ALTER TABLE applications ADD COLUMN submit_intent_id TEXT;

-- DOWN BEGIN
ALTER TABLE applications DROP COLUMN submit_intent_id;
-- DOWN END
