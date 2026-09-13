-- Migration 005: create job_postings table for P2 job aggregation
-- File: 005_create_job_postings.sql
-- Date: 2026-09-13 16:30
-- Ref: Decision #16 P2 job aggregation / docs/design-job-ingestion-20260913.md
-- Note: SQLite dialect. Unified job postings ingested from public job APIs.
--       Idempotent same-source dedup via UNIQUE index on (source, source_url).
--       Tags stored as JSON text; salaries normalized to annual USD integers.

CREATE TABLE IF NOT EXISTS job_postings (
  -- internal stable id = sha1(source + NUL + source_url) prefix
  id               TEXT PRIMARY KEY,
  -- source-side job id (string form of the source's native id)
  job_id           TEXT NOT NULL,
  -- job source key (remoteok|remotive|greenhouse|lever|...)
  source           TEXT NOT NULL,
  -- canonical source-side URL (utm stripped), part of dedup unique key
  source_url       TEXT NOT NULL,
  -- job title
  title            TEXT NOT NULL,
  -- company name as given by the source
  company          TEXT NOT NULL,
  -- source-original location text, nullable for fully remote
  location         TEXT,
  -- whether the role is remote
  remote           INTEGER NOT NULL DEFAULT 0,
  -- annual salary lower bound in USD, null when unknown
  salary_min       INTEGER,
  -- annual salary upper bound in USD, null when unknown
  salary_max       INTEGER,
  -- original currency code for audit
  salary_currency  TEXT,
  -- JSON array of tag strings
  tags             TEXT NOT NULL DEFAULT '[]',
  -- HTML-stripped, trimmed plain-text description snapshot
  description      TEXT,
  -- source publish time (UTC ISO8601)
  posted_at        TEXT NOT NULL,
  -- dedicated apply URL when different from source_url
  apply_url        TEXT,
  -- company logo URL
  company_logo_url TEXT,
  -- company home page URL
  company_url      TEXT,
  -- cross-source collision key = sha1(norm(title|company|location))
  normalized_key   TEXT,
  -- lifecycle status: active | inactive
  status           TEXT NOT NULL DEFAULT 'active',
  -- first time this posting was seen by us (never overwritten)
  first_seen_at    TEXT NOT NULL,
  -- most recent time the source still listed it
  last_seen_at     TEXT NOT NULL,
  -- most recent content fetch time
  fetched_at       TEXT NOT NULL,
  -- row created at (UTC ISO8601)
  created_at       TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  -- row last updated at (UTC ISO8601)
  updated_at       TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

-- idempotent same-source dedup key
CREATE UNIQUE INDEX IF NOT EXISTS idx_job_postings_source_url
  ON job_postings (source, source_url);

-- default listing: active roles, newest first
CREATE INDEX IF NOT EXISTS idx_job_postings_status_posted
  ON job_postings (status, posted_at DESC);

-- per-source stats and single-source re-fetch
CREATE INDEX IF NOT EXISTS idx_job_postings_source
  ON job_postings (source);

-- filter by company
CREATE INDEX IF NOT EXISTS idx_job_postings_company
  ON job_postings (company);

-- cross-source collision investigation
CREATE INDEX IF NOT EXISTS idx_job_postings_normalized
  ON job_postings (normalized_key);

-- DOWN BEGIN
DROP TABLE IF EXISTS job_postings;
-- DOWN END
