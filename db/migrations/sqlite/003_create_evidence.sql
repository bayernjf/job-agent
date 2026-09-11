-- Migration 003: create evidence table for individual evidence item index
-- File: 003_create_evidence.sql
-- Date: 2026-09-11 16:40
-- Ref: PRD 第 8 章 EvidenceItem 契约 / 技术选型 6.4「数据访问抽象层」
-- Note: SQLite dialect for MVP (inline comments for column meanings). Evidence items
--       are also stored inside profiles.snapshot JSON; this table provides a separate
--       index for per-evidence lookup, cross-profile correlation, and audit trails.

CREATE TABLE IF NOT EXISTS evidence (
  -- evidenceId, unique across all evidence items (e.g. "commit:owner/repo:sha")
  id              TEXT PRIMARY KEY,
  -- associated profile snapshot (FK -> profiles.id, not enforced)
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
  created_at      TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

-- look up all evidence for a profile
CREATE INDEX IF NOT EXISTS idx_evidence_profile_id
  ON evidence (profile_id);

-- filter by source platform + type (e.g. all commits across profiles)
CREATE INDEX IF NOT EXISTS idx_evidence_source
  ON evidence (source_platform, source_type);

-- DOWN BEGIN
DROP TABLE IF EXISTS evidence;
-- DOWN END
