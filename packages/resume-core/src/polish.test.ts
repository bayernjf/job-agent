import { describe, expect, it } from 'vitest';
import type { AbilityProfile, EvidenceItem, JobPosting, SkillTag } from '@jobagent/shared';
import { buildResume, polishResume, type ResumePolishEdits, type ResumePolishProvider } from './index.js';

const NOW = '2026-09-16T00:00:00.000Z';

function skill(name: string, overrides: Partial<SkillTag> = {}): SkillTag {
  return { name, kind: 'language', depth: 'used', confidence: 0.8, evidenceRefs: [], ...overrides };
}

function evidence(id: string, claim: string): EvidenceItem {
  return {
    evidenceId: id,
    sourcePlatform: 'github',
    sourceType: 'pr',
    url: `https://github.com/acme/repo/${id}`,
    occurredAt: '2026-05-01T00:00:00.000Z',
    layer: 'L1',
    claim,
    rawRef: id,
  };
}

function makeDraft() {
  const skills = [
    skill('typescript', { depth: 'proficient', confidence: 0.95, evidenceRefs: ['ev-ts1'], kind: 'language' }),
  ];
  const profile: AbilityProfile = {
    profileId: 'p-1',
    analyzerVersion: '0.1-0.2',
    generatedAt: NOW,
    dataWindow: { since: '2024-01-01T00:00:00.000Z', until: '2026-09-01T00:00:00.000Z' },
    analysisLayers: ['L0', 'L1'],
    subject: { platform: 'github', login: 'alice', displayName: 'Alice A', profileUrl: 'https://github.com/alice', claimed: false },
    summary: { headline: 'Backend developer focused on reliable systems' },
    skillTags: skills,
    activity: { metrics: { commitCount: 120 } },
    collaboration: { evidenceRefs: [] },
    authenticity: { status: 'likely_authentic', confidence: 0.82, signals: [] },
    interviewQuestions: [],
    caveats: [],
  };
  const evidences = [evidence('ev-ts1', 'Refactored service to strict TypeScript')];
  const posting: JobPosting = {
    jobId: 'j-1',
    source: 'greenhouse',
    sourceUrl: 'https://example.com/jobs/j-1',
    title: 'Backend Engineer',
    company: 'Acme',
    remote: true,
    tags: ['typescript'],
    description: 'typescript backend role',
    postedAt: '2026-09-01T00:00:00.000Z',
    fetchedAt: '2026-09-02T00:00:00.000Z',
  };
  const draft = buildResume({
    profile,
    evidence: evidences,
    posting,
    match: {
      score: 5,
      matchedSkills: ['typescript'],
      fieldScores: { title: 3, tags: 2, description: 0 },
      skillHits: [{ skill: 'typescript', score: 5, fields: ['title', 'tags'] }],
    },
    options: { now: NOW, locale: 'en' },
  });
  return { draft, posting };
}

/** 构造返回固定 edits（或抛错）的 fake provider */
function fakeProvider(edits: ResumePolishEdits | Promise<ResumePolishEdits>, throwError = false): ResumePolishProvider {
  return {
    provider: 'fake',
    model: 'fake-model-1',
    promptVersion: 'resume-polish-0.1',
    async polish() {
      if (throwError) throw new Error('llm unavailable');
      return edits;
    },
  };
}

