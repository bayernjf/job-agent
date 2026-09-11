-- Migration 001: create profiles table for immutable ability profile snapshots
-- File: 001_create_profiles.sql
-- Date: 2026-09-11 19:55
-- Dialect: Postgres
-- Ref: AGENTS.md「迁移规范」/ MIGRATION_CONVENTION.md / packages/shared AbilityProfileSchema
-- Note: Postgres dialect for production. MVP intentionally mirrors the SQLite column
--       types (TEXT for strings/JSON/timestamps, BOOLEAN, INTEGER); no JSONB/TIMESTAMPTZ/UUID
--       yet (see design-storage-dual-dialect §9). Column meanings are carried by COMMENT ON.

CREATE TABLE IF NOT EXISTS profiles (
  id                  TEXT PRIMARY KEY,
  analyzer_version    TEXT NOT NULL,
  subject_platform    TEXT NOT NULL DEFAULT 'github',
  subject_login       TEXT NOT NULL,
  subject_claimed     BOOLEAN NOT NULL DEFAULT false,
  data_window_since   TEXT NOT NULL,
  data_window_until   TEXT NOT NULL,
  analysis_layers     TEXT NOT NULL DEFAULT '["L0","L1"]',
  status              TEXT NOT NULL DEFAULT 'partial',
  snapshot            TEXT NOT NULL,
  created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE profiles IS 'Immutable ability profile snapshots; share links always point to one version';
COMMENT ON COLUMN profiles.id IS 'profileId, generated when analysis starts; immutable';
COMMENT ON COLUMN profiles.analyzer_version IS 'analyzer engine version, guarantees reproducibility';
COMMENT ON COLUMN profiles.subject_platform IS 'evidence source platform: github (P1: gitee / portfolio)';
COMMENT ON COLUMN profiles.subject_login IS 'login of the subject on the source platform';
COMMENT ON COLUMN profiles.subject_claimed IS 'whether the profile is claimed via owner OAuth';
COMMENT ON COLUMN profiles.data_window_since IS 'data window start, ISO8601 UTC';
COMMENT ON COLUMN profiles.data_window_until IS 'data window end, ISO8601 UTC';
COMMENT ON COLUMN profiles.analysis_layers IS 'covered analysis layers, JSON array e.g. ["L0","L1"]';
COMMENT ON COLUMN profiles.status IS 'partial (L0 only) / complete / error';
COMMENT ON COLUMN profiles.snapshot IS 'full AbilityProfile JSON (immutable snapshot)';
COMMENT ON COLUMN profiles.created_at IS 'created at, UTC ISO8601';
COMMENT ON COLUMN profiles.updated_at IS 'last updated at, UTC ISO8601';

-- look up a subject's profiles by recency
CREATE INDEX IF NOT EXISTS idx_profiles_subject_created
  ON profiles (subject_platform, subject_login, created_at DESC);

-- DOWN BEGIN
DROP TABLE IF EXISTS profiles;
-- DOWN END
