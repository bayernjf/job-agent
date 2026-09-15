-- Migration 006: create demo_sessions table for unauthenticated demo mode
-- File: 006_create_demo_sessions.sql
-- Date: 2026-09-15 19:00
-- Depends on: 005
-- Ref: docs/design-demo-mode-20260915.md
-- Note: SQLite dialect. One row per temporary demo session. The id is a random
--       base64url token (prefixed 'demo-') and is also the cookie value.
--       No plaintext IP is stored, only a salted SHA-256 hash.

CREATE TABLE IF NOT EXISTS demo_sessions (
  -- session id = 'demo-' + 32 random bytes base64url; doubles as cookie value
  id               TEXT PRIMARY KEY,
  -- row created at (UTC ISO8601)
  created_at       TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  -- bumped on every authenticated action (slot acquire / me / analyze)
  last_seen_at     TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  -- absolute expiry; rows past it are treated as anonymous and purged by cleanup
  expires_at       TEXT NOT NULL,
  -- number of NEW analyses triggered in this session (cache hits do not increment)
  analyze_count    INTEGER NOT NULL DEFAULT 0,
  -- observed-only match count (no hard quota by default, see design §7.4)
  match_count      INTEGER NOT NULL DEFAULT 0,
  -- JSON array of {platform, login} for which a NEW job was created (audit/UI)
  analyzed_logins  TEXT NOT NULL DEFAULT '[]',
  -- salted SHA-256 of client IP; null when no trustworthy IP (local dev)
  ip_hash          TEXT,
  -- lifecycle: active | exited (expiry is time-based, no 'expired' status needed)
  status           TEXT NOT NULL DEFAULT 'active'
);

-- cleanup sweep by expiry
CREATE INDEX IF NOT EXISTS idx_demo_sessions_expires
  ON demo_sessions (expires_at);
-- IP sliding-window for session creation rate
CREATE INDEX IF NOT EXISTS idx_demo_sessions_ip_created
  ON demo_sessions (ip_hash, created_at);

-- DOWN BEGIN
DROP TABLE IF EXISTS demo_sessions;
-- DOWN END
