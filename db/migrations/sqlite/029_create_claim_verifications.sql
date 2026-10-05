-- Migration 029: create claim_verifications table for claim-by-claim checks
-- File: 029_create_claim_verifications.sql
-- Date: 2026-10-05 11:38
-- Depends on: 010
-- Ref: docs/design-claim-verification-20261005.md §4/§6 (decision #23)
-- Note: SQLite dialect. One row = one verdict on one structured claim, i.e. the
--       reverse path that asks whether GitHub traces support a line taken from a
--       resume brought in by someone else. This layer reads profiles but MUST
--       never write back to them, so there is no foreign key and no cascade: a
--       verdict outlives nothing and owns nothing beyond this row. Value domains
--       live in packages/claim-core (no CHECK constraints). The table is named
--       for the verdict rather than the claim to keep it distinguishable from
--       profile claiming, which already owns the /profiles/:id/claim endpoint.
--       profile_id is nullable per design §4 because a claim may exist before a
--       profile is assigned to it; today's API always binds one from the path.

CREATE TABLE IF NOT EXISTS claim_verifications (
  -- verification id (claimv-<uuid>)
  id                    TEXT PRIMARY KEY,
  -- profile snapshot the verdict was computed against (profiles.id); NULL until assigned
  profile_id            TEXT,
  -- evidence-source platform of the claim subject (github|gitee)
  subject_platform      TEXT NOT NULL,
  -- platform login of the claim subject
  subject_login         TEXT NOT NULL,
  -- claimed statement, data-layer original text (English preferred)
  claim_text            TEXT NOT NULL,
  -- how the claim entered the system: manual|resume_import
  claim_source          TEXT NOT NULL,
  -- locator inside an imported document (page/entry); NULL for hand-entered claims
  claim_ref             TEXT,
  -- verdict: supportable|partial|no_trace|insufficient_data
  verdict               TEXT NOT NULL,
  -- JSON array of evidence ids backing the verdict; [] when no_trace or insufficient_data
  matched_evidence_refs TEXT NOT NULL,
  -- support strength 0..1, NOT a fabrication probability; NULL unless supportable|partial
  confidence            REAL,
  -- account that triggered the check (accounts.id); NULL for anonymous paths
  verifier_account_id   TEXT,
  -- claim-core rule version, decoupled from the profile RULE_VERSION
  rule_version          TEXT NOT NULL,
  -- row created at (UTC ISO8601)
  created_at            TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  -- row last updated at (UTC ISO8601)
  updated_at            TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

-- every claim read goes through the owning profile
CREATE INDEX IF NOT EXISTS idx_cv_profile
  ON claim_verifications (profile_id, created_at);

-- looking up a person's claims without knowing the profile id
CREATE INDEX IF NOT EXISTS idx_cv_subject
  ON claim_verifications (subject_platform, subject_login);

-- DOWN BEGIN
DROP INDEX IF EXISTS idx_cv_subject;
DROP INDEX IF EXISTS idx_cv_profile;
DROP TABLE IF EXISTS claim_verifications;
-- DOWN END
