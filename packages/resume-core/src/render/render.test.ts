import { describe, expect, it } from 'vitest';
import { buildResume, renderHtml, renderMarkdown } from '../index.js';
import type { BuildResumeInput } from '../index.js';

function baseInput(claim = 'Refactored service'): BuildResumeInput {
  return {
    profile: {
      profileId: 'p-1',
      analyzerVersion: '0.1-0.2',
      generatedAt: '2026-09-15T00:00:00.000Z',
      dataWindow: { since: '2024-01-01T00:00:00.000Z', until: '2026-09-01T00:00:00.000Z' },
      analysisLayers: ['L0', 'L1'],
      subject: { platform: 'github', login: 'alice', profileUrl: 'https://github.com/alice', claimed: false },
      summary: { headline: 'Backend developer' },
      skillTags: [
        { name: 'typescript', kind: 'language', depth: 'proficient', confidence: 0.9, evidenceRefs: ['ev-1'] },
      ],
      activity: {},
      collaboration: { evidenceRefs: [] },
      authenticity: { status: 'likely_authentic', confidence: 0.8, signals: [] },
      interviewQuestions: [],
      caveats: [],
    },
    evidence: [
      {
        evidenceId: 'ev-1',
        sourcePlatform: 'github',
        sourceType: 'pr',
        url: 'https://github.com/acme/repo/pull/1',
        occurredAt: '2026-05-01T00:00:00.000Z',
        layer: 'L1',
        claim,
        rawRef: '#1',
      },
    ],
    posting: {
      jobId: 'j-1',
      source: 'greenhouse',
      sourceUrl: 'https://example.com/jobs/j-1',
      title: 'Backend Engineer',
      company: 'Acme',
      location: null,
      remote: true,
      salaryMin: null,
      salaryMax: null,
      salaryCurrency: null,
      tags: ['typescript'],
      description: '',
      postedAt: '2026-09-01T00:00:00.000Z',
      fetchedAt: '2026-09-02T00:00:00.000Z',
    },
    match: {
      score: 5,
      matchedSkills: ['typescript'],
      fieldScores: { title: 3, tags: 2, description: 0 },
      skillHits: [{ skill: 'typescript', score: 5, fields: ['title', 'tags'] }],
    },
    options: { now: '2026-09-15T08:00:00.000Z', locale: 'zh-CN' },
  };
}

describe('renderMarkdown', () => {
  it('renders ATS-friendly sections with the evidence link', () => {
    const md = renderMarkdown(buildResume(baseInput()), 'zh-CN');
    // 姓名行只出现一次：headline 是角色描述，不再自带 login（T07）
    expect(md).toContain('# alice — typescript 开发者');
    expect(md).toContain('岗位匹配技能');
    expect(md).toContain('typescript');
    expect(md).toContain('[Refactored service](https://github.com/acme/repo/pull/1)');
  });

  it('keeps match internals, suggestions and provenance out of the exported file (T12)', () => {
    const draft = buildResume(baseInput());
    // 正向对照：先证明这份草稿里确实有那些内部面，否则下面的"不含"是空断言
    expect(draft.suggestions.length).toBeGreaterThan(0);
    expect(draft.targetJob.fieldScores).toEqual({ title: 3, tags: 2, description: 0 });

    const md = renderMarkdown(draft, 'zh-CN');
    expect(md).not.toContain('[missing_');
    expect(md).not.toContain('改进提示');
    expect(md).not.toContain('title 3/tags 2');
    expect(md).not.toContain('匹配度');
    expect(md).not.toContain('resume-rule');
    expect(md).not.toContain('溯源');
  });

  it('renders kernel prose in the reader language, not the snapshot English (T23)', () => {
    const input = baseInput();
    // 快照存的是数据层英文（内核原句）；中文读者要看到中文句子，数字仍来自画像
    input.profile.summary.seniorityHint = { band: 'senior', confidence: 0.6, evidenceRefs: ['ev-1'] };
    input.profile.activity.metrics = { totalPullRequests: 50, mergedPullRequests: 37 };
    input.profile.collaboration.prSummary = '50 PR(s) opened, 37 merged';
    // no-fabrication 闸要求 profile 条目必挂证据（这里正是它把空 refs 的草稿拦下过）
    input.profile.collaboration.evidenceRefs = ['ev-1'];

    const zhDraft = buildResume(input);
    const zh = renderMarkdown(zhDraft, 'zh-CN');
    expect(zh).toContain('（资深）');
    expect(zh).toContain('开过 50 个 PR，合并 37 个');
    expect(zh).toContain('(有深度)');
    expect(zh).not.toContain('senior');
    expect(zh).not.toContain('PR(s) opened');
    expect(zh).not.toContain('proficient');

    // 概述在装配时就按 --locale 定稿，所以英文读者要取英文草稿
    const en = renderMarkdown(buildResume({ ...input, options: { ...input.options, locale: 'en' } }), 'en');
    expect(en).toContain('(senior)');
    expect(en).toContain('50 PR(s) opened, 37 merged');
    expect(en).toContain('(proficient)');
  });

  it('renders English headings under en', () => {
    const md = renderMarkdown(buildResume(baseInput()), 'en');
    expect(md).toContain('## Summary');
    expect(md).toContain('Highlights');
  });

  it('renders LinkedIn once in the contact line when provided, and omits when absent', () => {
    const linkedin = 'https://linkedin.com/in/alice';
    const withLinkedIn = renderMarkdown(
      buildResume({ ...baseInput(), local: { linkedinUrl: linkedin } }),
      'en',
    );
    expect(withLinkedIn).toContain(linkedin);
    expect(withLinkedIn.split(linkedin)).toHaveLength(2); // exactly once
    const without = renderMarkdown(buildResume(baseInput()), 'en');
    expect(without).not.toContain('linkedin.com');
  });
});

