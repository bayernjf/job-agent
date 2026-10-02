-- Migration 022: add submit_intent_id to applications
-- File: 022_add_application_submit_intent.sql
-- Date: 2026-10-03 10:10
-- Dialect: Postgres
-- Depends on: 021
-- Ref: docs/设计-求职Agent-20261002.md §5.3 (阶段 1 求职工作台)
-- Note: Postgres dialect. Column name and type must match the SQLite migration
--       exactly (migrations-parity test); TEXT stays TEXT per dual-dialect
--       convention. Links a tracked application back to the submit ticket that
--       produced it (submit_intents.id, migration 021). Nullable: rows written
--       before this migration, and manual/report/extension rows, have no ticket.
--       No index (lookups go ticket -> application) and no FK. ADD COLUMN IF NOT
--       EXISTS keeps the file idempotent. The origin comment is refreshed here
--       because 'agent' became an accepted value with this work and 009 is
--       append-only (never rewritten).

ALTER TABLE applications ADD COLUMN IF NOT EXISTS submit_intent_id TEXT;

COMMENT ON COLUMN applications.submit_intent_id IS 'submit_intents.id of the ticket that produced this application; NULL for manual/report/extension rows';
COMMENT ON COLUMN applications.origin IS 'creation channel: manual|report|extension|agent';

-- DOWN BEGIN
ALTER TABLE applications DROP COLUMN IF EXISTS submit_intent_id;
-- DOWN END
