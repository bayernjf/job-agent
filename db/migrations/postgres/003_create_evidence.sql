-- Migration 003: create evidence table for individual evidence item index
-- File: 003_create_evidence.sql
-- Date: 2026-09-11 19:55
-- Dialect: Postgres
-- Ref: PRD 第 8 章 EvidenceItem 契约 / 技术选型 6.4「数据访问抽象层」
-- Note: Postgres dialect. Evidence items are also stored inside profiles.snapshot JSON;
--       this table provides a separate index for per-evidence lookup, cross-profile
--       correlation, and audit trails.

CREATE TABLE IF NOT EXISTS evidence (
  id              TEXT PRIMARY KEY,
  profile_id      TEXT NOT NULL,
  source_platform TEXT NOT NULL DEFAULT 'github',
  source_type     TEXT NOT NULL,
  url             TEXT NOT NULL,
  occurred_at     TEXT,
  layer           TEXT NOT NULL,
  claim           TEXT NOT NULL,
  raw_ref         TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE evidence IS 'Per-evidence index for lookup, cross-profile correlation, audit';
COMMENT ON COLUMN evidence.id IS 'evidenceId, unique per item e.g. commit:owner/repo:sha';
COMMENT ON COLUMN evidence.profile_id IS 'associated profile snapshot (FK not enforced)';
COMMENT ON COLUMN evidence.source_platform IS 'evidence source platform: github';
COMMENT ON COLUMN evidence.source_type IS 'commit | pr | issue | repo | contribution | file';
COMMENT ON COLUMN evidence.url IS 'URL back to the original record';
COMMENT ON COLUMN evidence.occurred_at IS 'when the evidence occurred, ISO8601 UTC; nullable for repo-level';
COMMENT ON COLUMN evidence.layer IS 'analysis layer: L0 | L1 | L2 | L3 | L4';
COMMENT ON COLUMN evidence.claim IS 'human-readable claim this evidence supports';
COMMENT ON COLUMN evidence.raw_ref IS 'raw object pointer (commit sha / PR number), not full data';
COMMENT ON COLUMN evidence.created_at IS 'created at, UTC ISO8601';

-- look up all evidence for a profile
CREATE INDEX IF NOT EXISTS idx_evidence_profile_id
  ON evidence (profile_id);

-- filter by source platform + type
CREATE INDEX IF NOT EXISTS idx_evidence_source
  ON evidence (source_platform, source_type);

-- DOWN BEGIN
DROP TABLE IF EXISTS evidence;
-- DOWN END
