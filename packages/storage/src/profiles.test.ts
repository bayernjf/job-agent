import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type AbilityProfile, type EvidenceItem } from '@jobagent/shared';
import { runMigrations } from './sqlite/migrator.js';
import { openSqlite } from './sqlite/connection.js';
import { SqliteProfilesRepository } from './sqlite/profiles-repo.js';
import { SqliteEvidenceRepository } from './sqlite/evidence-repo.js';
import { SqliteAnalysisJobsRepository } from './sqlite/analysis-jobs-repo.js';
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

describe('SqliteProfilesRepository.publishWithEvidenceAndJob', () => {
  const EVIDENCE: EvidenceItem = {
    evidenceId: 'ev-1',
    sourcePlatform: 'github',
    sourceType: 'commit',
    url: 'https://github.com/a/b/commit/abc',
    layer: 'L0',
    claim: 'committed to a/b',
    rawRef: 'repo:a/b#abc',
  };

  /** 三张表共用同一个连接，才能验证它们真的落在同一个事务里。 */
  function freshPublication() {
    const { client, db } = openSqlite(':memory:');
    runMigrations(client, MIGRATIONS_DIR);
    return {
      client,
      profiles: new SqliteProfilesRepository(db),
      evidence: new SqliteEvidenceRepository(db),
      jobs: new SqliteAnalysisJobsRepository(db),
    };
  }

  it('writes the profile, its evidence rows and the job success together', async () => {
    const s = freshPublication();
    await s.jobs.create({ id: 'job-1', subjectLogin: 'linxiaoman' });
    await s.jobs.claimNext('w1'); // -> running
    const snap = sampleProfile();

    await s.profiles.publishWithEvidenceAndJob({
      profile: { ...newProfileRow(snap.profileId, snap), status: 'complete' },
      evidence: [EVIDENCE],
      jobId: 'job-1',
      budgetUsed: { graphqlPoints: 10 },
      missing: [],
    });

    expect((await s.profiles.getById(snap.profileId))!.status).toBe('complete');
    const rows = await s.evidence.listByProfile(snap.profileId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('ev-1');
    const job = (await s.jobs.getById('job-1'))!;
    expect(job.status).toBe('succeeded');
    expect(job.stage).toBe('complete');
    expect(job.profileId).toBe(snap.profileId);
    s.client.close();
  });

  it('rolls the whole publication back when the evidence write fails, leaving no orphan profile', async () => {
    const s = freshPublication();
    await s.jobs.create({ id: 'job-2', subjectLogin: 'linxiaoman' });
    await s.jobs.claimNext('w1');
    const snap = sampleProfile();
    // Pre-occupy the (profile_id, id) primary key so the evidence insert *inside* the
    // transaction is guaranteed to violate it — i.e. the second of the three writes fails
    // after the first has already run.
    await s.evidence.insert({
      id: EVIDENCE.evidenceId,
      profileId: snap.profileId,
      sourceType: EVIDENCE.sourceType,
      url: EVIDENCE.url,
      layer: EVIDENCE.layer,
      claim: EVIDENCE.claim,
      rawRef: EVIDENCE.rawRef,
    });

    await expect(
      s.profiles.publishWithEvidenceAndJob({
        profile: newProfileRow(snap.profileId, snap),
        evidence: [EVIDENCE],
        jobId: 'job-2',
      }),
    ).rejects.toThrow();

    // The profile insert ran first inside the transaction and must have been rolled back:
    // an orphan profile is visible to /candidates, and a still-`running` job would be
    // reclaimed and republished as a second profile row for the same login.
    expect(await s.profiles.getById(snap.profileId)).toBeUndefined();
    const job = (await s.jobs.getById('job-2'))!;
    expect(job.status).toBe('running');
    expect(job.profileId).toBeNull();
    // the pre-existing evidence row is untouched (exactly one, not two)
    expect(await s.evidence.listByProfile(snap.profileId)).toHaveLength(1);
    s.client.close();
  });
});
