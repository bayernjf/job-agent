-- Migration 018: create job_preferences table for job-search preference sets
-- File: 018_create_job_preferences.sql
-- Date: 2026-10-03 09:10
-- Depends on: 001
-- Ref: docs/设计-求职Agent-20261002.md §5.3 (阶段 1 求职工作台)
-- Note: SQLite dialect. One row = one reusable preference set answering "what to
--       look for" (design §3.1); a job run (019) binds exactly one of them. JSON
--       arrays are TEXT here (whole schema keeps TEXT for JSON to stay identical
--       across dialects), booleans are INTEGER 0/1, timestamps are TEXT UTC
--       ISO8601. No foreign keys anywhere in this schema; cascade delete runs in
--       the application layer. No CHECK constraints (they would force a table
--       rebuild on SQLite); value domains are guaranteed by the repository layer.

CREATE TABLE IF NOT EXISTS job_preferences (
  -- preference id (pref-<uuid>)
  id                 TEXT PRIMARY KEY,
  -- owning account (accounts.id)
  account_id         TEXT NOT NULL,
  -- user-visible name, e.g. "remote full-stack"
  label              TEXT NOT NULL,
  -- JSON array: target job-title keywords (hard filter; at least one)
  target_titles      TEXT NOT NULL,
  -- JSON array: skills that take part in the weighted score; empty = use profile skills
  skills             TEXT NOT NULL DEFAULT '[]',
  -- JSON array: location keywords (substring filter), empty = unrestricted
  locations          TEXT NOT NULL DEFAULT '[]',
  -- restrict to remote roles (0/1)
  remote_only        INTEGER NOT NULL DEFAULT 0,
  -- annualised salary floor in USD; null = no floor
  salary_min_usd     INTEGER,
  -- JSON array: allowed job sources; empty = all sources
  sources            TEXT NOT NULL DEFAULT '[]',
  -- JSON array: companies pushed to the top of the list (not exclusive)
  company_whitelist  TEXT NOT NULL DEFAULT '[]',
  -- JSON array: companies dropped from the list
  company_blacklist  TEXT NOT NULL DEFAULT '[]',
  -- quality gate: lowest match tier that may enter the submit list (high|mid|low)
  min_tier           TEXT NOT NULL DEFAULT 'mid',
  -- per-source daily submit cap (design §3.4 rate limit)
  daily_submit_limit INTEGER NOT NULL DEFAULT 20,
  -- row created at (UTC ISO8601)
  created_at         TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  -- row last updated at (UTC ISO8601)
  updated_at         TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

-- list one account's preference sets, newest first
CREATE INDEX IF NOT EXISTS idx_jp_account
  ON job_preferences (account_id, created_at);

-- DOWN BEGIN
DROP INDEX IF EXISTS idx_jp_account;
DROP TABLE IF EXISTS job_preferences;
-- DOWN END
