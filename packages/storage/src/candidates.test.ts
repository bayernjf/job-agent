import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AbilityProfile, AuthenticityStatus, SkillTag } from '@jobagent/shared';
import { searchCandidates } from './entities/candidate.js';
import type { StoredProfile } from './entities/index.js';
import { runMigrations } from './sqlite/migrator.js';
import { openSqlite } from './sqlite/connection.js';
import { SqliteProfilesRepository } from './sqlite/profiles-repo.js';
import type { NewProfile } from './entities/index.js';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../db/migrations/sqlite',
);

function skill(name: string, overrides: Partial<SkillTag> = {}): SkillTag {
  return {
    name,
    kind: 'language',
    depth: 'proficient',
    confidence: 0.8,
    evidenceRefs: [],
    ...overrides,
  };
}

function profile(
  id: string,
  login: string,
  opts: {
    status?: AuthenticityStatus;
    confidence?: number;
    skills?: SkillTag[];
    headline?: string;
    platform?: string;
    displayName?: string;
  } = {},
): AbilityProfile {
  return {
    profileId: id,
    analyzerVersion: 'schema-0.1-engine-0.2.0',
    generatedAt: '2026-09-16T00:00:00.000Z',
    dataWindow: { since: '2025-09-16T00:00:00.000Z', until: '2026-09-16T00:00:00.000Z' },
    analysisLayers: ['L0', 'L1'],
    subject: {
      platform: (opts.platform as 'github' | 'gitee') ?? 'github',
      login,
      ...(opts.displayName ? { displayName: opts.displayName } : {}),
      profileUrl: `https://github.com/${login}`,
      claimed: false,
    },
    summary: { headline: opts.headline ?? `${login} developer` },
    skillTags: opts.skills ?? [],
    activity: { longevityMonths: 12 },
    collaboration: { evidenceRefs: [] },
    authenticity: {
      status: opts.status ?? 'likely_authentic',
      confidence: opts.confidence ?? 0.8,
      signals: [],
    },
    interviewQuestions: [],
    caveats: [],
  };
}

interface StoredOpts extends NonNullable<Parameters<typeof profile>[2]> {
  /** DB 行状态（complete 才进候选人库），与画像真实性 status 区分 */
  dbStatus?: 'complete' | 'partial';
  updatedAt?: string;
}

function stored(id: string, login: string, opts: StoredOpts = {}): StoredProfile {
  const { dbStatus = 'complete', updatedAt = '2026-09-16T00:00:00.000Z', ...profileOpts } = opts;
  const snap = profile(id, login, profileOpts);
  return {
    id,
    analyzerVersion: snap.analyzerVersion,
    subjectPlatform: snap.subject.platform,
    subjectLogin: login,
    subjectClaimed: false,
    dataWindowSince: snap.dataWindow.since,
    dataWindowUntil: snap.dataWindow.until,
    analysisLayers: ['L0', 'L1'],
    status: dbStatus,
    snapshot: snap,
    createdAt: updatedAt,
    updatedAt,
  };
}

