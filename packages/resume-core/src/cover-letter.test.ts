import { describe, expect, it } from 'vitest';
import {
  COVER_LETTER_RULE_VERSION,
  CoverLetterDraftSchema,
  SCHEMA_VERSION,
  type AbilityProfile,
  type EvidenceItem,
  type JobPosting,
  type SkillTag,
} from '@jobagent/shared';
import { buildCoverLetter, renderCoverLetterMarkdown, type BuildCoverLetterInput } from './index.js';
import type { ResumeMatchInput } from './types.js';

function skill(name: string, overrides: Partial<SkillTag> = {}): SkillTag {
  return { name, kind: 'language', depth: 'used', confidence: 0.8, evidenceRefs: [], ...overrides };
}

function evidence(id: string, sourceType: EvidenceItem['sourceType'], claim: string): EvidenceItem {
  return {
    evidenceId: id,
    sourcePlatform: 'github',
    sourceType,
    url: `https://github.com/acme/repo/${id}`,
    occurredAt: '2026-09-01T00:00:00.000Z',
    layer: 'L1',
    claim,
    rawRef: id,
  };
}

function makeProfile(skills: SkillTag[], overrides: Partial<AbilityProfile> = {}): AbilityProfile {
  return {
    profileId: 'p-1',
    analyzerVersion: '0.1-0.8',
    generatedAt: '2026-10-01T00:00:00.000Z',
    dataWindow: { since: '2024-01-01T00:00:00.000Z', until: '2026-10-01T00:00:00.000Z' },
    analysisLayers: ['L0', 'L1'],
    subject: {
      platform: 'github',
      login: 'alice',
      displayName: 'Alice A',
      profileUrl: 'https://github.com/alice',
      claimed: true,
    },
    summary: { headline: 'TypeScript developer' },
    skillTags: skills,
    activity: {},
    collaboration: { evidenceRefs: [] },
    authenticity: { status: 'likely_authentic', confidence: 0.8, signals: [] },
    interviewQuestions: [],
    caveats: [],
    ...overrides,
  };
}

function makePosting(overrides: Partial<JobPosting> = {}): JobPosting {
  return {
    jobId: 'j-1',
    source: 'greenhouse',
    sourceUrl: 'https://example.com/jobs/j-1',
    title: 'Senior Backend Engineer',
    company: 'Acme',
    location: 'Remote',
    remote: true,
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    tags: ['typescript'],
    description: 'typescript backend role',
    postedAt: '2026-09-01T00:00:00.000Z',
    fetchedAt: '2026-09-02T00:00:00.000Z',
    ...overrides,
  };
}

function makeMatch(overrides: Partial<ResumeMatchInput> = {}): ResumeMatchInput {
  return {
    score: 6,
    matchedSkills: ['TypeScript'],
    fieldScores: { title: 3, tags: 2, description: 1 },
    skillHits: [{ skill: 'TypeScript', score: 6, fields: ['title', 'tags', 'description'] }],
    ...overrides,
  };
}

function makeInput(overrides: Partial<BuildCoverLetterInput> = {}): BuildCoverLetterInput {
  const profile = makeProfile([
    skill('TypeScript', { depth: 'proficient', confidence: 0.95, evidenceRefs: ['ev-1', 'ev-2'] }),
    skill('React', { kind: 'framework', evidenceRefs: ['ev-3'] }),
    skill('NoEvidence', { evidenceRefs: [] }),
  ]);
  return {
    profile,
    evidence: [
      evidence('ev-1', 'pr', 'Merged PR #42 in acme/api'),
      evidence('ev-2', 'commit', 'Committed to acme/api'),
      evidence('ev-3', 'issue', 'Opened issue #7 in acme/web'),
    ],
    posting: makePosting(),
    match: makeMatch({ matchedSkills: ['TypeScript', 'NoEvidence'] }),
    options: { now: '2026-10-03T00:00:00.000Z' },
    ...overrides,
  };
}

