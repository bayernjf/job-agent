import { describe, expect, it } from 'vitest';
import type { AbilityProfile, EvidenceItem, JobPosting, SkillTag } from '@jobagent/shared';
import { buildResume, type BuildResumeInput, type ResumeMatchInput } from './index.js';

function skill(name: string, overrides: Partial<SkillTag> = {}): SkillTag {
  return {
    name,
    kind: 'language',
    depth: 'used',
    confidence: 0.8,
    evidenceRefs: [],
    ...overrides,
  };
}

function evidence(
  evidenceId: string,
  sourceType: EvidenceItem['sourceType'],
  claim: string,
  occurredAt: string,
): EvidenceItem {
  return {
    evidenceId,
    sourcePlatform: 'github',
    sourceType,
    url: `https://github.com/acme/repo/${evidenceId}`,
    occurredAt,
    layer: 'L1',
    claim,
    rawRef: evidenceId,
  };
}

function makeProfile(skills: SkillTag[]): AbilityProfile {
  return {
    profileId: 'p-1',
    analyzerVersion: '0.1-0.2',
    generatedAt: '2026-09-15T00:00:00.000Z',
    dataWindow: { since: '2024-01-01T00:00:00.000Z', until: '2026-09-01T00:00:00.000Z' },
    analysisLayers: ['L0', 'L1'],
    subject: { platform: 'github', login: 'alice', displayName: 'Alice A', profileUrl: 'https://github.com/alice', claimed: false },
    summary: {
      headline: 'Backend developer focused on reliable systems',
      seniorityHint: { band: 'Mid-level', confidence: 0.7, evidenceRefs: ['ev-ts1'] },
    },
    skillTags: skills,
    activity: { metrics: { commitCount: 120 } },
    collaboration: { prSummary: 'Merged PRs across teams', evidenceRefs: ['ev-ts1'] },
    authenticity: { status: 'likely_authentic', confidence: 0.82, signals: [] },
    interviewQuestions: [],
    caveats: [],
  };
}

function makePosting(tags: string[]): JobPosting {
  return {
    jobId: 'j-1',
    source: 'greenhouse',
    sourceUrl: 'https://example.com/jobs/j-1',
    title: 'Backend Engineer',
    company: 'Acme',
    location: 'Remote',
    remote: true,
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    tags,
    description: 'typescript backend role',
    postedAt: '2026-09-01T00:00:00.000Z',
    fetchedAt: '2026-09-02T00:00:00.000Z',
  };
}

function makeInput(overrides: Partial<BuildResumeInput> = {}): BuildResumeInput {
  const skills = [
    skill('typescript', { depth: 'proficient', confidence: 0.95, evidenceRefs: ['ev-ts1', 'ev-ts2'], kind: 'language' }),
    skill('react', { kind: 'framework', evidenceRefs: ['ev-rc'] }),
    skill('rust', { evidenceRefs: ['ev-rs'] }),
  ];
  const evidences = [
    evidence('ev-ts1', 'pr', 'Refactored service to strict TypeScript', '2026-05-01T00:00:00.000Z'),
    evidence('ev-ts2', 'commit', 'TypeScript commit', '2026-03-01T00:00:00.000Z'),
    evidence('ev-rc', 'pr', 'React UI work', '2026-06-01T00:00:00.000Z'),
    evidence('ev-rs', 'commit', 'Rust experiment', '2026-02-01T00:00:00.000Z'),
  ];
  const match: ResumeMatchInput = {
    score: 5,
    matchedSkills: ['typescript'],
    fieldScores: { title: 3, tags: 2, description: 0 },
    skillHits: [{ skill: 'typescript', score: 5, fields: ['title', 'tags'] }],
  };
  return {
    profile: makeProfile(skills),
    evidence: evidences,
    posting: makePosting(['typescript', 'node.js', 'remote']),
    match,
    options: { now: '2026-09-15T08:00:00.000Z', locale: 'zh-CN' },
    ...overrides,
  };
}

