-- Migration 016: create profile_removal_requests table for per-subject withdrawal
-- File: 016_create_profile_removal_requests.sql
-- Date: 2026-10-01 23:57
-- Dialect: Postgres
-- Depends on: 001
-- Ref: docs/design-profile-removal-request-20261001.md (audit S3)
-- Note: Postgres dialect. Column set and index names must match the SQLite
--       migration exactly (migrations-parity test). Withdrawal ticket for a
--       profile whose share link cannot otherwise be revoked: DELETE
--       /profiles/:id is owner-only, so an unclaimed profile had no
--       self-service removal path. The requester cannot be authenticated,
--       therefore a request is only *recorded* here (with salted IP hash for
--       abuse review) and executed by an operator via the CLI after manual
--       review — never auto-applied. Decoupling the audit trail from the
--       query-state flag (017 profiles.removal_requested_at) keeps lookups
--       free of a subquery. No foreign keys; cascade delete is application-side.

CREATE TABLE IF NOT EXISTS profile_removal_requests (
  id           TEXT PRIMARY KEY,
  profile_id   TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  reason       TEXT,
  contact      TEXT,
  ip_hash      TEXT,
  created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_at   TEXT
);

COMMENT ON TABLE profile_removal_requests IS 'Per-subject withdrawal tickets; pending rows hold the target profile until an operator approves or rejects them';
COMMENT ON COLUMN profile_removal_requests.id IS 'internal stable id, rem-<uuid>';
COMMENT ON COLUMN profile_removal_requests.profile_id IS 'target profiles.id (no FK; cascade delete runs in the application layer)';
COMMENT ON COLUMN profile_removal_requests.status IS 'pending|approved|rejected';
COMMENT ON COLUMN profile_removal_requests.reason IS 'optional free-text reason supplied by the requester';
COMMENT ON COLUMN profile_removal_requests.contact IS 'optional requester contact (email/handle) for reviewer follow-up; PII minimised';
COMMENT ON COLUMN profile_removal_requests.ip_hash IS 'salted hash of the requesting IP, same helper as demo_rate_events';
COMMENT ON COLUMN profile_removal_requests.created_at IS 'submission moment, UTC ISO8601';
COMMENT ON COLUMN profile_removal_requests.decided_at IS 'review decision moment, UTC ISO8601; NULL while pending';

CREATE INDEX IF NOT EXISTS idx_prr_profile_status
  ON profile_removal_requests (profile_id, status);

CREATE INDEX IF NOT EXISTS idx_prr_status_created
  ON profile_removal_requests (status, created_at);

-- DOWN BEGIN
DROP INDEX IF EXISTS idx_prr_status_created;
DROP INDEX IF EXISTS idx_prr_profile_status;
DROP TABLE IF EXISTS profile_removal_requests;
-- DOWN END
