-- Migration 031: create cron_heartbeat for consumer liveness
-- File: 031_create_cron_heartbeat.sql
-- Date: 2026-10-07 22:00
-- Dialect: SQLite
-- Depends on: 030
-- Ref: docs/deferred-items.md (Cron Worker failure signal has no reader),
--      docs/design-cron-scheduler-20261006.md §4.6
-- Note: SQLite dialect. One row per cron consumer (process-job / agent-tick).
--       last_success_at/last_result are NULL until the first successful run;
--       last_error is NULL when the most recent attempt succeeded. The API cron
--       endpoints upsert these rows; /health?deep=1 reads them back, so the
--       "is the consumer actually running" question is answerable in-app
--       instead of only in Cloudflare logs.

CREATE TABLE IF NOT EXISTS cron_heartbeat (
  consumer TEXT PRIMARY KEY,
  last_success_at TEXT,
  last_result TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

-- DOWN BEGIN
DROP TABLE IF EXISTS cron_heartbeat;
-- DOWN END
