-- Migration 016: create profile_removal_requests table for per-subject withdrawal
-- File: 016_create_profile_removal_requests.sql
-- Date: 2026-10-01 23:57
-- Depends on: 001
-- Ref: docs/design-profile-removal-request-20261001.md (audit S3)
-- Note: SQLite dialect. Withdrawal ticket for a profile whose share link cannot
--       otherwise be revoked: DELETE /profiles/:id is owner-only, so an
--       unclaimed profile had no self-service removal path. The requester
--       cannot be authenticated, therefore a request is only *recorded* here
--       (with salted IP hash for abuse review) and executed by an operator via
--       the CLI after manual review — never auto-applied. Decoupling the
--       audit trail from the query-state flag (017 profiles.removal_requested_at)
--       keeps lookups free of a subquery. No foreign keys anywhere in this
--       schema; cascade delete is performed by the application layer.

CREATE TABLE IF NOT EXISTS profile_removal_requests (
  -- internal stable id, rem-<uuid>
  id           TEXT PRIMARY KEY,
  -- target profiles.id (no FK; cascade delete runs in the application layer)
  profile_id   TEXT NOT NULL,
  -- ticket lifecycle: pending|approved|rejected
  status       TEXT NOT NULL DEFAULT 'pending',
  -- optional free-text reason supplied by the requester
  reason       TEXT,
  -- optional contact (email/handle) so the reviewer can follow up; PII minimised
  contact      TEXT,
  -- salted hash of the requesting IP (same helper as demo_rate_events)
  ip_hash      TEXT,
  -- submission moment, UTC ISO8601
  created_at   TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  -- review decision moment, UTC ISO8601; NULL while pending
  decided_at   TEXT
);

-- idempotency lookup: at most one pending ticket per profile
CREATE INDEX IF NOT EXISTS idx_prr_profile_status
  ON profile_removal_requests (profile_id, status);

-- reviewer queue, newest first
CREATE INDEX IF NOT EXISTS idx_prr_status_created
  ON profile_removal_requests (status, created_at);

-- DOWN BEGIN
DROP INDEX IF EXISTS idx_prr_status_created;
DROP INDEX IF EXISTS idx_prr_profile_status;
DROP TABLE IF EXISTS profile_removal_requests;
-- DOWN END