describe('buildResume', () => {
  it('puts matched skills first and keeps the rest as other skills (no fact dropped)', () => {
    const draft = buildResume(makeInput());
    expect(draft.matchedSkills.map((e) => e.text)).toEqual(['typescript']);
    expect(draft.otherSkills.map((e) => e.text).sort()).toEqual(['react', 'rust']);
    // 画像技能全集不丢
    const all = [...draft.matchedSkills, ...draft.otherSkills].map((e) => e.text).sort();
    expect(all).toEqual(['react', 'rust', 'typescript']);
  });

  it('selects only evidence supporting matched skills and ranks PR before commit', () => {
    const draft = buildResume(makeInput());
    const ids = draft.evidenceHighlights.flatMap((e) => e.evidenceRefs);
    expect(ids.sort()).toEqual(['ev-ts1', 'ev-ts2']);
    expect(ids[0]).toBe('ev-ts1'); // pr 强度高于 commit
    expect(draft.evidenceHighlights[0]?.supportsSkills).toEqual(['typescript']);
  });

  it('NO-FABRICATION: every profile entry refs an input evidence id and names an input skill', () => {
    const input = makeInput();
    const draft = buildResume(input);
    const evidenceIds = new Set(input.evidence.map((e) => e.evidenceId));
    const skillNames = new Set(input.profile.skillTags.map((s) => s.name));
    const allEntries = [
      ...draft.matchedSkills,
      ...draft.otherSkills,
      ...draft.evidenceHighlights,
      ...draft.collaboration,
    ];
    for (const entry of allEntries) {
      if (entry.source === 'profile') {
        expect(entry.evidenceRefs.length).toBeGreaterThan(0);
        for (const ref of entry.evidenceRefs) expect(evidenceIds.has(ref)).toBe(true);
      }
    }
    for (const s of [...draft.matchedSkills, ...draft.otherSkills]) {
      expect(skillNames.has(s.text)).toBe(true);
    }
  });

  it('assembles summary only from profile/job slots', () => {
    const draft = buildResume(makeInput());
    expect(draft.summary).toContain('Backend developer focused on reliable systems');
    expect(draft.summary).toContain('Backend Engineer');
    expect(draft.summary).toContain('Acme');
    expect(draft.summary).toContain('typescript');
    expect(draft.summary).toContain('Mid-level');
  });

  it('flags genuinely missing skill tags but filters generic words like remote', () => {
    const draft = buildResume(makeInput());
    const missing = draft.suggestions.filter((s) => s.kind === 'missing_skill').map((s) => s.text);
    expect(missing.join(' ')).toContain('node.js');
    expect(missing.join(' ')).not.toContain('remote');
  });

  it('uses local fields as source:local with empty refs and fills contact', () => {
    const input = makeInput({
      local: {
        fullName: 'Zhang San',
        email: 'zs@example.com',
        education: [{ school: 'X University', degree: 'BSc CS', period: '2018–2022' }],
        workHistory: [{ company: 'Old Co', role: 'Engineer', period: '2022–2024' }],
      },
    });
    const draft = buildResume(input);
    expect(draft.header.name).toBe('Zhang San');
    expect(draft.header.contact?.email).toBe('zs@example.com');
    expect(draft.localSections.education[0]?.source).toBe('local');
    expect(draft.localSections.education[0]?.evidenceRefs).toEqual([]);
    expect(draft.localSections.workHistory[0]?.text).toContain('Old Co');
    expect(draft.gaps).toEqual([]);
  });

  it('degrades gracefully with empty evidence and no local fields', () => {
    const input = makeInput({ evidence: [], local: undefined });
    const draft = buildResume(input);
    expect(draft.evidenceHighlights).toEqual([]);
    expect(draft.gaps.length).toBeGreaterThan(0);
    // 结构仍完整
    expect(draft.matchedSkills.length).toBe(1);
  });

  it('returns low tier and a low_match suggestion when no skill matched', () => {
    const input = makeInput({
      match: { score: 0, matchedSkills: [], fieldScores: { title: 0, tags: 0, description: 0 }, skillHits: [] },
    });
    const draft = buildResume(input);
    expect(draft.targetJob.tier).toBe('low');
    expect(draft.suggestions.some((s) => s.kind === 'low_match')).toBe(true);
    expect(draft.matchedSkills).toEqual([]);
  });

  it('respects highlightLimit', () => {
    const many: EvidenceItem[] = Array.from({ length: 12 }, (_, i) =>
      evidence(`ev-ts${i}`, i % 2 ? 'commit' : 'pr', `claim ${i}`, `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`),
    );
    const profile = makeProfile([
      skill('typescript', { depth: 'proficient', evidenceRefs: many.map((e) => e.evidenceId) }),
    ]);
    const input = makeInput({
      profile,
      evidence: many,
      match: { score: 6, matchedSkills: ['typescript'], fieldScores: { title: 3, tags: 2, description: 1 }, skillHits: [{ skill: 'typescript', score: 6, fields: ['title', 'tags', 'description'] }] },
      options: { now: '2026-09-15T08:00:00.000Z', highlightLimit: 5 },
    });
    expect(buildResume(input).evidenceHighlights).toHaveLength(5);
  });

  it('produces English template copy under locale en while keeping skill facts', () => {
    const input = makeInput({ options: { now: '2026-09-15T08:00:00.000Z', locale: 'en' } });
    const draft = buildResume(input);
    expect(draft.summary).toContain('Targeting');
    expect(draft.summary).toContain('typescript'); // 事实不翻译
  });
});
