-- Migration 024: create llm_catalog_models table (built-in model catalog)
-- File: 024_create_llm_catalog_models.sql
-- Date: 2026-10-03 09:00
-- Dialect: Postgres
-- Depends on: 023
-- Ref: docs/design-llm-model-provisioning-20261003.md §4.2 (内置目录)
-- Note: Postgres dialect. Column set and index names must match the SQLite
--       migration exactly (migrations-parity test). One row = one built-in model
--       managed through the admin UI. White-list invariant: admin data can only
--       override columns in this table; baseUrl/apiKey stay env-only. No foreign
--       keys; timestamps TEXT UTC ISO8601; booleans BOOLEAN; modalities TEXT JSON.

CREATE TABLE IF NOT EXISTS llm_catalog_models (
  id          TEXT PRIMARY KEY,
  provider    TEXT NOT NULL,
  model       TEXT NOT NULL,
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  is_default  BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  modalities  TEXT NOT NULL DEFAULT '["text"]',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

COMMENT ON TABLE llm_catalog_models IS 'Built-in LLM model catalog managed via admin UI (decision #21-0; white-list invariant: baseUrl/apiKey stay env-only)';
COMMENT ON COLUMN llm_catalog_models.id IS 'catalog id, e.g. agnes-2.5-flash';
COMMENT ON COLUMN llm_catalog_models.provider IS 'provenance identifier, e.g. agnes';
COMMENT ON COLUMN llm_catalog_models.model IS 'model id sent in the request';
COMMENT ON COLUMN llm_catalog_models.enabled IS 'false = retired: requests fail loudly, no silent fallback';
COMMENT ON COLUMN llm_catalog_models.is_default IS 'per-modality default (enforced by the admin surface)';
COMMENT ON COLUMN llm_catalog_models.sort_order IS 'display order, ascending';
COMMENT ON COLUMN llm_catalog_models.modalities IS 'TEXT JSON array of modalities, e.g. ["text"]';
COMMENT ON COLUMN llm_catalog_models.created_at IS 'row created at (UTC ISO8601)';
COMMENT ON COLUMN llm_catalog_models.updated_at IS 'row last updated at (UTC ISO8601)';

-- DOWN BEGIN
DROP TABLE IF EXISTS llm_catalog_models;
-- DOWN END
