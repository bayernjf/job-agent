-- Migration 014: alter evidence primary key to (profile_id, id)
-- File: 014_alter_evidence_primary_key.sql
-- Date: 2026-09-26 00:53
-- Depends on: 003
-- Ref: docs/design-c-side-first-20260925.md §9 (T31), docs/评审-MVP-20260925.md §9.5
-- Note: Postgres dialect, mirrors sqlite/014. 003 declared `id` as the primary key
--       with the comment "unique across all evidence items", but an evidenceId comes
--       from the upstream object ("pr:owner/repo#12"), so it legitimately repeats for
--       two profiles and for one profile on every re-analysis; importFromProfile then
--       aborts the job on a unique violation (reproduced against live GitHub). The key
--       becomes composite (profile_id, id). Re-keying existing rows is safe because the
--       old key was strictly stronger. No data is rewritten and no index is dropped.

ALTER TABLE evidence DROP CONSTRAINT evidence_pkey;

ALTER TABLE evidence ADD PRIMARY KEY (profile_id, id);

COMMENT ON TABLE evidence IS
  'Per-profile evidence index rows backing the ability profile snapshot.';
COMMENT ON COLUMN evidence.id IS
  'evidenceId as written in the profile snapshot (e.g. pr:owner/repo#12); unique only together with profile_id';
COMMENT ON COLUMN evidence.profile_id IS
  'Owning profile snapshot id (FK -> profiles.id, not enforced); scopes evidence.id';

-- DOWN BEGIN
-- Rolling back restores a globally unique id. No PL/pgSQL guard on purpose: the migrator
-- splits statements on ';' and would cut a DO $$ ... $$ block mid-flight (hit during
-- verification), and it also runs each statement outside a transaction, so a guard that
-- aborts halfway would leave the table with no primary key at all. Therefore:
--   * DROP uses IF EXISTS so a retry after a failed attempt is not blocked by the fact
--     that the first attempt already removed the constraint;
--   * the ADD PRIMARY KEY below fails loudly with a unique violation whenever any
--     evidenceId is shared across profiles, refusing the rollback instead of deleting
--     rows to force it through.
ALTER TABLE evidence DROP CONSTRAINT IF EXISTS evidence_pkey;
ALTER TABLE evidence ADD PRIMARY KEY (id);
COMMENT ON TABLE evidence IS NULL;
COMMENT ON COLUMN evidence.id IS
  'evidenceId, unique across all evidence items (e.g. commit:owner/repo:sha)';
COMMENT ON COLUMN evidence.profile_id IS 'associated profile snapshot (FK -> profiles.id, not enforced)';
-- DOWN END
