import { describe, expect, it } from 'vitest';
import type { AbilityProfile, EvidenceItem, JobPosting, SkillTag } from '@jobagent/shared';
import { buildResume } from '@jobagent/resume-core';
import {
  COVER_LETTER_PROMPT_VERSION,
  FakeLlmClient,
  LlmCoverLetterProvider,
  LlmResponseError,
} from './index.js';

const NOW = '2026-09-16T00:00:00.000Z';

function makeDraft() {
  const skills: SkillTag[] = [
    { name: 'typescript', kind: 'language', depth: 'proficient', confidence: 0.95, evidenceRefs: ['ev-ts1'] },
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
  const evidence: EvidenceItem[] = [
    {
      evidenceId: 'ev-ts1',
      sourcePlatform: 'github',
      sourceType: 'pr',
      url: 'https://github.com/acme/repo/pull/1',
      occurredAt: '2026-05-01T00:00:00.000Z',
      layer: 'L1',
      claim: 'Refactored service to strict TypeScript',
      rawRef: 'acme/repo#1',
    },
  ];
  const posting: JobPosting = {
    jobId: 'j-1',
    source: 'greenhouse',
    sourceUrl: 'https://example.com/jobs/j-1',
    title: 'Backend Engineer',
    company: 'Acme',
    remote: true,
    tags: ['typescript'],
    description: 'typescript backend role at Acme',
    postedAt: '2026-09-01T00:00:00.000Z',
    fetchedAt: '2026-09-02T00:00:00.000Z',
  };
  const draft = buildResume({
    profile,
    evidence,
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

describe('LlmCoverLetterProvider', () => {
  it('builds a constrained prompt and returns schema-valid letter', async () => {
    const { draft, posting } = makeDraft();
    const client = new FakeLlmClient(() => ({
      subject: 'Application for Backend Engineer',
      body: 'Dear hiring team, I am a TypeScript backend developer who ships reliable services, as shown by my public contribution record.',
    }));
    const provider = new LlmCoverLetterProvider(client);
    expect(provider.promptVersion).toBe(COVER_LETTER_PROMPT_VERSION);
    expect(provider.provider).toBe('fake');
    expect(provider.model).toBe('fake-model-1');

    const out = await provider.generate({ draft, posting, locale: 'en' });
    expect(out.subject).toContain('Backend Engineer');
    expect(out.body).toContain('TypeScript');

    // prompt 注入硬约束（防臆造）与岗位/候选人上下文，用略高温度（生成性文本）
    const req = client.calls[0]!;
    expect(req.temperature).toBe(0.4);
    const system = req.messages.find((m) => m.role === 'system')!.content;
    expect(system).toContain('Do NOT invent');
    expect(system).toContain('no new numbers');
    expect(system).toContain('Do NOT mention the absence');
    const user = req.messages.find((m) => m.role === 'user')!.content;
    expect(user).toContain('Backend Engineer');
    expect(user).toContain(draft.evidenceHighlights[0]!.text);
    expect(user).toContain('typescript');
  });

  it('rejects model output without a body (schema violation)', async () => {
    const { draft, posting } = makeDraft();
    const client = new FakeLlmClient(() => ({ subject: 'only subject' }));
    const provider = new LlmCoverLetterProvider(client);
    await expect(provider.generate({ draft, posting, locale: 'en' })).rejects.toBeInstanceOf(
      LlmResponseError,
    );
  });

  it('rejects empty/oversized bodies as schema violations', async () => {
    const { draft, posting } = makeDraft();
    const short = new LlmCoverLetterProvider(new FakeLlmClient(() => ({ body: 'too short' })));
    await expect(short.generate({ draft, posting, locale: 'en' })).rejects.toBeInstanceOf(
      LlmResponseError,
    );
    const long = new LlmCoverLetterProvider(
      new FakeLlmClient(() => ({ body: 'x'.repeat(5000) })),
    );
    await expect(long.generate({ draft, posting, locale: 'en' })).rejects.toBeInstanceOf(
      LlmResponseError,
    );
  });

  it('strips unknown fields while accepting valid ones', async () => {
    const { draft, posting } = makeDraft();
    const client = new FakeLlmClient(() => ({
      body: 'Dear team, I build dependable TypeScript services visible in my public work.',
      extraNoise: 'ignore me',
    }));
    const out = await new LlmCoverLetterProvider(client).generate({ draft, posting, locale: 'en' });
    expect(out.body).toContain('TypeScript');
    expect('extraNoise' in out).toBe(false);
  });
});
