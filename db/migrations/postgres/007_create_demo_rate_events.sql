-- Migration 007: create demo_rate_events table for IP sliding-window limits
-- File: 007_create_demo_rate_events.sql
-- Date: 2026-09-15 19:00
-- Dialect: Postgres
-- Depends on: 006
-- Ref: docs/design-demo-mode-20260915.md §3.2
-- Note: Postgres dialect. Append-only counters; cleanup deletes rows older than
--       24h. Storing window counters in DB avoids introducing Redis in the MVP.

CREATE TABLE IF NOT EXISTS demo_rate_events (
  id               TEXT PRIMARY KEY,
  ip_hash          TEXT NOT NULL,
  kind             TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE demo_rate_events IS 'Append-only IP sliding-window counters for demo rate limits';
COMMENT ON COLUMN demo_rate_events.id IS 'event id (uuid)';
COMMENT ON COLUMN demo_rate_events.ip_hash IS 'salted SHA-256 of client IP';
COMMENT ON COLUMN demo_rate_events.kind IS 'rate-limit bucket: session | analyze';
COMMENT ON COLUMN demo_rate_events.created_at IS 'event time, UTC ISO8601';

CREATE INDEX IF NOT EXISTS idx_demo_rate_events_ip_kind_created
  ON demo_rate_events (ip_hash, kind, created_at);

-- DOWN BEGIN
DROP TABLE IF EXISTS demo_rate_events;
-- DOWN END
