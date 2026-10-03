-- Migration 024: create llm_catalog_models table (built-in model catalog)
-- File: 024_create_llm_catalog_models.sql
-- Date: 2026-10-03 09:00
-- Depends on: 023
-- Ref: docs/design-llm-model-provisioning-20261003.md §4.2 (内置目录)
-- Note: SQLite dialect. One row = one built-in model managed through the admin
--       UI (decision #21-0, agent-world model-catalog alignment). White-list
--       invariant: only the columns in this table can be overridden by admin
--       data; baseUrl/apiKey never live here (they stay env-only). No foreign
--       keys anywhere in this schema; timestamps are TEXT UTC ISO8601; booleans
--       are INTEGER 0/1; modalities is a TEXT JSON array (text-only today).

CREATE TABLE IF NOT EXISTS llm_catalog_models (
  id          TEXT PRIMARY KEY,
  provider    TEXT NOT NULL,
  model       TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  is_default  INTEGER NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  modalities  TEXT NOT NULL DEFAULT '["text"]',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- DOWN BEGIN
DROP TABLE IF EXISTS llm_catalog_models;
-- DOWN END