describe('searchCandidates (pure ranking/filtering)', () => {
  const rows: StoredProfile[] = [
    stored('p1', 'alice', {
      confidence: 0.9,
      skills: [skill('TypeScript'), skill('React', { kind: 'framework' })],
      headline: 'frontend developer',
    }),
    stored('p2', 'bob', {
      confidence: 0.6,
      status: 'mixed_signals',
      skills: [skill('Python'), skill('TypeScript')],
      headline: 'backend developer',
      updatedAt: '2026-09-15T00:00:00.000Z',
    }),
    stored('p3', 'carol', {
      confidence: 0.95,
      skills: [skill('Rust'), skill('Go'), skill('Python')],
      headline: 'systems engineer',
      updatedAt: '2026-09-14T00:00:00.000Z',
    }),
  ];

  it('returns all complete profiles ranked by confidence desc by default', () => {
    const { items, total } = searchCandidates(rows, {});
    expect(total).toBe(3);
    expect(items.map((c) => c.login)).toEqual(['carol', 'alice', 'bob']);
  });

  it('filters by any skill match (default) and reports matched skills', () => {
    const { items, total } = searchCandidates(rows, { skills: ['typescript'] });
    expect(total).toBe(2);
    expect(items.map((c) => c.login).sort()).toEqual(['alice', 'bob']);
    const alice = items.find((c) => c.login === 'alice')!;
    expect(alice.matchedSkills).toEqual(['TypeScript']);
  });

  it('requires every skill when skillMatch=all', () => {
    const anyMatch = searchCandidates(rows, { skills: ['Python', 'Rust'] });
    expect(anyMatch.total).toBe(2); // bob(Python) + carol(Python,Rust)
    const allMatch = searchCandidates(rows, { skills: ['Python', 'Rust'], skillMatch: 'all' });
    expect(allMatch.total).toBe(1);
    expect(allMatch.items[0]!.login).toBe('carol');
  });

  it('filters by authenticity status allow-list', () => {
    const { items } = searchCandidates(rows, { authenticity: ['likely_authentic'] });
    expect(items.map((c) => c.login).sort()).toEqual(['alice', 'carol']);
  });

  it('filters by minimum confidence', () => {
    const { items } = searchCandidates(rows, { minConfidence: 0.9 });
    expect(items.map((c) => c.login).sort()).toEqual(['alice', 'carol']);
  });

  it('matches keyword against login, headline and skill names (AND across words)', () => {
    const bySkill = searchCandidates(rows, { keyword: 'rust' });
    expect(bySkill.items.map((c) => c.login)).toEqual(['carol']);
    const byHeadline = searchCandidates(rows, { keyword: 'frontend' });
    expect(byHeadline.items.map((c) => c.login)).toEqual(['alice']);
    const twoWords = searchCandidates(rows, { keyword: 'systems carol' });
    expect(twoWords.items.map((c) => c.login)).toEqual(['carol']);
    expect(searchCandidates(rows, { keyword: 'frontend rust' }).total).toBe(0);
  });

  it('sorts by skill count and recency, and paginates', () => {
    const byCount = searchCandidates(rows, { sortBy: 'skill_count_desc' });
    expect(byCount.items[0]!.login).toBe('carol'); // 3 skills
    const byRecent = searchCandidates(rows, { sortBy: 'recent' });
    expect(byRecent.items[0]!.login).toBe('alice');
    const page = searchCandidates(rows, { limit: 2, offset: 1 });
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(3);
  });

  it('filters by platform and skips null snapshots', () => {
    const withGitee = [
      ...rows,
      stored('p4', 'dan', { platform: 'gitee', skills: [skill('TypeScript')] }),
      { ...stored('p5', 'eve'), snapshot: null },
    ];
    const gitee = searchCandidates(withGitee, { platform: 'gitee' });
    expect(gitee.items.map((c) => c.login)).toEqual(['dan']);
    const all = searchCandidates(withGitee, {});
    expect(all.total).toBe(4); // eve (null snapshot) excluded
  });
});

describe('SqliteProfilesRepository.searchCandidates', () => {
  it('only scans complete profiles and applies the pure filter', async () => {
    const { client, db } = openSqlite(':memory:');
    runMigrations(client, MIGRATIONS_DIR);
    const repo = new SqliteProfilesRepository(db);

    const complete = profile('pc', 'charlie', { skills: [skill('Rust')], confidence: 0.9 });
    const partial = profile('pp', 'paul', { skills: [skill('Rust')], confidence: 0.99 });
    const row = (p: AbilityProfile, status: 'complete' | 'partial'): NewProfile => ({
      id: p.profileId,
      analyzerVersion: p.analyzerVersion,
      subjectLogin: p.subject.login,
      dataWindowSince: p.dataWindow.since,
      dataWindowUntil: p.dataWindow.until,
      status,
      snapshot: p,
    });
    await repo.insert(row(complete, 'complete'));
    await repo.insert(row(partial, 'partial'));

    const result = await repo.searchCandidates({ skills: ['rust'] });
    expect(result.total).toBe(1);
    expect(result.items[0]!.login).toBe('charlie');
    client.close();
  });
});
