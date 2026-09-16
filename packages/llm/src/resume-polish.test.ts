import { describe, expect, it } from 'vitest';
import type { AbilityProfile, EvidenceItem, JobPosting, SkillTag } from '@jobagent/shared';
import { buildResume } from '@jobagent/resume-core';
import { polishResume } from '@jobagent/resume-core';
import { FakeLlmClient, LlmResumePolishProvider, LlmResponseError, RESUME_POLISH_PROMPT_VERSION } from './index.js';

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
    description: 'typescript backend role',
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

describe('LlmResumePolishProvider', () => {
  it('builds a constrained prompt and applies schema-valid wording edits end to end', async () => {
    const { draft, posting } = makeDraft();
    const client = new FakeLlmClient(() => ({
      summary: 'Reliability-focused backend engineer who ships TypeScript services.',
      highlights: [{ index: 0, text: 'Tightened TypeScript typing across the service layer.' }],
    }));
    const provider = new LlmResumePolishProvider(client);
    expect(provider.promptVersion).toBe(RESUME_POLISH_PROMPT_VERSION);
    expect(provider.provider).toBe('fake');
    expect(provider.model).toBe('fake-model-1');

    const result = await polishResume(draft, posting, provider, { locale: 'en', now: NOW });
    expect(result.applied).toBe(true);
    expect(result.draft.summary).toContain('Reliability-focused');
    expect(result.draft.evidenceHighlights[0]!.text).toContain('Tightened TypeScript');
    expect(result.draft.provenance.polish).toMatchObject({
      provider: 'fake',
      model: 'fake-model-1',
      promptVersion: RESUME_POLISH_PROMPT_VERSION,
      appliedAt: NOW,
    });

    // prompt 注入了硬约束与岗位/原文上下文，且用低温度
    const req = client.calls[0]!;
    expect(req.temperature).toBe(0.3);
    const system = req.messages.find((m) => m.role === 'system')!.content;
    expect(system).toContain('ONLY polish');
    expect(system).toContain('new numbers');
    const user = req.messages.find((m) => m.role === 'user')!.content;
    expect(user).toContain('Backend Engineer');
    expect(user).toContain(draft.evidenceHighlights[0]!.text);
  });

  it('is rolled back when the model injects a new metric number (safety net integration)', async () => {
    const { draft, posting } = makeDraft();
    const client = new FakeLlmClient(() => ({
      highlights: [{ index: 0, text: 'Refactored TypeScript and cut latency by 50 percent.' }],
    }));
    const result = await polishResume(draft, posting, new LlmResumePolishProvider(client), { now: NOW });
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('fabrication_detected');
    expect(result.draft).toBe(draft);
  });

  it('maps schema-invalid model output to provider_error rollback', async () => {
    const { draft, posting } = makeDraft();
    const client = new FakeLlmClient(() => ({ summary: 123 })); // 类型错误
    const result = await polishResume(draft, posting, new LlmResumePolishProvider(client), { now: NOW });
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('provider_error');
    expect(result.draft).toBe(draft);
  });

  it('maps non-JSON model output to LlmResponseError then rollback', async () => {
    const { draft, posting } = makeDraft();
    const client = new FakeLlmClient(() => 'I cannot do that'); // 非 JSON
    const provider = new LlmResumePolishProvider(client);
    // adapter 直接调用时抛 LlmResponseError
    await expect(provider.polish({ draft, posting, locale: 'en' })).rejects.toBeInstanceOf(LlmResponseError);
    // 经安全层则回退
    const result = await polishResume(draft, posting, provider, { now: NOW });
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('provider_error');
  });

  it('strips unknown fields while accepting valid ones', async () => {
    const { draft, posting } = makeDraft();
    const client = new FakeLlmClient(() => ({
      summary: 'Backend engineer who ships dependable TypeScript services.',
      extraNoise: 'ignore me',
    }));
    const result = await polishResume(draft, posting, new LlmResumePolishProvider(client), { now: NOW });
    expect(result.applied).toBe(true);
    expect(result.draft.summary).toContain('dependable TypeScript');
  });
});
