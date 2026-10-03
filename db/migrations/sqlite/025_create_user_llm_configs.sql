-- Migration 025: create user_llm_configs table (BYOK model settings)
-- File: 025_create_user_llm_configs.sql
-- Date: 2026-10-03 09:00
-- Depends on: 024
-- Ref: docs/design-llm-model-provisioning-20261003.md §4.3 (BYOK)
-- Note: SQLite dialect. One row per account (decision #21-6: single text-model
--       config, MVP simplification). api_key_encrypted holds the AES-256-GCM
--       ciphertext (decision #21-1, LLM_ENC_KEY env); plaintext keys never touch
--       the database, any log, or any API response. No FK (consistent with the
--       rest of the schema); timestamps TEXT UTC ISO8601.

CREATE TABLE IF NOT EXISTS user_llm_configs (
  account_id        TEXT PRIMARY KEY,
  provider          TEXT NOT NULL DEFAULT 'custom',
  base_url          TEXT NOT NULL,
  model             TEXT NOT NULL,
  api_key_encrypted TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- DOWN BEGIN
DROP TABLE IF EXISTS user_llm_configs;
-- DOWN END
