-- Migration 010: create accounts table for OAuth-authenticated users
-- File: 010_create_accounts.sql
-- Date: 2026-09-18 22:55
-- Depends on: 009
-- Ref: decisions #1-A (owner-authorization spine) / #6-A (claimed profile is authoritative)
-- Note: SQLite dialect. One row per platform identity (github|gitee). The natural
--       unique key is (platform, provider_account_id). Minimal PII: name/email/avatar
--       are best-effort provider fields and nullable; email is never exposed by the API.
--       claimed_profile_id links the owner-claimed snapshot (also flagged on
--       profiles.subject_claimed). No foreign-key constraints, matching existing tables.

CREATE TABLE IF NOT EXISTS accounts (
  -- internal stable id = acc-<uuid>
  id                    TEXT PRIMARY KEY,
  -- identity provider platform: github|gitee
  platform              TEXT NOT NULL,
  -- platform-side numeric user id, stored as text
  provider_account_id   TEXT NOT NULL,
  -- platform login name (must match profiles.subject_login for a valid claim)
  login                 TEXT NOT NULL,
  -- display name, best-effort and nullable
  name                  TEXT,
  -- best-effort email, nullable; server-side only and never returned to clients
  email                 TEXT,
  -- avatar URL, best-effort and nullable
  avatar_url            TEXT,
  -- owner-claimed profile snapshot id, null until the user claims one
  claimed_profile_id    TEXT,
  -- row created at (UTC ISO8601)
  created_at            TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  -- row last updated at (UTC ISO8601)
  updated_at            TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

-- one account per platform identity
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_provider
  ON accounts (platform, provider_account_id);
-- look an account up by platform login (claim ownership check)
CREATE INDEX IF NOT EXISTS idx_accounts_platform_login
  ON accounts (platform, login);
-- find which account claimed a given profile snapshot
CREATE INDEX IF NOT EXISTS idx_accounts_claimed_profile
  ON accounts (claimed_profile_id);

-- DOWN BEGIN
DROP TABLE IF EXISTS accounts;
-- DOWN END
