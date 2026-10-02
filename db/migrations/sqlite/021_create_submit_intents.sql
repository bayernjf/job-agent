-- Migration 021: create submit_intents table for the human-in-the-loop gate
-- File: 021_create_submit_intents.sql
-- Date: 2026-10-03 09:55
-- Depends on: 019
-- Ref: docs/设计-求职Agent-20261002.md §5.3 (阶段 1 求职工作台)
-- Note: SQLite dialect. One row = one ticket in the submit list (design §4.3
--       human gate): the agent prepares, the user approves/judges, and only a
--       user action moves a ticket forward in stage 1. job_source is a dedicated
--       column (not parsed out of job_snapshot JSON) because the per-source daily
--       cap counts committed tickets by source. job_snapshot / match_report are
--       JSON TEXT snapshots so a ticket still self-describes what was matched
--       after the posting pool is refreshed or the posting goes offline. No CHECK
--       constraints (value domains live in packages/storage); no foreign keys
--       (cascade delete is application-side).

CREATE TABLE IF NOT EXISTS submit_intents (
  -- ticket id (intent-<uuid>)
  id             TEXT PRIMARY KEY,
  -- owning run (job_runs.id)
  run_id         TEXT NOT NULL,
  -- owning account (accounts.id)
  account_id     TEXT NOT NULL,
  -- profile snapshot the score was computed from (profiles.id)
  profile_id     TEXT NOT NULL,
  -- target job pool row (job_postings.id)
  job_id         TEXT NOT NULL,
  -- job source (remoteok|remotive|greenhouse|lever|hn_whoishiring|weworkremotely|manual)
  job_source     TEXT NOT NULL,
  -- JSON: condensed SubmitIntentJob snapshot of the posting
  job_snapshot   TEXT NOT NULL,
  -- weighted total from matchJobs (title x3 + tags x2 + description x1)
  match_score    INTEGER NOT NULL,
  -- match tier: high|mid|low
  match_tier     TEXT NOT NULL,
  -- JSON: MatchReport (reason/gap codes + facts only, no prose)
  match_report   TEXT NOT NULL,
  -- ticket state: pending|approved|rejected|submitted|withdrawn|failed
  status         TEXT NOT NULL DEFAULT 'pending',
  -- user-supplied rejection reason; null otherwise
  reject_reason  TEXT,
  -- user confirmation moment (UTC ISO8601), null until approved
  approved_at    TEXT,
  -- rejection moment (UTC ISO8601), null unless rejected
  rejected_at    TEXT,
  -- moment the user reported the application as actually sent (UTC ISO8601)
  submitted_at   TEXT,
  -- applications.id written when the ticket is marked as submitted
  application_id TEXT,
  -- row created at (UTC ISO8601)
  created_at     TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  -- row last updated at (UTC ISO8601)
  updated_at     TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

-- submit list of one run, newest first
CREATE INDEX IF NOT EXISTS idx_si_run
  ON submit_intents (run_id, created_at);

-- account-level listing / approval queue by state
CREATE INDEX IF NOT EXISTS idx_si_account_status
  ON submit_intents (account_id, status);

-- per-source daily rate limit: count committed tickets by (account, source, state)
CREATE INDEX IF NOT EXISTS idx_si_source
  ON submit_intents (account_id, job_source, status);

-- DOWN BEGIN
DROP INDEX IF EXISTS idx_si_source;
DROP INDEX IF EXISTS idx_si_account_status;
DROP INDEX IF EXISTS idx_si_run;
DROP TABLE IF EXISTS submit_intents;
-- DOWN END
