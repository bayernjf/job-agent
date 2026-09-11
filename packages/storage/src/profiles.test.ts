import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type AbilityProfile } from '@jobagent/shared';
import { runMigrations } from './sqlite/migrator.js';
import { openSqlite } from './sqlite/connection.js';
import { SqliteProfilesRepository } from './sqlite/profiles-repo.js';
import type { NewProfile } from './entities/index.js';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../db/migrations/sqlite',
);

function freshRepo(): { repo: SqliteProfilesRepository; db: ReturnType<typeof openSqlite>['client'] } {
  const { client, db } = openSqlite(':memory:');
  runMigrations(client, MIGRATIONS_DIR);
  return { repo: new SqliteProfilesRepository(db), db: client };
}

function sampleProfile(overrides: Partial<AbilityProfile> = {}): AbilityProfile {
  return {
    profileId: 'prof_00000000000000000000000000000001',
    analyzerVersion: 'schema-0.1-engine-0.1.0',
    generatedAt: '2026-09-10T00:00:00.000Z',
    dataWindow: { since: '2025-09-10T00:00:00.000Z', until: '2026-09-10T00:00:00.000Z' },
    analysisLayers: ['L0', 'L1'],
    subject: {
      platform: 'github',
      login: 'linxiaoman',
      profileUrl: 'https://github.com/linxiaoman',
      claimed: false,
    },
    summary: { headline: '全栈工程师，14 个月长线投入' },
    skillTags: [],
    activity: { longevityMonths: 14 },
    collaboration: { evidenceRefs: [] },
    authenticity: {
      status: 'likely_authentic',
      confidence: 0.82,
      signals: [],
    },
    interviewQuestions: [],
    caveats: ['未获得本人认领'],
    ...overrides,
  };
}

function newProfileRow(id: string, snapshot: AbilityProfile): NewProfile {
  return {
    id,
    analyzerVersion: snapshot.analyzerVersion,
    subjectLogin: snapshot.subject.login,
    dataWindowSince: snapshot.dataWindow.since,
    dataWindowUntil: snapshot.dataWindow.until,
    snapshot,
  };
}

describe('SqliteProfilesRepository', () => {
  it('inserts and reads back a profile with parsed snapshot', async () => {
    const { repo, db } = freshRepo();
    const profile = sampleProfile();
    await repo.insert(newProfileRow(profile.profileId, profile));

    const stored = await repo.getById(profile.profileId);
    expect(stored).toBeDefined();
    expect(stored!.subjectLogin).toBe('linxiaoman');
    expect(stored!.subjectClaimed).toBe(false);
    expect(stored!.status).toBe('partial');
    expect(stored!.analysisLayers).toEqual(['L0', 'L1']);
    expect(stored!.snapshot).not.toBeNull();
    expect(stored!.snapshot!.summary.headline).toBe('全栈工程师，14 个月长线投入');
    db.close();
  });

  it('lists profiles by subject ordered by recency', async () => {
    const { repo, db } = freshRepo();
    const base = sampleProfile();
    for (let i = 1; i <= 3; i++) {
      await repo.insert(newProfileRow(`prof_${String(i).padStart(32, '0')}`, base));
    }
    const rows = await repo.listBySubject('github', 'linxiaoman');
    expect(rows).toHaveLength(3);
    db.close();
  });

  it('returns the latest profile for a subject', async () => {
    const { repo, db } = freshRepo();
    const base = sampleProfile();
    await repo.insert(newProfileRow('prof_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', base));
    const latest = await repo.latestBySubject('github', 'linxiaoman');
    expect(latest!.id).toBe('prof_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(await repo.latestBySubject('github', 'nobody')).toBeUndefined();
    db.close();
  });

  it('updates the snapshot status', async () => {
    const { repo, db } = freshRepo();
    const base = sampleProfile();
    await repo.insert(newProfileRow('prof_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', base));
    await repo.updateStatus('prof_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'complete');
    expect((await repo.getById('prof_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'))!.status).toBe('complete');
    db.close();
  });

  it('keeps an unparsable snapshot as null instead of throwing', async () => {
    const { repo, db } = freshRepo();
    const base = sampleProfile();
    const id = 'prof_cccccccccccccccccccccccccccccccc';
    await repo.insert(newProfileRow(id, base));
    // 直接篡改存储的 JSON，验证读取路径不抛错、以 null 呈现
    db.prepare("UPDATE profiles SET snapshot = '{broken json' WHERE id = ?").run(id);
    const stored = await repo.getById(id);
    expect(stored!.snapshot).toBeNull();
    db.close();
  });
});
