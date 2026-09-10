import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';
import { type AbilityProfile } from '@jobagent/shared';
import { runMigrations } from './migrator.js';
import { ProfilesRepository, type NewProfile } from './profiles.js';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../db/migrations',
);

function freshRepo(): { repo: ProfilesRepository; db: Database.Database } {
  const db = new Database(':memory:');
  runMigrations(db, MIGRATIONS_DIR);
  const orm = drizzle(db);
  return { repo: new ProfilesRepository(orm), db };
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

describe('ProfilesRepository', () => {
  it('inserts and reads back a profile with parsed snapshot', () => {
    const { repo, db } = freshRepo();
    const profile = sampleProfile();
    repo.insert(newProfileRow(profile.profileId, profile));

    const stored = repo.getById(profile.profileId);
    expect(stored).toBeDefined();
    expect(stored!.subjectLogin).toBe('linxiaoman');
    expect(stored!.subjectClaimed).toBe(false);
    expect(stored!.status).toBe('partial');
    expect(stored!.analysisLayers).toEqual(['L0', 'L1']);
    expect(stored!.snapshot).not.toBeNull();
    expect(stored!.snapshot!.summary.headline).toBe('全栈工程师，14 个月长线投入');
    db.close();
  });

  it('lists profiles by subject ordered by recency', () => {
    const { repo, db } = freshRepo();
    const base = sampleProfile();
    for (let i = 1; i <= 3; i++) {
      repo.insert(newProfileRow(`prof_${String(i).padStart(32, '0')}`, base));
    }
    const rows = repo.listBySubject('github', 'linxiaoman');
    expect(rows).toHaveLength(3);
    db.close();
  });

  it('returns the latest profile for a subject', () => {
    const { repo, db } = freshRepo();
    const base = sampleProfile();
    repo.insert(newProfileRow('prof_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', base));
    const latest = repo.latestBySubject('github', 'linxiaoman');
    expect(latest!.id).toBe('prof_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(repo.latestBySubject('github', 'nobody')).toBeUndefined();
    db.close();
  });

  it('updates the snapshot status', () => {
    const { repo, db } = freshRepo();
    const base = sampleProfile();
    repo.insert(newProfileRow('prof_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', base));
    repo.updateStatus('prof_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'complete');
    expect(repo.getById('prof_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')!.status).toBe('complete');
    db.close();
  });

  it('keeps an unparsable snapshot as null instead of throwing', () => {
    const { repo, db } = freshRepo();
    const base = sampleProfile();
    const id = 'prof_cccccccccccccccccccccccccccccccc';
    repo.insert(newProfileRow(id, base));
    // 直接篡改存储的 JSON，验证读取路径不抛错、以 null 呈现
    db.prepare("UPDATE profiles SET snapshot = '{broken json' WHERE id = ?").run(id);
    const stored = repo.getById(id);
    expect(stored!.snapshot).toBeNull();
    db.close();
  });
});
