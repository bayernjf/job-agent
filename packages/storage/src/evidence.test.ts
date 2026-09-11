import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { EvidenceItem } from '@jobagent/shared';
import { runMigrations } from './sqlite/migrator.js';
import { openSqlite } from './sqlite/connection.js';
import { SqliteEvidenceRepository } from './sqlite/evidence-repo.js';
import type { NewEvidence } from './entities/index.js';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../db/migrations/sqlite',
);

function freshRepo(): SqliteEvidenceRepository {
  const { client, db } = openSqlite(':memory:');
  runMigrations(client, MIGRATIONS_DIR);
  return new SqliteEvidenceRepository(db);
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

describe('SqliteEvidenceRepository', () => {
  it('inserts and retrieves evidence by id', async () => {
    const repo = freshRepo();
    await repo.insert(sampleEvidence('ev-001'));

    const ev = await repo.getById('ev-001');
    expect(ev).toBeDefined();
    expect(ev!.id).toBe('ev-001');
    expect(ev!.profileId).toBe('prof-001');
    expect(ev!.sourcePlatform).toBe('github');
    expect(ev!.sourceType).toBe('commit');
    expect(ev!.layer).toBe('L1');
    expect(ev!.claim).toBeTruthy();
    expect(ev!.rawRef).toBe('ev-001');
  });

  it('returns undefined for non-existent id', async () => {
    const repo = freshRepo();
    expect(await repo.getById('nonexistent')).toBeUndefined();
  });

  it('batch inserts evidence in a transaction', async () => {
    const repo = freshRepo();
    await repo.insertBatch([
      sampleEvidence('ev-001'),
      sampleEvidence('ev-002'),
      sampleEvidence('ev-003'),
    ]);

    expect(await repo.getById('ev-001')).toBeDefined();
    expect(await repo.getById('ev-002')).toBeDefined();
    expect(await repo.getById('ev-003')).toBeDefined();
    expect(await repo.countByProfile('prof-001')).toBe(3);
  });

  it('handles empty batch insert gracefully', async () => {
    const repo = freshRepo();
    await expect(repo.insertBatch([])).resolves.toBeUndefined();
  });

  it('lists evidence by profile id', async () => {
    const repo = freshRepo();
    await repo.insertBatch([
      sampleEvidence('ev-001', 'prof-a'),
      sampleEvidence('ev-002', 'prof-a'),
      sampleEvidence('ev-003', 'prof-b'),
    ]);

    const profA = await repo.listByProfile('prof-a');
    expect(profA).toHaveLength(2);
    expect(profA.map((e) => e.id).sort()).toEqual(['ev-001', 'ev-002']);

    const profB = await repo.listByProfile('prof-b');
    expect(profB).toHaveLength(1);
    expect(profB[0]!.id).toBe('ev-003');
  });

  it('counts evidence by profile', async () => {
    const repo = freshRepo();
    await repo.insertBatch([sampleEvidence('ev-001'), sampleEvidence('ev-002')]);
    expect(await repo.countByProfile('prof-001')).toBe(2);
    expect(await repo.countByProfile('nonexistent')).toBe(0);
  });

  it('imports evidence from AbilityProfile EvidenceItem list', async () => {
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

    await repo.importFromProfile('prof-import', items);
    expect(await repo.countByProfile('prof-import')).toBe(2);

    const commitEv = await repo.getById('commit:owner/repo:abc123');
    expect(commitEv).toBeDefined();
    expect(commitEv!.sourceType).toBe('commit');
    expect(commitEv!.layer).toBe('L1');

    const repoEv = await repo.getById('repo:owner/repo');
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
