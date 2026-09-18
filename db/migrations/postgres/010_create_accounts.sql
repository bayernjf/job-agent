-- Migration 010: create accounts table for OAuth-authenticated users
-- File: 010_create_accounts.sql
-- Date: 2026-09-18 22:55
-- Dialect: Postgres
-- Depends on: 009
-- Ref: decisions #1-A (owner-authorization spine) / #6-A (claimed profile is authoritative)
-- Note: Postgres dialect. Column set and index names must match the SQLite migration
--       exactly (migrations-parity test). Text columns stay TEXT per the dual-dialect
--       convention (design-storage-dual-dialect), no JSONB/UUID/TIMESTAMPTZ.

CREATE TABLE IF NOT EXISTS accounts (
  id                    TEXT PRIMARY KEY,
  platform              TEXT NOT NULL,
  provider_account_id   TEXT NOT NULL,
  login                 TEXT NOT NULL,
  name                  TEXT,
  email                 TEXT,
  avatar_url            TEXT,
  claimed_profile_id    TEXT,
  created_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE accounts IS 'One row per OAuth platform identity (github|gitee)';
COMMENT ON COLUMN accounts.id IS 'internal stable id, acc-<uuid>';
COMMENT ON COLUMN accounts.platform IS 'identity provider platform: github|gitee';
COMMENT ON COLUMN accounts.provider_account_id IS 'platform-side numeric user id as text';
COMMENT ON COLUMN accounts.login IS 'platform login; must match profiles.subject_login to claim';
COMMENT ON COLUMN accounts.name IS 'display name, best-effort, nullable';
COMMENT ON COLUMN accounts.email IS 'best-effort email, nullable; server-side only, never returned';
COMMENT ON COLUMN accounts.avatar_url IS 'avatar URL, best-effort, nullable';
COMMENT ON COLUMN accounts.claimed_profile_id IS 'owner-claimed profile snapshot id, null until claimed';
COMMENT ON COLUMN accounts.created_at IS 'row created at, UTC ISO8601';
COMMENT ON COLUMN accounts.updated_at IS 'row last updated at, UTC ISO8601';

CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_provider
  ON accounts (platform, provider_account_id);
CREATE INDEX IF NOT EXISTS idx_accounts_platform_login
  ON accounts (platform, login);
CREATE INDEX IF NOT EXISTS idx_accounts_claimed_profile
  ON accounts (claimed_profile_id);

-- DOWN BEGIN
DROP TABLE IF EXISTS accounts;
-- DOWN END
