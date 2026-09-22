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
  it('renders ATS-friendly sections with evidence link and provenance', () => {
    const md = renderMarkdown(buildResume(baseInput()), 'zh-CN');
    expect(md).toContain('# alice — Backend developer');
    expect(md).toContain('岗位匹配技能');
    expect(md).toContain('typescript');
    expect(md).toContain('[Refactored service](https://github.com/acme/repo/pull/1)');
    expect(md).toContain('resume-rule 0.1');
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

  it('links evidence and shows tier', () => {
    const html = renderHtml(buildResume(baseInput()), 'en');
    expect(html).toContain('href="https://github.com/acme/repo/pull/1"');
    expect(html).toContain('high');
  });
});
