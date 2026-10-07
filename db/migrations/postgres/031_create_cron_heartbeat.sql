-- Migration 031: create cron_heartbeat for consumer liveness
-- File: 031_create_cron_heartbeat.sql
-- Date: 2026-10-07 22:00
-- Dialect: Postgres
-- Depends on: 030
-- Ref: docs/deferred-items.md (Cron Worker failure signal has no reader),
--      docs/design-cron-scheduler-20261006.md §4.6
-- Note: Postgres dialect. Column set must match the SQLite migration exactly
--       (migrations-parity test). One row per cron consumer; last_success_at
--       stays NULL until the first success, last_error is cleared on success.
--       /health?deep=1 reads the rows back as the in-app liveness signal.

CREATE TABLE IF NOT EXISTS cron_heartbeat (
  consumer TEXT PRIMARY KEY,
  last_success_at TEXT,
  last_result TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE cron_heartbeat IS 'Liveness rows for cron consumers (process-job / agent-tick); upserted by the API cron endpoints on each attempt, read by /health?deep=1';

-- DOWN BEGIN
DROP TABLE IF EXISTS cron_heartbeat;
-- DOWN END
