-- Migration 021: create submit_intents table for the human-in-the-loop gate
-- File: 021_create_submit_intents.sql
-- Date: 2026-10-03 09:55
-- Dialect: Postgres
-- Depends on: 019
-- Ref: docs/设计-求职Agent-20261002.md §5.3 (阶段 1 求职工作台)
-- Note: Postgres dialect. Column set and index names must match the SQLite
--       migration exactly (migrations-parity test). One row = one ticket in the
--       submit list (design §4.3 human gate): the agent prepares, the user
--       approves/judges, and only a user action moves a ticket forward in stage 1.
--       job_source is a dedicated column (not parsed out of job_snapshot JSON)
--       because the per-source daily cap counts committed tickets by source.
--       job_snapshot / match_report are JSON TEXT snapshots so a ticket still
--       self-describes what was matched after the posting pool is refreshed. The
--       rate-limit query compares approved_at/submitted_at against a bound ISO
--       string, so those comparisons must go through postgres/time-text.ts
--       (`::text` pinning) to survive a transaction pooler. No CHECK constraints,
--       no foreign keys (cascade delete is application-side).

CREATE TABLE IF NOT EXISTS submit_intents (
  id             TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL,
  account_id     TEXT NOT NULL,
  profile_id     TEXT NOT NULL,
  job_id         TEXT NOT NULL,
  job_source     TEXT NOT NULL,
  job_snapshot   TEXT NOT NULL,
  match_score    INTEGER NOT NULL,
  match_tier     TEXT NOT NULL,
  match_report   TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending',
  reject_reason  TEXT,
  approved_at    TEXT,
  rejected_at    TEXT,
  submitted_at   TEXT,
  application_id TEXT,
  created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE submit_intents IS 'Human-in-the-loop submit tickets (design §4.3): agent prepares, user approves, nothing is sent externally in stage 1';
COMMENT ON COLUMN submit_intents.id IS 'ticket id (intent-<uuid>)';
COMMENT ON COLUMN submit_intents.run_id IS 'owning run (job_runs.id)';
COMMENT ON COLUMN submit_intents.account_id IS 'owning account (accounts.id)';
COMMENT ON COLUMN submit_intents.profile_id IS 'profile snapshot the score was computed from (profiles.id)';
COMMENT ON COLUMN submit_intents.job_id IS 'target job pool row (job_postings.id)';
COMMENT ON COLUMN submit_intents.job_source IS 'job source (remoteok|remotive|greenhouse|lever|hn_whoishiring|weworkremotely|manual); own column because the daily cap counts by source';
COMMENT ON COLUMN submit_intents.job_snapshot IS 'JSON: condensed SubmitIntentJob snapshot of the posting';
COMMENT ON COLUMN submit_intents.match_score IS 'weighted total from matchJobs (title x3 + tags x2 + description x1)';
COMMENT ON COLUMN submit_intents.match_tier IS 'match tier: high|mid|low';
COMMENT ON COLUMN submit_intents.match_report IS 'JSON: MatchReport (reason/gap codes + facts only, no prose)';
COMMENT ON COLUMN submit_intents.status IS 'ticket state: pending|approved|rejected|submitted|withdrawn|failed';
COMMENT ON COLUMN submit_intents.reject_reason IS 'user-supplied rejection reason; NULL otherwise';
COMMENT ON COLUMN submit_intents.approved_at IS 'user confirmation moment (UTC ISO8601), NULL until approved';
COMMENT ON COLUMN submit_intents.rejected_at IS 'rejection moment (UTC ISO8601), NULL unless rejected';
COMMENT ON COLUMN submit_intents.submitted_at IS 'moment the user reported the application as actually sent (UTC ISO8601)';
COMMENT ON COLUMN submit_intents.application_id IS 'applications.id written when the ticket is marked as submitted';
COMMENT ON COLUMN submit_intents.created_at IS 'row created at (UTC ISO8601)';
COMMENT ON COLUMN submit_intents.updated_at IS 'row last updated at (UTC ISO8601)';

CREATE INDEX IF NOT EXISTS idx_si_run
  ON submit_intents (run_id, created_at);

CREATE INDEX IF NOT EXISTS idx_si_account_status
  ON submit_intents (account_id, status);

CREATE INDEX IF NOT EXISTS idx_si_source
  ON submit_intents (account_id, job_source, status);

-- DOWN BEGIN
DROP INDEX IF EXISTS idx_si_source;
DROP INDEX IF EXISTS idx_si_account_status;
DROP INDEX IF EXISTS idx_si_run;
DROP TABLE IF EXISTS submit_intents;
-- DOWN END
