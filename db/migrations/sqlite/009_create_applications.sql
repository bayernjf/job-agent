-- Migration 009: create applications table for job-application tracking
-- File: 009_create_applications.sql
-- Date: 2026-09-16 10:00
-- Ref: docs/设计-痛点解决方案-20260916.md (batch 2, application tracking)
-- Note: SQLite dialect. Candidate-side application records linked to a profile
--       snapshot. No accounts yet: rows are keyed by profile_id; recruiter-side
--       feedback statuses are reserved in the status enum but not written today.
--       target_title/target_company are denormalized so records survive a job
--       posting going offline.

CREATE TABLE IF NOT EXISTS applications (
  -- internal stable id = app-<uuid>
  id               TEXT PRIMARY KEY,
  -- owning profile snapshot id (reports/app tracker scope)
  profile_id       TEXT NOT NULL,
  -- internal job_postings.id when the target is an aggregated job; null for manual/external
  job_id           TEXT,
  -- job source key (remoteok|greenhouse|...) when the target is an aggregated job
  source           TEXT,
  -- denormalized job title (kept even if the posting later disappears)
  target_title     TEXT NOT NULL,
  -- denormalized company name
  target_company   TEXT NOT NULL,
  -- external job/application URL when known
  target_url       TEXT,
  -- funnel status: saved|applied|viewed|interview|offer|rejected|withdrawn
  status           TEXT NOT NULL DEFAULT 'applied',
  -- candidate free-text note, nullable
  note             TEXT,
  -- how the record was created: manual|report|extension
  origin           TEXT NOT NULL DEFAULT 'manual',
  -- application/record time chosen by the caller (UTC ISO8601)
  applied_at       TEXT NOT NULL,
  -- row created at (UTC ISO8601)
  created_at       TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  -- row last updated at (UTC ISO8601)
  updated_at       TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

-- list a profile's applications grouped by status, newest actions first
CREATE INDEX IF NOT EXISTS idx_applications_profile_status
  ON applications (profile_id, status);

-- default listing for a profile: newest applied_at first
CREATE INDEX IF NOT EXISTS idx_applications_profile_applied
  ON applications (profile_id, applied_at DESC);

-- DOWN BEGIN
DROP TABLE IF EXISTS applications;
-- DOWN END
