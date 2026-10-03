-- Migration 027: create api_tokens table (long-lived bearer tokens for the extension)
-- File: 027_create_api_tokens.sql
-- Date: 2026-10-04 04:18
-- Dialect: Postgres
-- Depends on: 026
-- Ref: docs/design-扩展登录态-20261004.md §5 (decision #22)
-- Note: Postgres dialect. Column set must match the SQLite migration exactly
--       (migrations-parity test). Long-lived bearer tokens for extension-
--       authenticated API calls; only SHA-256 hex digests are stored, plaintext
--       is returned once at issuance. 90-day sliding expiry; revoked_at disables.

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

CREATE INDEX IF NOT EXISTS idx_api_tokens_hash
  ON api_tokens (token_hash);
CREATE INDEX IF NOT EXISTS idx_api_tokens_account
  ON api_tokens (account_id);
CREATE INDEX IF NOT EXISTS idx_api_tokens_expires
  ON api_tokens (expires_at);

COMMENT ON TABLE api_tokens IS 'Long-lived bearer tokens for extension-authenticated API calls; only SHA-256 digest stored (decision #22)';
COMMENT ON COLUMN api_tokens.id IS 'token id (tkn-<uuid>); token plaintext returned once at issuance';
COMMENT ON COLUMN api_tokens.account_id IS 'owning account (accounts.id)';
COMMENT ON COLUMN api_tokens.token_hash IS 'SHA-256 hex digest of the bearer token; unique, only stored form';
COMMENT ON COLUMN api_tokens.name IS 'display label (default browser extension)';
COMMENT ON COLUMN api_tokens.expires_at IS 'UTC ISO8601; 90-day sliding expiry (API_TOKEN_TTL_MS), touched on use';
COMMENT ON COLUMN api_tokens.last_seen_at IS 'last successful bearer resolution';
COMMENT ON COLUMN api_tokens.revoked_at IS 'revocation timestamp; non-NULL disables the token immediately';
COMMENT ON COLUMN api_tokens.created_at IS 'issue timestamp';

-- DOWN BEGIN
DROP INDEX IF EXISTS idx_api_tokens_expires;
DROP INDEX IF EXISTS idx_api_tokens_account;
DROP INDEX IF EXISTS idx_api_tokens_hash;
DROP TABLE IF EXISTS api_tokens;
-- DOWN END
