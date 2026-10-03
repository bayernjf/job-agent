-- Migration 027: create api_tokens table (long-lived bearer tokens for the extension)
-- File: 027_create_api_tokens.sql
-- Date: 2026-10-04 04:18
-- Depends on: 026
-- Ref: docs/design-扩展登录态-20261004.md §5 (decision #22)
-- Note: SQLite dialect. Long-lived bearer tokens for extension-authenticated
--       API calls. Only the SHA-256 hex digest (token_hash) is stored — the
--       plaintext token is returned exactly once at issuance and never persisted,
--       logged, or exposed again. 90-day sliding expiry (touched on use);
--       revoked_at != NULL disables the token. No FK (consistent with the rest
--       of the schema); timestamps TEXT UTC ISO8601.

CREATE TABLE IF NOT EXISTS api_tokens (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL DEFAULT 'browser extension',
  expires_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  revoked_at    TEXT,
  created_at    TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

-- auth lookup by digest (Bearer resolution)
CREATE INDEX IF NOT EXISTS idx_api_tokens_hash
  ON api_tokens (token_hash);
-- authorization-management list per account
CREATE INDEX IF NOT EXISTS idx_api_tokens_account
  ON api_tokens (account_id);
-- cleanup scan: expired or revoked
CREATE INDEX IF NOT EXISTS idx_api_tokens_expires
  ON api_tokens (expires_at);

-- DOWN BEGIN
DROP INDEX IF EXISTS idx_api_tokens_expires;
DROP INDEX IF EXISTS idx_api_tokens_account;
DROP INDEX IF EXISTS idx_api_tokens_hash;
DROP TABLE IF EXISTS api_tokens;
-- DOWN END
