-- Migration 042: add hub projection fields to llm_catalog_models
-- File: 042_add_llm_catalog_hub_projection.sql
-- Date: 2026-10-28 03:15
-- Dialect: SQLite
-- Depends on: 041
-- Ref: Tier0-model-hub接入记录.md (W5-1); docs/design-llm-model-provisioning-20261003.md
-- Note: SQLite dialect. The built-in catalog becomes a projection synced from
--       model-hub. source records where a row came from ('builtin' = local
--       admin/legacy, 'hub' = synced projection); revision is the hub catalog
--       revision; assignment_id is the hub assignment id (asn_*) the row was
--       issued from. Existing local rows are backfilled as builtin.

ALTER TABLE llm_catalog_models ADD COLUMN source TEXT NOT NULL DEFAULT 'builtin';
ALTER TABLE llm_catalog_models ADD COLUMN revision INTEGER;
ALTER TABLE llm_catalog_models ADD COLUMN assignment_id TEXT;

-- DOWN BEGIN
ALTER TABLE llm_catalog_models DROP COLUMN assignment_id;
ALTER TABLE llm_catalog_models DROP COLUMN revision;
ALTER TABLE llm_catalog_models DROP COLUMN source;
-- DOWN END
