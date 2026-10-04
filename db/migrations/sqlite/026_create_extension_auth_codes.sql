-- Migration 026: create extension_auth_codes table (one-time codes for extension login)
-- File: 026_create_extension_auth_codes.sql
-- Date: 2026-10-04 04:18
-- Depends on: 025
-- Ref: docs/design-扩展登录态-20261004.md §5 (decision #22)
-- Note: SQLite dialect. One-time codes issued by the workbench to a logged-in
--       account; consumed once by the extension in exchange for an api_token.
--       id is the plaintext code (ext-code-<32B), bound to the issuing account;
--       used_at != NULL marks consumed (single-use); expired rows are ignored
--       and purged by cleanup. No FK (consistent with the rest of the schema);
--       timestamps TEXT UTC ISO8601.

CREATE TABLE IF NOT EXISTS extension_auth_codes (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  used_at       TEXT,
  created_at    TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

-- find unconsumed codes per account / audit
CREATE INDEX IF NOT EXISTS idx_extension_auth_codes_account
  ON extension_auth_codes (account_id);
-- cleanup scan: expired or consumed
CREATE INDEX IF NOT EXISTS idx_extension_auth_codes_expires
  ON extension_auth_codes (expires_at);

-- DOWN BEGIN
DROP INDEX IF EXISTS idx_extension_auth_codes_expires;
DROP INDEX IF EXISTS idx_extension_auth_codes_account;
DROP TABLE IF EXISTS extension_auth_codes;
-- DOWN END
