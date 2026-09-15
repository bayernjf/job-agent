-- Migration 007: create demo_rate_events table for IP sliding-window limits
-- File: 007_create_demo_rate_events.sql
-- Date: 2026-09-15 19:00
-- Depends on: 006
-- Ref: docs/design-demo-mode-20260915.md §3.2
-- Note: SQLite dialect. Append-only counters; cleanup deletes rows older than 24h.
--       Storing window counters in DB avoids introducing Redis in the MVP.

CREATE TABLE IF NOT EXISTS demo_rate_events (
  -- event id (uuid)
  id               TEXT PRIMARY KEY,
  -- salted SHA-256 of client IP
  ip_hash          TEXT NOT NULL,
  -- rate-limit bucket: session | analyze
  kind             TEXT NOT NULL,
  -- event time (UTC ISO8601)
  created_at       TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

-- sliding-window count: WHERE ip_hash=? AND kind=? AND created_at > cutoff
CREATE INDEX IF NOT EXISTS idx_demo_rate_events_ip_kind_created
  ON demo_rate_events (ip_hash, kind, created_at);

-- DOWN BEGIN
DROP TABLE IF EXISTS demo_rate_events;
-- DOWN END
