-- Migration 029: create claim_verifications table for claim-by-claim checks
-- File: 029_create_claim_verifications.sql
-- Date: 2026-10-05 11:38
-- Dialect: Postgres
-- Depends on: 010
-- Ref: docs/design-claim-verification-20261005.md §4/§6 (decision #23)
-- Note: Postgres dialect. Column set and index names must match the SQLite
--       migration exactly (migrations-parity test). One row = one verdict on one
--       structured claim: the reverse path asking whether GitHub traces support a
--       line taken from a resume brought in by someone else. This layer reads
--       profiles but MUST never write back to them, so no foreign key and no
--       cascade. Value domains live in packages/claim-core (no CHECK constraints).
--       Named for the verdict rather than the claim so it cannot be confused with
--       profile claiming, which already owns /profiles/:id/claim.

CREATE TABLE IF NOT EXISTS claim_verifications (
  id                    TEXT PRIMARY KEY,
  profile_id            TEXT,
  subject_platform      TEXT NOT NULL,
  subject_login         TEXT NOT NULL,
  claim_text            TEXT NOT NULL,
  claim_source          TEXT NOT NULL,
  claim_ref             TEXT,
  verdict               TEXT NOT NULL,
  matched_evidence_refs TEXT NOT NULL,
  confidence            REAL,
  verifier_account_id   TEXT,
  rule_version          TEXT NOT NULL,
  created_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE claim_verifications IS 'Verdicts on single resume claims (design §4): evidence-supported or not, never a fabrication score';
COMMENT ON COLUMN claim_verifications.id IS 'verification id (claimv-<uuid>)';
COMMENT ON COLUMN claim_verifications.profile_id IS 'profile snapshot the verdict was computed against (profiles.id); NULL until assigned';
COMMENT ON COLUMN claim_verifications.subject_platform IS 'evidence-source platform of the claim subject (github|gitee)';
COMMENT ON COLUMN claim_verifications.subject_login IS 'platform login of the claim subject';
COMMENT ON COLUMN claim_verifications.claim_text IS 'claimed statement, data-layer original text (English preferred)';
COMMENT ON COLUMN claim_verifications.claim_source IS 'how the claim entered the system: manual|resume_import';
COMMENT ON COLUMN claim_verifications.claim_ref IS 'locator inside an imported document (page/entry); NULL for hand-entered claims';
COMMENT ON COLUMN claim_verifications.verdict IS 'verdict: supportable|partial|no_trace|insufficient_data';
COMMENT ON COLUMN claim_verifications.matched_evidence_refs IS 'JSON array of evidence ids backing the verdict; [] when no_trace or insufficient_data';
COMMENT ON COLUMN claim_verifications.confidence IS 'support strength 0..1, NOT a fabrication probability; NULL unless supportable|partial';
COMMENT ON COLUMN claim_verifications.verifier_account_id IS 'account that triggered the check (accounts.id); NULL for anonymous paths';
COMMENT ON COLUMN claim_verifications.rule_version IS 'claim-core rule version, decoupled from the profile RULE_VERSION';
COMMENT ON COLUMN claim_verifications.created_at IS 'row created at (UTC ISO8601)';
COMMENT ON COLUMN claim_verifications.updated_at IS 'row last updated at (UTC ISO8601)';

CREATE INDEX IF NOT EXISTS idx_cv_profile
  ON claim_verifications (profile_id, created_at);

CREATE INDEX IF NOT EXISTS idx_cv_subject
  ON claim_verifications (subject_platform, subject_login);

-- DOWN BEGIN
DROP INDEX IF EXISTS idx_cv_subject;
DROP INDEX IF EXISTS idx_cv_profile;
DROP TABLE IF EXISTS claim_verifications;
-- DOWN END
