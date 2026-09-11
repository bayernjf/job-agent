-- Migration 004: create waitlist table for landing page lead capture
-- File: 004_create_waitlist.sql
-- Date: 2026-09-11 16:45
-- Ref: PRD F7 内测留资 / 技术选型 6.4「数据访问抽象层」
-- Note: SQLite dialect for MVP. Stores early-access signups from the landing
--       page and API. Email is unique for dedup.

CREATE TABLE IF NOT EXISTS waitlist (
  -- waitlist entry id
  id              TEXT PRIMARY KEY,
  -- user email (unique for dedup)
  email           TEXT NOT NULL UNIQUE,
  -- user display name (optional)
  name            TEXT,
  -- GitHub username (optional, for pre-provisioning analysis)
  github_username TEXT,
  -- signup source: 'landing_page' | 'api' | 'referral'
  source          TEXT NOT NULL DEFAULT 'landing_page',
  -- entry status: 'pending' | 'contacted' | 'converted' | 'archived'
  status          TEXT NOT NULL DEFAULT 'pending',
  -- optional notes from CRM
  notes           TEXT,
  -- created at (UTC ISO8601)
  created_at      TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  -- last updated at (UTC ISO8601)
  updated_at      TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

-- look up by email (dedup on signup)
CREATE INDEX IF NOT EXISTS idx_waitlist_email
  ON waitlist (email);

-- filter by status for CRM workflows
CREATE INDEX IF NOT EXISTS idx_waitlist_status_created
  ON waitlist (status, created_at DESC);

-- DOWN BEGIN
DROP TABLE IF EXISTS waitlist;
-- DOWN END
