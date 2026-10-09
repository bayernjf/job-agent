-- Migration 032: create search_presets and search_runs for user-initiated websearch job discovery
-- File: 032_create_search_presets_runs.sql
-- Date: 2026-10-08 00:20
-- Dialect: Postgres
-- Depends on: 031
-- Ref: docs/design-websearch-job-discovery-20261008.md (§3 数据模型)
-- Note: Postgres dialect. Column set must match the SQLite migration exactly
--       (migrations-parity test). Same semantics: presets are per-account
--       private with (account_id, query) uniqueness; runs carry JSON conditions
--       text and a status lifecycle driven by the search-tick cron endpoint.

CREATE TABLE IF NOT EXISTS search_presets (
  preset_id   TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL,
  title       TEXT,
  query       TEXT NOT NULL,
  conditions  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (account_id, query)
);

CREATE INDEX IF NOT EXISTS idx_search_presets_account ON search_presets (account_id);

CREATE TABLE IF NOT EXISTS search_runs (
  run_id        TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL,
  preset_id     TEXT,
  query         TEXT NOT NULL,
  conditions    TEXT NOT NULL,
  status        TEXT NOT NULL,
  queries       TEXT NOT NULL DEFAULT '[]',
  results_count INTEGER NOT NULL DEFAULT 0,
  new_count     INTEGER NOT NULL DEFAULT 0,
  matched_count INTEGER NOT NULL DEFAULT 0,
  error         TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_search_runs_account ON search_runs (account_id);
CREATE INDEX IF NOT EXISTS idx_search_runs_status ON search_runs (status, created_at);

COMMENT ON TABLE search_presets IS 'User-saved search condition presets for websearch job discovery (save/delete, per-account private, unique by (account_id, query))';
COMMENT ON TABLE search_runs IS 'One user-initiated websearch job discovery run; status lifecycle queued → running → done/partial/failed driven by search-tick cron endpoint';

-- DOWN BEGIN
DROP TABLE IF EXISTS search_runs;
DROP TABLE IF EXISTS search_presets;
-- DOWN END