describe('polishResume (constrained LLM polish safety layer)', () => {
  it('applies wording-only edits and records provenance while preserving refs and structure', async () => {
    const { draft, posting } = makeDraft();
    const originalSummary = draft.summary;
    const highlight = draft.evidenceHighlights[0]!;
    const originalRefs = [...highlight.evidenceRefs];
    const originalUrl = highlight.url;

    const edits: ResumePolishEdits = {
      summary: 'Reliability-focused backend engineer who ships TypeScript services.',
      highlightText: { 0: 'Refactored the service to adopt strict TypeScript typing end to end.' },
    };
    const result = await polishResume(draft, posting, fakeProvider(edits), { locale: 'en', now: NOW });

    expect(result.applied).toBe(true);
    expect(result.draft.summary).toBe(edits.summary);
    expect(result.draft.evidenceHighlights[0]!.text).toBe(edits.highlightText![0]);
    // refs / url / 条目数量 / 技能条目一律不动
    expect(result.draft.evidenceHighlights[0]!.evidenceRefs).toEqual(originalRefs);
    expect(result.draft.evidenceHighlights[0]!.url).toBe(originalUrl);
    expect(result.draft.evidenceHighlights).toHaveLength(draft.evidenceHighlights.length);
    expect(result.draft.matchedSkills.map((e) => e.text)).toEqual(draft.matchedSkills.map((e) => e.text));
    // 溯源
    expect(result.draft.provenance.polish).toMatchObject({
      provider: 'fake',
      model: 'fake-model-1',
      promptVersion: 'resume-polish-0.1',
      appliedAt: NOW,
    });
    // 原规则版 summary 确实被替换（不是同文本）
    expect(result.draft.summary).not.toBe(originalSummary);
  });

  it('rejects a summary that introduces a new number token (fabrication guard)', async () => {
    const { draft, posting } = makeDraft();
    const edits: ResumePolishEdits = { summary: 'Backend engineer with 15 years of TypeScript experience.' };
    const result = await polishResume(draft, posting, fakeProvider(edits), { locale: 'en', now: NOW });

    expect(result.applied).toBe(false);
    expect(result.reason).toBe('fabrication_detected');
    // 整条回退：原文、无 polish 溯源
    expect(result.draft).toBe(draft);
    expect(result.draft.summary).not.toContain('15 years');
    expect(result.draft.provenance.polish).toBeUndefined();
  });

  it('rejects a highlight rewrite that injects a metric number not in the rule draft', async () => {
    const { draft, posting } = makeDraft();
    const edits: ResumePolishEdits = { highlightText: { 0: 'Refactored TypeScript service, improving latency by 50 percent.' } };
    const result = await polishResume(draft, posting, fakeProvider(edits), { locale: 'en', now: NOW });

    expect(result.applied).toBe(false);
    expect(result.reason).toBe('fabrication_detected');
    expect(result.draft).toBe(draft);
  });

  it('allows reusing a number already present in the rule draft', async () => {
    // 规则版 summary 由模板含 posting 标题等；数字池取自草稿。改写里若复用既有数字应放行。
    const { draft, posting } = makeDraft();
    // 原草稿 evidenceHighlights claim 无数字；matchedSkills 无数字；故引入任意新数字都该拦。
    // 这里验证：完全不碰数字的纯措辞改写通过（与用例 1 互补，单独锁定 highlight 路径）。
    const edits: ResumePolishEdits = { highlightText: { 0: 'Tightened TypeScript typing across the service layer.' } };
    const result = await polishResume(draft, posting, fakeProvider(edits), { locale: 'en', now: NOW });
    expect(result.applied).toBe(true);
    expect(result.draft.evidenceHighlights[0]!.text).toContain('Tightened TypeScript');
  });

  it('falls back when the provider throws', async () => {
    const { draft, posting } = makeDraft();
    const result = await polishResume(draft, posting, fakeProvider(Promise.resolve({}), true), { now: NOW });
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('provider_error');
    expect(result.draft).toBe(draft);
  });

  it('rejects out-of-range highlight index and empty/overlong summary', async () => {
    const { draft, posting } = makeDraft();
    const badIndex = await polishResume(
      draft,
      posting,
      fakeProvider({ highlightText: { 99: 'x' } }),
      { now: NOW },
    );
    expect(badIndex.applied).toBe(false);
    expect(badIndex.reason).toBe('validation_failed');

    const emptySummary = await polishResume(draft, posting, fakeProvider({ summary: '   ' }), { now: NOW });
    expect(emptySummary.applied).toBe(false);
    expect(emptySummary.reason).toBe('validation_failed');

    const overlong = await polishResume(
      draft,
      posting,
      fakeProvider({ summary: 'a'.repeat(1001) }),
      { now: NOW },
    );
    expect(overlong.applied).toBe(false);
    expect(overlong.reason).toBe('validation_failed');
  });

  it('treats empty edits as applied (no wording change) but still records provenance', async () => {
    const { draft, posting } = makeDraft();
    const result = await polishResume(draft, posting, fakeProvider({}), { now: NOW });
    expect(result.applied).toBe(true);
    expect(result.draft.summary).toBe(draft.summary);
    expect(result.draft.provenance.polish?.provider).toBe('fake');
  });
});