describe('buildCoverLetter', () => {
  it('assembles an evidence-backed letter with the rule/provenance versions stamped', () => {
    const draft = buildCoverLetter(makeInput());
    expect(CoverLetterDraftSchema.safeParse(draft).success).toBe(true);
    expect(draft.schemaVersion).toBe(SCHEMA_VERSION);
    expect(draft.ruleVersion).toBe(COVER_LETTER_RULE_VERSION);
    expect(draft.provenance).toEqual({
      profileId: 'p-1',
      analyzerVersion: '0.1-0.8',
      ruleVersion: COVER_LETTER_RULE_VERSION,
    });
    expect(draft.generatedAt).toBe('2026-10-03T00:00:00.000Z');
    expect(draft.targetJob).toEqual({
      jobId: 'j-1',
      title: 'Senior Backend Engineer',
      company: 'Acme',
      sourceUrl: 'https://example.com/jobs/j-1',
    });
    expect(draft.paragraphs.map((p) => p.code)).toEqual(['opening', 'match', 'evidence', 'close']);
  });

  it('never writes a skill that has no evidence into the letter', () => {
    const draft = buildCoverLetter(makeInput());
    const matchParagraph = draft.paragraphs.find((p) => p.code === 'match')!;
    expect(matchParagraph.text).toContain('TypeScript');
    expect(matchParagraph.text).not.toContain('NoEvidence');
    // 深度词按 locale 现拼（中文用中文深度词）
    expect(matchParagraph.text).toContain('有深度');
    expect(matchParagraph.evidenceRefs).toEqual(['ev-1', 'ev-2']);
  });

  it('quotes the strongest evidence claim verbatim and links it', () => {
    const draft = buildCoverLetter(makeInput());
    const evidenceParagraph = draft.paragraphs.find((p) => p.code === 'evidence')!;
    // ev-1 支撑的命中技能最多且类型强度更高（pr > commit）
    expect(evidenceParagraph.text).toContain('Merged PR #42 in acme/api');
    expect(evidenceParagraph.text).toContain('https://github.com/acme/repo/ev-1');
    expect(evidenceParagraph.evidenceRefs).toEqual(['ev-1']);
  });

  it('omits the match/evidence paragraphs when there is nothing to back them (no fabrication)', () => {
    const input = makeInput({
      profile: makeProfile([skill('TypeScript', { evidenceRefs: [] })]),
      evidence: [],
    });
    const draft = buildCoverLetter(input);
    expect(draft.paragraphs.map((p) => p.code)).toEqual(['opening', 'close']);
  });

  it('renders English copy on request and keeps facts untranslated', () => {
    const draft = buildCoverLetter(makeInput({ options: { locale: 'en', now: '2026-10-03T00:00:00.000Z' } }));
    expect(draft.locale).toBe('en');
    expect(draft.greeting).toContain('Dear Acme hiring team');
    const matchParagraph = draft.paragraphs.find((p) => p.code === 'match')!;
    expect(matchParagraph.text).toContain('proficient');
    expect(matchParagraph.text).toContain('TypeScript');
  });

  it('adds the honest data notice only for thin/suspicious profiles', () => {
    expect(buildCoverLetter(makeInput()).dataQualityNote).toBeUndefined();
    const thin = buildCoverLetter(
      makeInput({
        profile: makeProfile([skill('TypeScript', { evidenceRefs: ['ev-1'] })], {
          authenticity: { status: 'insufficient_data', confidence: 0.2, signals: [] },
        }),
      }),
    );
    expect(thin.dataQualityNote).toBeTruthy();
  });

  it('renders markdown with greeting, paragraphs and signature only', () => {
    const md = renderCoverLetterMarkdown(buildCoverLetter(makeInput()));
    expect(md.startsWith('尊敬的「Acme」招聘团队：')).toBe(true);
    expect(md).toContain('Senior Backend Engineer');
    expect(md).toContain('Alice A');
    // 交付物卫生：不把匹配分/内部批注印进交付物
    expect(md).not.toContain('matchScore');
    expect(md).not.toContain('provenance');
    expect(md.endsWith('\n')).toBe(true);
  });
});
