import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { EvidenceItem } from '@jobagent/shared';
import { runMigrations } from './migrator.js';
import { EvidenceRepository, type NewEvidence } from './evidence.js';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../db/migrations/sqlite',
);

function freshRepo(): EvidenceRepository {
  const db = new Database(':memory:');
  runMigrations(db, MIGRATIONS_DIR);
  const orm = drizzle(db);
  return new EvidenceRepository(orm);
}

function sampleEvidence(id: string, profileId = 'prof-001'): NewEvidence {
  return {
    id,
    profileId,
    sourceType: 'commit',
    url: `https://github.com/owner/repo/commit/${id}`,
    occurredAt: '2026-09-01T00:00:00.000Z',
    layer: 'L1',
    claim: 'Active contribution to owner/repo',
    rawRef: id,
  };
}

describe('EvidenceRepository', () => {
  it('inserts and retrieves evidence by id', () => {
    const repo = freshRepo();
    repo.insert(sampleEvidence('ev-001'));

    const ev = repo.getById('ev-001');
    expect(ev).toBeDefined();
    expect(ev!.id).toBe('ev-001');
    expect(ev!.profileId).toBe('prof-001');
    expect(ev!.sourcePlatform).toBe('github');
    expect(ev!.sourceType).toBe('commit');
    expect(ev!.layer).toBe('L1');
    expect(ev!.claim).toBeTruthy();
    expect(ev!.rawRef).toBe('ev-001');
  });

  it('returns undefined for non-existent id', () => {
    const repo = freshRepo();
    expect(repo.getById('nonexistent')).toBeUndefined();
  });

  it('batch inserts evidence in a transaction', () => {
    const repo = freshRepo();
    repo.insertBatch([
      sampleEvidence('ev-001'),
      sampleEvidence('ev-002'),
      sampleEvidence('ev-003'),
    ]);

    expect(repo.getById('ev-001')).toBeDefined();
    expect(repo.getById('ev-002')).toBeDefined();
    expect(repo.getById('ev-003')).toBeDefined();
    expect(repo.countByProfile('prof-001')).toBe(3);
  });

  it('handles empty batch insert gracefully', () => {
    const repo = freshRepo();
    expect(() => repo.insertBatch([])).not.toThrow();
  });

  it('lists evidence by profile id', () => {
    const repo = freshRepo();
    repo.insertBatch([
      sampleEvidence('ev-001', 'prof-a'),
      sampleEvidence('ev-002', 'prof-a'),
      sampleEvidence('ev-003', 'prof-b'),
    ]);

    const profA = repo.listByProfile('prof-a');
    expect(profA).toHaveLength(2);
    expect(profA.map((e) => e.id).sort()).toEqual(['ev-001', 'ev-002']);

    const profB = repo.listByProfile('prof-b');
    expect(profB).toHaveLength(1);
    expect(profB[0]!.id).toBe('ev-003');
  });

  it('counts evidence by profile', () => {
    const repo = freshRepo();
    repo.insertBatch([sampleEvidence('ev-001'), sampleEvidence('ev-002')]);
    expect(repo.countByProfile('prof-001')).toBe(2);
    expect(repo.countByProfile('nonexistent')).toBe(0);
  });

  it('imports evidence from AbilityProfile EvidenceItem list', () => {
    const repo = freshRepo();
    const items: EvidenceItem[] = [
      {
        evidenceId: 'commit:owner/repo:abc123',
        sourcePlatform: 'github',
        sourceType: 'commit',
        url: 'https://github.com/owner/repo/commit/abc123',
        occurredAt: '2026-09-01T00:00:00.000Z',
        layer: 'L1',
        claim: 'Test commit evidence',
        rawRef: 'abc123',
      },
      {
        evidenceId: 'repo:owner/repo',
        sourcePlatform: 'github',
        sourceType: 'repo',
        url: 'https://github.com/owner/repo',
        layer: 'L0',
        claim: 'Test repo evidence',
        rawRef: 'owner/repo',
      },
    ];

    repo.importFromProfile('prof-import', items);
    expect(repo.countByProfile('prof-import')).toBe(2);

    const commitEv = repo.getById('commit:owner/repo:abc123');
    expect(commitEv).toBeDefined();
    expect(commitEv!.sourceType).toBe('commit');
    expect(commitEv!.layer).toBe('L1');

    const repoEv = repo.getById('repo:owner/repo');
    expect(repoEv).toBeDefined();
    expect(repoEv!.sourceType).toBe('repo');
    expect(repoEv!.occurredAt).toBeNull();
  });

  it('migration 003 creates evidence table with expected columns', () => {
    const db = new Database(':memory:');
    runMigrations(db, MIGRATIONS_DIR);

    const columns = db
      .prepare("PRAGMA table_info(evidence)")
      .all() as Array<{ name: string }>;
    const colNames = columns.map((c) => c.name);

    for (const expected of [
      'id', 'profile_id', 'source_platform', 'source_type', 'url',
      'occurred_at', 'layer', 'claim', 'raw_ref', 'created_at',
    ]) {
      expect(colNames).toContain(expected);
    }

    db.close();
  });
});