describe('renderHtml', () => {
  it('escapes HTML in evidence claims (no raw script injection)', () => {
    const malicious = '<script>alert(1)</script>';
    const html = renderHtml(buildResume(baseInput(malicious)), 'zh-CN');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('uses design-token CSS variables and print rules, no raw hex in component rules', () => {
    const html = renderHtml(buildResume(baseInput()), 'zh-CN');
    expect(html).toContain('@media print');
    expect(html).toContain('var(--ja-color-neutral-900)');
    expect(html).toContain('var(--ja-font-sans)');
    expect(html).toContain('@page');
    expect(html).toContain('print-color-adjust: exact');
  });

  it('renders structured project entries with scale and evidence link (T13)', () => {
    const draft = buildResume(
      baseInput('PR "Stream MCP responses" (acme/repo#42) · +120/-30 across 14 files'),
    );
    expect(draft.projectEntries.length).toBeGreaterThan(0);
    const entry = draft.projectEntries[0]!;
    expect(entry.project).toBe('acme/repo');
    expect(entry.action).toBe('pr');
    expect(entry.title).toBe('Stream MCP responses');
    expect(entry.scale).toBe('+120/-30 across 14 files');
    expect(entry.evidenceRefs).toContain('ev-1');

    const md = renderMarkdown(draft, 'zh-CN');
    expect(md).toContain('## 项目经历');
    expect(md).toContain('[PR Stream MCP responses](https://github.com/acme/repo/pull/1)');
    expect(md).toContain('acme/repo');
    expect(md).toContain('+120/-30 across 14 files');

    const html = renderHtml(draft, 'zh-CN');
    expect(html).toContain('<h2>项目经历</h2>');
    expect(html).toContain('PR Stream MCP responses</a>');
    expect(html).toContain('+120/-30 across 14 files');
  });

  it('renders the quantified line when activity.metrics has all three keys (T14)', () => {
    const input = baseInput();
    input.profile.activity = {
      metrics: { mergedPullRequests: 38, commitRepoCount: 7, activeMonths: 24 },
    };
    const md = renderMarkdown(buildResume(input), 'zh-CN');
    expect(md).toContain('已合并 38 个 PR，覆盖 7 个活跃仓库，持续 24 个月');

    const enInput = { ...input, options: { ...input.options, locale: 'en' as const } };
    const en = renderMarkdown(buildResume(enInput), 'en');
    expect(en).toContain('Merged 38 pull request(s) across 7 active repositories over 24 months.');
  });

  it('omits the quantified line when metrics lack a key (old snapshots stay clean)', () => {
    const input = baseInput();
    input.profile.activity = { metrics: { commitCount: 120 } };
    const md = renderMarkdown(buildResume(input), 'zh-CN');
    expect(md).not.toContain('已合并');
    expect(md).not.toContain('pull request');
  });

  it('links evidence and keeps the score box out of the exported file (T12)', () => {
    const draft = buildResume(baseInput());
    const html = renderHtml(draft, 'en');
    expect(html).toContain('href="https://github.com/acme/repo/pull/1"');
    expect(html).toContain('Backend Engineer @ Acme');
    expect(html).not.toContain('title 3 / tags 2');
    expect(html).not.toContain('[missing_');
    expect(html).not.toContain('Provenance');
    expect(html).not.toContain('Suggestions');
  });
});
