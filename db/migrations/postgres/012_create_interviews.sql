-- Migration 012: create interviews table for recruiter interview planning
-- File: 012_create_interviews.sql
-- Date: 2026-09-24 10:00
-- Dialect: Postgres
-- Ref: docs/proposal-interview-planner-20260922.md (handoff item45)
-- Note: Postgres dialect. Column set and index names must match the SQLite
--       migration exactly (migrations-parity test). Rows are owned per
--       account (created_by_account_id); application_id is nullable because an
--       interview can be created directly from a candidate profile.

CREATE TABLE IF NOT EXISTS interviews (
  id                     TEXT PRIMARY KEY,
  profile_id             TEXT NOT NULL,
  application_id         TEXT,
  target_title           TEXT NOT NULL,
  target_company         TEXT,
  scheduled_start        TEXT NOT NULL,
  scheduled_end          TEXT NOT NULL,
  format                 TEXT NOT NULL,
  round_label            TEXT NOT NULL,
  interviewer_name       TEXT,
  interviewer_email      TEXT,
  status                 TEXT NOT NULL DEFAULT 'scheduled',
  outcome                TEXT,
  feedback_note          TEXT,
  rating                 INTEGER,
  created_by_account_id  TEXT NOT NULL,
  created_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE interviews IS 'Recruiter-side interview plans, owned row-by-row by the creating account';
COMMENT ON COLUMN interviews.id IS 'internal stable id, int-<uuid>';
COMMENT ON COLUMN interviews.profile_id IS 'candidate profile snapshot id (primary scope)';
COMMENT ON COLUMN interviews.application_id IS 'linked applications.id; null when created directly from a profile';
COMMENT ON COLUMN interviews.target_title IS 'denormalized job title for this interview';
COMMENT ON COLUMN interviews.target_company IS 'denormalized company/hiring org name';
COMMENT ON COLUMN interviews.scheduled_start IS 'scheduled start, UTC ISO8601';
COMMENT ON COLUMN interviews.scheduled_end IS 'scheduled end, UTC ISO8601, after scheduled_start';
COMMENT ON COLUMN interviews.format IS 'onsite|phone|video';
COMMENT ON COLUMN interviews.round_label IS 'free-text round label, e.g. recruiter screen/technical/final';
COMMENT ON COLUMN interviews.interviewer_name IS 'single interviewer name, free text';
COMMENT ON COLUMN interviews.interviewer_email IS 'single interviewer email';
COMMENT ON COLUMN interviews.status IS 'scheduled|completed|cancelled|no_show|rescheduled';
COMMENT ON COLUMN interviews.outcome IS 'result after completion: strong_yes|yes|neutral|no';
COMMENT ON COLUMN interviews.feedback_note IS 'free-text result note';
COMMENT ON COLUMN interviews.rating IS 'overall rating 1..5';
COMMENT ON COLUMN interviews.created_by_account_id IS 'owning accounts.id; row-level ownership';
COMMENT ON COLUMN interviews.created_at IS 'row created at, UTC ISO8601';
COMMENT ON COLUMN interviews.updated_at IS 'row last updated at, UTC ISO8601';

CREATE INDEX IF NOT EXISTS idx_interviews_owner_status
  ON interviews (created_by_account_id, status, scheduled_start);

CREATE INDEX IF NOT EXISTS idx_interviews_profile_start
  ON interviews (profile_id, scheduled_start);

CREATE INDEX IF NOT EXISTS idx_interviews_application
  ON interviews (application_id);

-- DOWN BEGIN
DROP TABLE IF EXISTS interviews;
-- DOWN END
