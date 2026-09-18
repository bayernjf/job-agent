-- Migration 011: create auth_sessions table for logged-in user sessions
-- File: 011_create_auth_sessions.sql
-- Date: 2026-09-18 22:55
-- Dialect: Postgres
-- Depends on: 010
-- Ref: decisions #1-A / #6-A (owner OAuth login)
-- Note: Postgres dialect. Column set and index names must match the SQLite migration
--       exactly (migrations-parity test). Opaque server-side sessions enable
--       logout/revocation/expiry without JWT; no IP or PII is stored.

CREATE TABLE IF NOT EXISTS auth_sessions (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE auth_sessions IS 'Opaque server-side login sessions for accounts (id is the cookie value)';
COMMENT ON COLUMN auth_sessions.id IS 'opaque token ses-<32 random bytes>, also the HttpOnly cookie value';
COMMENT ON COLUMN auth_sessions.account_id IS 'owning accounts.id';
COMMENT ON COLUMN auth_sessions.expires_at IS 'session expiry, UTC ISO8601';
COMMENT ON COLUMN auth_sessions.status IS 'active|revoked (logout sets revoked)';
COMMENT ON COLUMN auth_sessions.created_at IS 'row created at, UTC ISO8601';
COMMENT ON COLUMN auth_sessions.last_seen_at IS 'last authenticated use, UTC ISO8601';

CREATE INDEX IF NOT EXISTS idx_auth_sessions_account
  ON auth_sessions (account_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires
  ON auth_sessions (expires_at);

-- DOWN BEGIN
DROP TABLE IF EXISTS auth_sessions;
-- DOWN END
