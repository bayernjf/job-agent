-- Migration 025: create user_llm_configs table (BYOK model settings)
-- File: 025_create_user_llm_configs.sql
-- Date: 2026-10-03 09:00
-- Dialect: Postgres
-- Depends on: 024
-- Ref: docs/design-llm-model-provisioning-20261003.md §4.3 (BYOK)
-- Note: Postgres dialect. Column set must match the SQLite migration exactly
--       (migrations-parity test). One row per account (decision #21-6).
--       api_key_encrypted holds the AES-256-GCM ciphertext (decision #21-1);
--       plaintext keys never touch the database, any log, or any API response.

CREATE TABLE IF NOT EXISTS user_llm_configs (
  account_id        TEXT PRIMARY KEY,
  provider          TEXT NOT NULL DEFAULT 'custom',
  base_url          TEXT NOT NULL,
  model             TEXT NOT NULL,
  api_key_encrypted TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

COMMENT ON TABLE user_llm_configs IS 'Per-account BYOK model config (decision #21-0''/6); api_key_encrypted holds AES-256-GCM ciphertext (decision #21-1)';
COMMENT ON COLUMN user_llm_configs.account_id IS 'owning account (accounts.id), one row per account';
COMMENT ON COLUMN user_llm_configs.provider IS 'provider identifier, default custom';
COMMENT ON COLUMN user_llm_configs.base_url IS 'OpenAI-compatible base URL';
COMMENT ON COLUMN user_llm_configs.model IS 'model id sent in the request';
COMMENT ON COLUMN user_llm_configs.api_key_encrypted IS 'AES-256-GCM ciphertext of the user key; plaintext never persisted';
COMMENT ON COLUMN user_llm_configs.created_at IS 'row created at (UTC ISO8601)';
COMMENT ON COLUMN user_llm_configs.updated_at IS 'row last updated at (UTC ISO8601)';

-- DOWN BEGIN
DROP TABLE IF EXISTS user_llm_configs;
-- DOWN END
