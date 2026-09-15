-- Migration 006: create demo_sessions table for unauthenticated demo mode
-- File: 006_create_demo_sessions.sql
-- Date: 2026-09-15 19:00
-- Dialect: Postgres
-- Depends on: 005
-- Ref: docs/design-demo-mode-20260915.md
-- Note: Postgres dialect. Column set and index names match the SQLite migration
--       exactly (migrations-parity test). Time columns stay TEXT/ISO8601 to match
--       the existing migrations; TIMESTAMPTZ remains deferred.

CREATE TABLE IF NOT EXISTS demo_sessions (
  id               TEXT PRIMARY KEY,
  created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at       TEXT NOT NULL,
  analyze_count    INTEGER NOT NULL DEFAULT 0,
  match_count      INTEGER NOT NULL DEFAULT 0,
  analyzed_logins  TEXT NOT NULL DEFAULT '[]',
  ip_hash          TEXT,
  status           TEXT NOT NULL DEFAULT 'active'
);

COMMENT ON TABLE demo_sessions IS 'Temporary unauthenticated demo sessions, one row per cookie (id is the cookie value)';
COMMENT ON COLUMN demo_sessions.id IS 'session id = demo- + 32 random bytes base64url, doubles as cookie value';
COMMENT ON COLUMN demo_sessions.created_at IS 'row created at, UTC ISO8601';
COMMENT ON COLUMN demo_sessions.last_seen_at IS 'bumped on every authenticated action (slot acquire / me / analyze)';
COMMENT ON COLUMN demo_sessions.expires_at IS 'absolute expiry; past rows are treated as anonymous and purged';
COMMENT ON COLUMN demo_sessions.analyze_count IS 'number of NEW analyses in the session (cache hits do not increment)';
COMMENT ON COLUMN demo_sessions.match_count IS 'observed-only match count (no hard quota by default, design §7.4)';
COMMENT ON COLUMN demo_sessions.analyzed_logins IS 'JSON array of {platform, login} for which a NEW job was created';
COMMENT ON COLUMN demo_sessions.ip_hash IS 'salted SHA-256 of client IP, null when no trustworthy IP (local dev)';
COMMENT ON COLUMN demo_sessions.status IS 'lifecycle: active | exited (expiry is time-based)';

CREATE INDEX IF NOT EXISTS idx_demo_sessions_expires
  ON demo_sessions (expires_at);
CREATE INDEX IF NOT EXISTS idx_demo_sessions_ip_created
  ON demo_sessions (ip_hash, created_at);

-- DOWN BEGIN
DROP TABLE IF EXISTS demo_sessions;
-- DOWN END
