-- Migration 009: create applications table for job-application tracking
-- File: 009_create_applications.sql
-- Date: 2026-09-16 10:00
-- Dialect: Postgres
-- Ref: docs/设计-痛点解决方案-20260916.md (batch 2, application tracking)
-- Note: Postgres dialect. Column set and index names must match the SQLite
--       migration exactly (migrations-parity test). Denormalized target fields
--       keep records readable after a job posting goes offline.

CREATE TABLE IF NOT EXISTS applications (
  id               TEXT PRIMARY KEY,
  profile_id       TEXT NOT NULL,
  job_id           TEXT,
  source           TEXT,
  target_title     TEXT NOT NULL,
  target_company   TEXT NOT NULL,
  target_url       TEXT,
  status           TEXT NOT NULL DEFAULT 'applied',
  note             TEXT,
  origin           TEXT NOT NULL DEFAULT 'manual',
  applied_at       TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE applications IS 'Candidate-side application records keyed by profile_id (no accounts yet)';
COMMENT ON COLUMN applications.id IS 'internal stable id, app-<uuid>';
COMMENT ON COLUMN applications.profile_id IS 'owning profile snapshot id';
COMMENT ON COLUMN applications.job_id IS 'internal job_postings.id for aggregated jobs; null for manual/external';
COMMENT ON COLUMN applications.source IS 'job source key (remoteok|greenhouse|...) when aggregated';
COMMENT ON COLUMN applications.target_title IS 'denormalized job title, kept if the posting disappears';
COMMENT ON COLUMN applications.target_company IS 'denormalized company name';
COMMENT ON COLUMN applications.target_url IS 'external job/application URL when known';
COMMENT ON COLUMN applications.status IS 'saved|applied|viewed|interview|offer|rejected|withdrawn';
COMMENT ON COLUMN applications.note IS 'candidate free-text note';
COMMENT ON COLUMN applications.origin IS 'creation channel: manual|report|extension';
COMMENT ON COLUMN applications.applied_at IS 'application/record time chosen by caller, UTC ISO8601';
COMMENT ON COLUMN applications.created_at IS 'row created at, UTC ISO8601';
COMMENT ON COLUMN applications.updated_at IS 'row last updated at, UTC ISO8601';

CREATE INDEX IF NOT EXISTS idx_applications_profile_status
  ON applications (profile_id, status);

CREATE INDEX IF NOT EXISTS idx_applications_profile_applied
  ON applications (profile_id, applied_at DESC);

-- DOWN BEGIN
DROP TABLE IF EXISTS applications;
-- DOWN END
