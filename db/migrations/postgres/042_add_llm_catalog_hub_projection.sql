-- Migration 042: add hub projection fields to llm_catalog_models
-- File: 042_add_llm_catalog_hub_projection.sql
-- Date: 2026-10-28 03:15
-- Dialect: Postgres
-- Depends on: 041
-- Ref: Tier0-model-hub接入记录.md (W5-1); docs/design-llm-model-provisioning-20261003.md
-- Note: Postgres dialect. Same change as the SQLite migration (column set must
--       match, migrations-parity test). The built-in catalog becomes a
--       projection synced from model-hub: source ('builtin' | 'hub'),
--       revision (hub catalog revision), assignment_id (hub asn_* id).

ALTER TABLE llm_catalog_models ADD COLUMN source TEXT NOT NULL DEFAULT 'builtin';
ALTER TABLE llm_catalog_models ADD COLUMN revision INTEGER;
ALTER TABLE llm_catalog_models ADD COLUMN assignment_id TEXT;

COMMENT ON COLUMN llm_catalog_models.source IS 'origin of the row: builtin (local admin/legacy) or hub (synced projection)';
COMMENT ON COLUMN llm_catalog_models.revision IS 'model-hub catalog revision the row was synced at; null for local rows';
COMMENT ON COLUMN llm_catalog_models.assignment_id IS 'model-hub assignment id (asn_*) the row was issued from; null for local rows';

-- DOWN BEGIN
ALTER TABLE llm_catalog_models DROP COLUMN assignment_id;
ALTER TABLE llm_catalog_models DROP COLUMN revision;
ALTER TABLE llm_catalog_models DROP COLUMN source;
-- DOWN END
