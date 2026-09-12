import { describe, expect, it } from 'vitest';
import {
  SCHEMA_VERSION,
  parseExportableProfile,
  toExportableProfile,
  type AbilityProfile,
} from './index.js';

/** 构造一份完整画像（含可选字段 displayName/avatarUrl，便于验证透传） */
function fullProfile(): AbilityProfile {
  return {
    profileId: 'prof_01J000000000000000000000',
    analyzerVersion: `schema-${SCHEMA_VERSION}-engine-0.1.0`,
    generatedAt: '2026-09-10T00:00:00.000Z',
    dataWindow: {
      since: '2025-09-10T00:00:00.000Z',
      until: '2026-09-10T00:00:00.000Z',
    },
    analysisLayers: ['L0', 'L1'],
    subject: {
      platform: 'github',
      login: 'linxiaoman',
      displayName: 'Lin Xiao Man',
      avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
      profileUrl: 'https://github.com/linxiaoman',
      claimed: true,
    },
    summary: {
      headline: '全栈工程师，14 个月长线投入',
    },
    skillTags: [
      {
        name: 'TypeScript',
        kind: 'language',
        depth: 'proficient',
        confidence: 0.9,
        evidenceRefs: ['ev_commit_1'],
      },
      {
        name: 'React',
        kind: 'framework',
        depth: 'used',
        confidence: 0.7,
        evidenceRefs: ['ev_commit_2', 'ev_pr_1'],
      },
    ],
    activity: {
      longevityMonths: 14,
      metrics: { publicRepos: 12, followers: 30 },
    },
    collaboration: {
      externalMergedContributions: ['https://github.com/other/repo/pull/42'],
      evidenceRefs: ['ev_pr_1'],
    },
    authenticity: {
      status: 'likely_authentic',
      confidence: 0.82,
      signals: [],
    },
    interviewQuestions: [],
    caveats: [],
  };
}

/** 无可选字段的最小画像（displayName/avatarUrl 缺省） */
function minimalProfile(): AbilityProfile {
  const p = fullProfile();
  delete p.subject.displayName;
  delete p.subject.avatarUrl;
  p.subject.claimed = false;
  p.skillTags = [];
  return p;
}

describe('toExportableProfile', () => {
  it('projects all core fields from a full profile', () => {
    const out = toExportableProfile(fullProfile());
    expect(out.schemaVersion).toBe(SCHEMA_VERSION);
    expect(out.profileId).toBe('prof_01J000000000000000000000');
    expect(out.generatedAt).toBe('2026-09-10T00:00:00.000Z');
    expect(out.analyzerVersion).toBe(`schema-${SCHEMA_VERSION}-engine-0.1.0`);
    expect(out.subject).toEqual({
      platform: 'github',
      login: 'linxiaoman',
      displayName: 'Lin Xiao Man',
      avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
      profileUrl: 'https://github.com/linxiaoman',
      claimed: true,
    });
    expect(out.headline).toBe('全栈工程师，14 个月长线投入');
    expect(out.authenticity).toEqual({ status: 'likely_authentic', confidence: 0.82 });
  });

  it('keeps per-skill evidence refs for traceability', () => {
    const out = toExportableProfile(fullProfile());
    expect(out.skills).toEqual([
      {
        name: 'TypeScript',
        kind: 'language',
        depth: 'proficient',
        confidence: 0.9,
        evidenceRefs: ['ev_commit_1'],
      },
      {
        name: 'React',
        kind: 'framework',
        depth: 'used',
        confidence: 0.7,
        evidenceRefs: ['ev_commit_2', 'ev_pr_1'],
      },
    ]);
  });

  it('omits optional subject fields when absent', () => {
    const out = toExportableProfile(minimalProfile());
    expect('displayName' in out.subject).toBe(false);
    expect('avatarUrl' in out.subject).toBe(false);
    expect(out.subject.claimed).toBe(false);
    expect(out.skills).toEqual([]);
  });

  it('output is always parseable by ExportableProfileSchema', () => {
    expect(parseExportableProfile(toExportableProfile(fullProfile()))).not.toBeNull();
    expect(parseExportableProfile(toExportableProfile(minimalProfile()))).not.toBeNull();
  });
});

describe('ExportableProfileSchema / parseExportableProfile', () => {
  it('accepts a projected profile', () => {
    expect(parseExportableProfile(toExportableProfile(fullProfile()))?.subject.login).toBe('linxiaoman');
  });

  it('rejects input missing a required field', () => {
    const out = toExportableProfile(fullProfile());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (out as any).profileId;
    expect(parseExportableProfile(out)).toBeNull();
  });

  it('rejects an unknown skill kind', () => {
    const out = toExportableProfile(fullProfile());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (out.skills[0] as any).kind = 'hobby';
    expect(parseExportableProfile(out)).toBeNull();
  });

  it('rejects a confidence outside 0-1', () => {
    const out = toExportableProfile(fullProfile());
    out.authenticity.confidence = 1.3;
    expect(parseExportableProfile(out)).toBeNull();
  });

  it('rejects non-object input', () => {
    expect(parseExportableProfile(null)).toBeNull();
    expect(parseExportableProfile('nope')).toBeNull();
    expect(parseExportableProfile({})).toBeNull();
  });
});
