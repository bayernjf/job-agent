-- Migration 001: create profiles table for immutable ability profile snapshots
-- File: 001_create_profiles.sql
-- Date: 2026-09-11 01:02
-- Ref: AGENTS.md「迁移规范」/ MIGRATION_CONVENTION.md / packages/shared AbilityProfileSchema
-- Note: SQLite dialect for MVP local/experiment (COMMENT ON is Postgres-only, so column
--       meanings are documented with inline comments). Postgres dialect adaptation is
--       tracked in docs/deferred-items.md.

CREATE TABLE IF NOT EXISTS profiles (
  -- profileId, generated when the analysis starts; immutable (share links always point to this version)
  id                  TEXT PRIMARY KEY,
  -- analyzer engine version, guarantees reproducibility
  analyzer_version    TEXT NOT NULL,
  -- evidence source platform: 'github' (P1: gitee / portfolio)
  subject_platform    TEXT NOT NULL DEFAULT 'github',
  -- GitHub login of the subject
  subject_login       TEXT NOT NULL,
  -- whether the profile is claimed via owner OAuth: 0 = no, 1 = yes
  subject_claimed     INTEGER NOT NULL DEFAULT 0,
  -- data window start (ISO8601 UTC)
  data_window_since   TEXT NOT NULL,
  -- data window end (ISO8601 UTC)
  data_window_until   TEXT NOT NULL,
  -- analysis layers covered, JSON array e.g. '["L0","L1"]'
  analysis_layers     TEXT NOT NULL DEFAULT '["L0","L1"]',
  -- snapshot state: 'partial' (L0 only) / 'complete' / 'error'
  status              TEXT NOT NULL DEFAULT 'partial',
  -- full AbilityProfile JSON (immutable snapshot)
  snapshot            TEXT NOT NULL,
  -- created at (UTC ISO8601)
  created_at          TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  -- last updated at (UTC ISO8601)
  updated_at          TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

-- look up a subject's profiles by recency
CREATE INDEX IF NOT EXISTS idx_profiles_subject_created
  ON profiles (subject_platform, subject_login, created_at DESC);

-- DOWN BEGIN
DROP TABLE IF EXISTS profiles;
-- DOWN END
