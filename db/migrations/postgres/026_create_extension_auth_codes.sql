-- Migration 026: create extension_auth_codes table (one-time codes for extension login)
-- File: 026_create_extension_auth_codes.sql
-- Date: 2026-10-04 04:18
-- Dialect: Postgres
-- Depends on: 025
-- Ref: docs/design-扩展登录态-20261004.md §5 (decision #22)
-- Note: Postgres dialect. Column set must match the SQLite migration exactly
--       (migrations-parity test). One-time codes issued by the workbench to a
--       logged-in account; consumed once by the extension in exchange for an
--       api_token. used_at != NULL marks consumed (single-use).

CREATE TABLE IF NOT EXISTS extension_auth_codes (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  used_at       TEXT,
  created_at    TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX IF NOT EXISTS idx_extension_auth_codes_account
  ON extension_auth_codes (account_id);
CREATE INDEX IF NOT EXISTS idx_extension_auth_codes_expires
  ON extension_auth_codes (expires_at);

COMMENT ON TABLE extension_auth_codes IS 'One-time login codes issued by the workbench to a logged-in account; consumed once by the extension (decision #22)';
COMMENT ON COLUMN extension_auth_codes.id IS 'plaintext code (ext-code-<32B), single-use via used_at';
COMMENT ON COLUMN extension_auth_codes.account_id IS 'issuing account (accounts.id)';
COMMENT ON COLUMN extension_auth_codes.expires_at IS 'UTC ISO8601; code valid for 5 minutes (EXT_AUTH_CODE_TTL_MS)';
COMMENT ON COLUMN extension_auth_codes.used_at IS 'consumption timestamp; non-NULL marks single-use consumed';
COMMENT ON COLUMN extension_auth_codes.created_at IS 'issue timestamp';

-- DOWN BEGIN
DROP INDEX IF EXISTS idx_extension_auth_codes_expires;
DROP INDEX IF EXISTS idx_extension_auth_codes_account;
DROP TABLE IF EXISTS extension_auth_codes;
-- DOWN END
