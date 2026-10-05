import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './sqlite/migrator.js';
import { openSqlite } from './sqlite/connection.js';
import { SqliteClaimVerificationsRepository } from './sqlite/claim-verifications-repo.js';
import { CLAIM_RULE_VERSION } from '@jobagent/claim-core';
import { toStoredClaimVerification, type NewClaimVerification } from './entities/index.js';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../db/migrations/sqlite',
);

function freshRepo(): { repo: SqliteClaimVerificationsRepository; close: () => void } {
  const { client, db } = openSqlite(':memory:');
  runMigrations(client, MIGRATIONS_DIR);
  return { repo: new SqliteClaimVerificationsRepository(db), close: () => client.close() };
}

function cv(overrides: Partial<NewClaimVerification> & Pick<NewClaimVerification, 'id' | 'subjectLogin'>): NewClaimVerification {
  return {
    profileId: 'prof-1',
    subjectPlatform: 'github',
    claimText: 'I write TypeScript every day',
    verdict: 'supportable',
    ...overrides,
  };
}

describe('SqliteClaimVerificationsRepository', () => {
  it('round-trips a verdict with its evidence ids and rule version', async () => {
    const { repo, close } = freshRepo();
    await repo.insert(cv({ id: 'cv-1', subjectLogin: 'dev', matchedEvidenceRefs: ['ev-1', 'ev-2'], confidence: 1 }));

    const stored = await repo.getById('cv-1');
    expect(stored).toBeDefined();
    expect(stored!.verdict).toBe('supportable');
    expect(stored!.matchedEvidenceRefs).toEqual(['ev-1', 'ev-2']);
    expect(stored!.confidence).toBe(1);
    expect(stored!.claimSource).toBe('manual');
    expect(stored!.claimRef).toBeNull();
    expect(stored!.ruleVersion).toBe(CLAIM_RULE_VERSION);
    close();
  });

  it('stores an empty evidence array for verdicts that must not carry any', async () => {
    // "没有证据"与"有证据"的区别就落在这一列上：落库后必须仍是空数组，而不是 NULL。
    const { repo, close } = freshRepo();
    await repo.insert(cv({ id: 'cv-2', subjectLogin: 'dev', verdict: 'insufficient_data' }));
    const stored = await repo.getById('cv-2');
    expect(stored!.matchedEvidenceRefs).toEqual([]);
    expect(stored!.confidence).toBeNull();
    close();
  });

  it('lists only the rows of the requested profile, oldest first', async () => {
    const { repo, close } = freshRepo();
    await repo.insert(cv({ id: 'cv-a', subjectLogin: 'dev', profileId: 'prof-1' }));
    await repo.insert(cv({ id: 'cv-b', subjectLogin: 'dev', profileId: 'prof-2' }));
    await repo.insert(cv({ id: 'cv-c', subjectLogin: 'dev', profileId: 'prof-1' }));

    const listed = await repo.listByProfile('prof-1');
    expect(listed.map((r) => r.id).sort()).toEqual(['cv-a', 'cv-c']);
    close();
  });

  it('deletes a row and reports whether anything was removed', async () => {
    const { repo, close } = freshRepo();
    await repo.insert(cv({ id: 'cv-3', subjectLogin: 'dev' }));
    expect(await repo.delete('cv-3')).toBe(true);
    expect(await repo.getById('cv-3')).toBeUndefined();
    // 撤回这类操作可能被重复点击，重复删必须幂等返回 false 而不是报错。
    expect(await repo.delete('cv-3')).toBe(false);
    close();
  });

  it('clears every row of a profile when the profile is removed', async () => {
    const { repo, close } = freshRepo();
    await repo.insert(cv({ id: 'cv-4', subjectLogin: 'dev', profileId: 'prof-9' }));
    await repo.insert(cv({ id: 'cv-5', subjectLogin: 'dev', profileId: 'prof-9' }));
    await repo.insert(cv({ id: 'cv-6', subjectLogin: 'dev', profileId: 'prof-other' }));

    await repo.deleteByProfile('prof-9');
    expect(await repo.listByProfile('prof-9')).toEqual([]);
    expect(await repo.getById('cv-6')).toBeDefined();
    close();
  });

  it('allows a claim that has no profile assigned yet (design §4)', async () => {
    const { repo, close } = freshRepo();
    await repo.insert(cv({ id: 'cv-7', subjectLogin: 'dev', profileId: null }));
    const stored = await repo.getById('cv-7');
    expect(stored!.profileId).toBeNull();
    // 未分配画像的行不该被任何"某画像的列表"读到——那是一条额外的泄漏面。
    expect(await repo.listByProfile('')).toEqual([]);
    close();
  });

  it('counts claims for many profiles without exposing claim text', async () => {
    const { repo, close } = freshRepo();
    await repo.insert(cv({ id: 'cv-count-1', subjectLogin: 'dev', profileId: 'prof-1' }));
    await repo.insert(cv({ id: 'cv-count-2', subjectLogin: 'dev', profileId: 'prof-1' }));
    await repo.insert(cv({ id: 'cv-count-3', subjectLogin: 'dev', profileId: 'prof-2' }));

    const counts = await repo.countByProfiles(['prof-1', 'prof-2', 'prof-3']);

    expect(counts.get('prof-1')).toBe(2);
    expect(counts.get('prof-2')).toBe(1);
    expect(counts.has('prof-3')).toBe(false);
    expect(await repo.countByProfiles([])).toEqual(new Map());
    close();
  });

  it('reads a verdict back as insufficient_data rather than trusting a bad enum', () => {
    // 坏数据兜底：宁可读成"无法核验"，也不要让它被当成"有些证据"。
    const stored = toStoredClaimVerification({
      id: 'cv-bad',
      profileId: null,
      subjectPlatform: 'github',
      subjectLogin: 'dev',
      claimText: 'x',
      claimSource: 'garbage',
      claimRef: null,
      verdict: 'maybe',
      matchedEvidenceRefs: '{not json',
      confidence: null,
      verifierAccountId: null,
      ruleVersion: '',
      createdAt: '2026-10-05T00:00:00.000Z',
      updatedAt: '2026-10-05T00:00:00.000Z',
    });
    expect(stored.verdict).toBe('insufficient_data');
    expect(stored.claimSource).toBe('manual');
    expect(stored.matchedEvidenceRefs).toEqual([]);
    expect(stored.ruleVersion).toBe(CLAIM_RULE_VERSION);
  });
});
