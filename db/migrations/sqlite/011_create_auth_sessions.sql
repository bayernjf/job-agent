-- Migration 011: create auth_sessions table for logged-in user sessions
-- File: 011_create_auth_sessions.sql
-- Date: 2026-09-18 22:55
-- Depends on: 010
-- Ref: decisions #1-A / #6-A (owner OAuth login)
-- Note: SQLite dialect. Opaque server-side sessions mirroring demo_sessions but for
--       logged-in accounts. id is the HttpOnly cookie value (32 random bytes,
--       unguessable); storing sessions server-side enables logout/revocation/expiry
--       without JWT. No IP or other PII is stored.

CREATE TABLE IF NOT EXISTS auth_sessions (
  -- opaque session token = ses-<32 random bytes>; also the cookie value
  id            TEXT PRIMARY KEY,
  -- owning accounts.id
  account_id    TEXT NOT NULL,
  -- session expiry (UTC ISO8601); expired rows are treated as anonymous
  expires_at    TEXT NOT NULL,
  -- lifecycle status: active|revoked (logout sets revoked)
  status        TEXT NOT NULL DEFAULT 'active',
  -- row created at (UTC ISO8601)
  created_at    TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  -- last authenticated use (UTC ISO8601)
  last_seen_at  TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

-- list an account's sessions (logout/audit)
CREATE INDEX IF NOT EXISTS idx_auth_sessions_account
  ON auth_sessions (account_id);
-- cleanup / expiry scans
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires
  ON auth_sessions (expires_at);

-- DOWN BEGIN
DROP TABLE IF EXISTS auth_sessions;
-- DOWN END
