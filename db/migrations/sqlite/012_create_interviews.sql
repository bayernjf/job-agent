-- Migration 012: create interviews table for recruiter interview planning
-- File: 012_create_interviews.sql
-- Date: 2026-09-24 10:00
-- Ref: docs/proposal-interview-planner-20260922.md (handoff item45)
-- Note: SQLite dialect. Recruiter-side interview plans. Personal productivity
--       tool: no recruiter role/organization, every row is owned by the logged
--       in account that created it (created_by_account_id) and all endpoints
--       require an authenticated user. An interview can be created directly
--       from a candidate profile (application_id nullable) or linked to a
--       candidate-side application. target_title/target_company are
--       denormalized so the plan stays readable without an application row.
--       No physical delete: cancelled/no_show are expressed via status.

CREATE TABLE IF NOT EXISTS interviews (
  -- internal stable id = int-<uuid>
  id                     TEXT PRIMARY KEY,
  -- candidate profile snapshot id (primary scope)
  profile_id             TEXT NOT NULL,
  -- linked applications.id when the interview derives from an application; null otherwise
  application_id         TEXT,
  -- denormalized job title for this interview (required even without an application)
  target_title           TEXT NOT NULL,
  -- denormalized company/hiring org name, nullable
  target_company         TEXT,
  -- scheduled start, UTC ISO8601
  scheduled_start        TEXT NOT NULL,
  -- scheduled end, UTC ISO8601, always after scheduled_start
  scheduled_end          TEXT NOT NULL,
  -- interview format: onsite|phone|video
  format                 TEXT NOT NULL,
  -- free-text round label, e.g. recruiter screen / technical / final
  round_label            TEXT NOT NULL,
  -- single interviewer name (free text), nullable in the MVP
  interviewer_name       TEXT,
  -- single interviewer email, nullable
  interviewer_email      TEXT,
  -- lifecycle status: scheduled|completed|cancelled|no_show|rescheduled
  status                 TEXT NOT NULL DEFAULT 'scheduled',
  -- result decision, filled after completion: strong_yes|yes|neutral|no
  outcome                TEXT,
  -- free-text result note
  feedback_note          TEXT,
  -- overall rating 1..5, nullable
  rating                 INTEGER,
  -- owning account id (accounts.id); row-level ownership, required
  created_by_account_id  TEXT NOT NULL,
  -- row created at (UTC ISO8601)
  created_at             TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  -- row last updated at (UTC ISO8601)
  updated_at             TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

-- recruiter's own interview list, optionally filtered by status
CREATE INDEX IF NOT EXISTS idx_interviews_owner_status
  ON interviews (created_by_account_id, status, scheduled_start);

-- interview history for one candidate, time ordered
CREATE INDEX IF NOT EXISTS idx_interviews_profile_start
  ON interviews (profile_id, scheduled_start);

-- lookups from a linked application
CREATE INDEX IF NOT EXISTS idx_interviews_application
  ON interviews (application_id);

-- DOWN BEGIN
DROP TABLE IF EXISTS interviews;
-- DOWN END
