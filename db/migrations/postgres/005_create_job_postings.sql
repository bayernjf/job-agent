-- Migration 005: create job_postings table for P2 job aggregation
-- File: 005_create_job_postings.sql
-- Date: 2026-09-13 16:30
-- Dialect: Postgres
-- Ref: Decision #16 P2 job aggregation / docs/design-job-ingestion-20260913.md
-- Note: Postgres dialect. Column set and index names must match the SQLite
--       migration exactly (migrations-parity test). Tags stored as JSON text.

CREATE TABLE IF NOT EXISTS job_postings (
  id               TEXT PRIMARY KEY,
  job_id           TEXT NOT NULL,
  source           TEXT NOT NULL,
  source_url       TEXT NOT NULL,
  title            TEXT NOT NULL,
  company          TEXT NOT NULL,
  location         TEXT,
  remote           BOOLEAN NOT NULL DEFAULT FALSE,
  salary_min       INTEGER,
  salary_max       INTEGER,
  salary_currency  TEXT,
  tags             TEXT NOT NULL DEFAULT '[]',
  description      TEXT,
  posted_at        TEXT NOT NULL,
  apply_url        TEXT,
  company_logo_url TEXT,
  company_url      TEXT,
  normalized_key   TEXT,
  status           TEXT NOT NULL DEFAULT 'active',
  first_seen_at    TEXT NOT NULL,
  last_seen_at     TEXT NOT NULL,
  fetched_at       TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE job_postings IS 'Unified public-API job postings, dedup key (source, source_url)';
COMMENT ON COLUMN job_postings.id IS 'internal stable id, sha1(source + NUL + source_url) prefix';
COMMENT ON COLUMN job_postings.job_id IS 'source-side job id, string form of native id';
COMMENT ON COLUMN job_postings.source IS 'job source key: remoteok|remotive|greenhouse|lever|...';
COMMENT ON COLUMN job_postings.source_url IS 'canonical source URL, utm stripped, dedup unique key';
COMMENT ON COLUMN job_postings.title IS 'job title';
COMMENT ON COLUMN job_postings.company IS 'company name as given by the source';
COMMENT ON COLUMN job_postings.location IS 'source-original location text, nullable for remote';
COMMENT ON COLUMN job_postings.remote IS 'whether the role is remote';
COMMENT ON COLUMN job_postings.salary_min IS 'annual lower bound in USD, null when unknown';
COMMENT ON COLUMN job_postings.salary_max IS 'annual upper bound in USD, null when unknown';
COMMENT ON COLUMN job_postings.salary_currency IS 'original currency code for audit';
COMMENT ON COLUMN job_postings.tags IS 'JSON array of tag strings';
COMMENT ON COLUMN job_postings.description IS 'HTML-stripped trimmed plain-text snapshot';
COMMENT ON COLUMN job_postings.posted_at IS 'source publish time, UTC ISO8601';
COMMENT ON COLUMN job_postings.apply_url IS 'dedicated apply URL when different from source_url';
COMMENT ON COLUMN job_postings.company_logo_url IS 'company logo URL';
COMMENT ON COLUMN job_postings.company_url IS 'company home page URL';
COMMENT ON COLUMN job_postings.normalized_key IS 'cross-source collision key sha1(norm(title|company|location))';
COMMENT ON COLUMN job_postings.status IS 'active | inactive';
COMMENT ON COLUMN job_postings.first_seen_at IS 'first time seen, never overwritten';
COMMENT ON COLUMN job_postings.last_seen_at IS 'most recent time the source still listed it';
COMMENT ON COLUMN job_postings.fetched_at IS 'most recent content fetch time';
COMMENT ON COLUMN job_postings.created_at IS 'row created at, UTC ISO8601';
COMMENT ON COLUMN job_postings.updated_at IS 'row last updated at, UTC ISO8601';

CREATE UNIQUE INDEX IF NOT EXISTS idx_job_postings_source_url
  ON job_postings (source, source_url);

CREATE INDEX IF NOT EXISTS idx_job_postings_status_posted
  ON job_postings (status, posted_at DESC);

CREATE INDEX IF NOT EXISTS idx_job_postings_source
  ON job_postings (source);

CREATE INDEX IF NOT EXISTS idx_job_postings_company
  ON job_postings (company);

CREATE INDEX IF NOT EXISTS idx_job_postings_normalized
  ON job_postings (normalized_key);

-- DOWN BEGIN
DROP TABLE IF EXISTS job_postings;
-- DOWN END
