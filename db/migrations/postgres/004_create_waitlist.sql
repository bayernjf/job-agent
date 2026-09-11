-- Migration 004: create waitlist table for landing page lead capture
-- File: 004_create_waitlist.sql
-- Date: 2026-09-11 19:55
-- Dialect: Postgres
-- Ref: PRD F7 内测留资 / 技术选型 6.4「数据访问抽象层」
-- Note: Postgres dialect. Stores early-access signups; email is unique for dedup.

CREATE TABLE IF NOT EXISTS waitlist (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  name            TEXT,
  github_username TEXT,
  source          TEXT NOT NULL DEFAULT 'landing_page',
  status          TEXT NOT NULL DEFAULT 'pending',
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE waitlist IS 'Landing-page / API early-access signups, email unique for dedup';
COMMENT ON COLUMN waitlist.id IS 'waitlist entry id';
COMMENT ON COLUMN waitlist.email IS 'user email, unique for dedup';
COMMENT ON COLUMN waitlist.name IS 'user display name, optional';
COMMENT ON COLUMN waitlist.github_username IS 'GitHub username, optional, for pre-provisioning';
COMMENT ON COLUMN waitlist.source IS 'landing_page | api | referral';
COMMENT ON COLUMN waitlist.status IS 'pending | contacted | converted | archived';
COMMENT ON COLUMN waitlist.notes IS 'optional CRM notes';
COMMENT ON COLUMN waitlist.created_at IS 'created at, UTC ISO8601';
COMMENT ON COLUMN waitlist.updated_at IS 'last updated at, UTC ISO8601';

-- look up by email (dedup on signup)
CREATE INDEX IF NOT EXISTS idx_waitlist_email
  ON waitlist (email);

-- filter by status for CRM workflows
CREATE INDEX IF NOT EXISTS idx_waitlist_status_created
  ON waitlist (status, created_at DESC);

-- DOWN BEGIN
DROP TABLE IF EXISTS waitlist;
-- DOWN END
