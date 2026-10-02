-- Migration 018: create job_preferences table for job-search preference sets
-- File: 018_create_job_preferences.sql
-- Date: 2026-10-03 09:10
-- Dialect: Postgres
-- Depends on: 001
-- Ref: docs/设计-求职Agent-20261002.md §5.3 (阶段 1 求职工作台)
-- Note: Postgres dialect. Column set and index names must match the SQLite
--       migration exactly (migrations-parity test). One row = one reusable
--       preference set answering "what to look for" (design §3.1); a job run
--       (019) binds exactly one of them. JSON arrays stay TEXT here on purpose
--       (no JSONB, no TIMESTAMPTZ) so both dialects remain structurally
--       identical, booleans are BOOLEAN, timestamps are TEXT UTC ISO8601. No
--       foreign keys; cascade delete is application-side.

CREATE TABLE IF NOT EXISTS job_preferences (
  id                 TEXT PRIMARY KEY,
  account_id         TEXT NOT NULL,
  label              TEXT NOT NULL,
  target_titles      TEXT NOT NULL,
  skills             TEXT NOT NULL DEFAULT '[]',
  locations          TEXT NOT NULL DEFAULT '[]',
  remote_only        BOOLEAN NOT NULL DEFAULT FALSE,
  salary_min_usd     INTEGER,
  sources            TEXT NOT NULL DEFAULT '[]',
  company_whitelist  TEXT NOT NULL DEFAULT '[]',
  company_blacklist  TEXT NOT NULL DEFAULT '[]',
  min_tier           TEXT NOT NULL DEFAULT 'mid',
  daily_submit_limit INTEGER NOT NULL DEFAULT 20,
  created_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE job_preferences IS 'Reusable job-search preference sets (design §3.1); a job run binds exactly one of them';
COMMENT ON COLUMN job_preferences.id IS 'preference id (pref-<uuid>)';
COMMENT ON COLUMN job_preferences.account_id IS 'owning account (accounts.id)';
COMMENT ON COLUMN job_preferences.label IS 'user-visible name, e.g. "remote full-stack"';
COMMENT ON COLUMN job_preferences.target_titles IS 'JSON array: target job-title keywords (hard filter; at least one)';
COMMENT ON COLUMN job_preferences.skills IS 'JSON array: skills that take part in the weighted score; empty = use profile skills';
COMMENT ON COLUMN job_preferences.locations IS 'JSON array: location keywords (substring filter), empty = unrestricted';
COMMENT ON COLUMN job_preferences.remote_only IS 'restrict to remote roles';
COMMENT ON COLUMN job_preferences.salary_min_usd IS 'annualised salary floor in USD; NULL = no floor';
COMMENT ON COLUMN job_preferences.sources IS 'JSON array: allowed job sources; empty = all sources';
COMMENT ON COLUMN job_preferences.company_whitelist IS 'JSON array: companies pushed to the top of the list (not exclusive)';
COMMENT ON COLUMN job_preferences.company_blacklist IS 'JSON array: companies dropped from the list';
COMMENT ON COLUMN job_preferences.min_tier IS 'quality gate: lowest match tier allowed into the submit list (high|mid|low)';
COMMENT ON COLUMN job_preferences.daily_submit_limit IS 'per-source daily submit cap (design §3.4 rate limit)';
COMMENT ON COLUMN job_preferences.created_at IS 'row created at (UTC ISO8601)';
COMMENT ON COLUMN job_preferences.updated_at IS 'row last updated at (UTC ISO8601)';

CREATE INDEX IF NOT EXISTS idx_jp_account
  ON job_preferences (account_id, created_at);

-- DOWN BEGIN
DROP INDEX IF EXISTS idx_jp_account;
DROP TABLE IF EXISTS job_preferences;
-- DOWN END
