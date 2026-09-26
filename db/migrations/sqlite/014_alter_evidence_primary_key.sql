-- Migration 014: alter evidence primary key to (profile_id, id)
-- File: 014_alter_evidence_primary_key.sql
-- Date: 2026-09-26 00:53
-- Depends on: 003
-- Ref: docs/design-c-side-first-20260925.md §9 (T31), docs/评审-MVP-20260925.md §9.5
-- Note: SQLite dialect. 003 declared `id` as the table primary key and commented it
--       as "unique across all evidence items". That assumption is false: an
--       evidenceId is derived from the upstream object (e.g. "pr:owner/repo#12",
--       "commit:owner/repo:sha"), so the very same id legitimately recurs for two
--       profiles, and for one profile again on every re-analysis. With the old key,
--       importFromProfile then aborts the whole job on a UNIQUE violation -- found by
--       running the worker twice against live GitHub, second run failing with
--       SQLITE_CONSTRAINT_PRIMARYKEY. The key becomes composite (profile_id, id).
--       Existing rows are safe to re-key: the old key was strictly stronger, so no
--       (profile_id, id) pair can repeat. Columns are copied explicitly, and inline
--       comments carry over because SQLite keeps the source text on rename.

CREATE TABLE IF NOT EXISTS evidence_scoped (
  -- evidenceId, unique only within its own profile snapshot
  id              TEXT NOT NULL,
  -- owning profile snapshot (FK -> profiles.id, not enforced)
  profile_id      TEXT NOT NULL,
  -- evidence source platform: 'github' (P1: gitee / portfolio)
  source_platform TEXT NOT NULL DEFAULT 'github',
  -- evidence type: 'commit' | 'pr' | 'issue' | 'repo' | 'contribution' | 'file'
  source_type     TEXT NOT NULL,
  -- URL to click back to the original record
  url             TEXT NOT NULL,
  -- when the evidence occurred (ISO8601 UTC), nullable for repo-level evidence
  occurred_at     TEXT,
  -- analysis layer this evidence belongs to: 'L0' | 'L1' | 'L2' | 'L3' | 'L4'
  layer           TEXT NOT NULL,
  -- human-readable claim this evidence supports
  claim           TEXT NOT NULL,
  -- raw object pointer (e.g. commit sha / PR number), not redundant full data
  raw_ref         TEXT NOT NULL,
  -- created at (UTC ISO8601)
  created_at      TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  PRIMARY KEY (profile_id, id)
);

INSERT INTO evidence_scoped (
  id, profile_id, source_platform, source_type, url,
  occurred_at, layer, claim, raw_ref, created_at
)
SELECT
  id, profile_id, source_platform, source_type, url,
  occurred_at, layer, claim, raw_ref, created_at
FROM evidence;

DROP TABLE evidence;

ALTER TABLE evidence_scoped RENAME TO evidence;

-- look up all evidence for a profile
CREATE INDEX IF NOT EXISTS idx_evidence_profile_id
  ON evidence (profile_id);

-- filter by source platform + type (e.g. all commits across profiles)
CREATE INDEX IF NOT EXISTS idx_evidence_source
  ON evidence (source_platform, source_type);

-- DOWN BEGIN
-- Rolling back restores a globally unique id, which is only possible while no id
-- is shared by two profiles. If one is, the UNIQUE violation below aborts the
-- rollback loudly instead of dropping evidence rows to force it through.
DROP INDEX IF EXISTS idx_evidence_source;
DROP INDEX IF EXISTS idx_evidence_profile_id;
CREATE TABLE evidence_unscoped (
  id              TEXT PRIMARY KEY,
  profile_id      TEXT NOT NULL,
  source_platform TEXT NOT NULL DEFAULT 'github',
  source_type     TEXT NOT NULL,
  url             TEXT NOT NULL,
  occurred_at     TEXT,
  layer           TEXT NOT NULL,
  claim            TEXT NOT NULL,
  raw_ref         TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
INSERT INTO evidence_unscoped (
  id, profile_id, source_platform, source_type, url,
  occurred_at, layer, claim, raw_ref, created_at
)
SELECT
  id, profile_id, source_platform, source_type, url,
  occurred_at, layer, claim, raw_ref, created_at
FROM evidence;
DROP TABLE evidence;
ALTER TABLE evidence_unscoped RENAME TO evidence;
CREATE INDEX IF NOT EXISTS idx_evidence_profile_id
  ON evidence (profile_id);
CREATE INDEX IF NOT EXISTS idx_evidence_source
  ON evidence (source_platform, source_type);
-- DOWN END
