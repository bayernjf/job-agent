/**
 * report-format 单测（#7）：验证 AbilityProfile → Markdown / HTML 渲染。
 */
import { describe, expect, it } from 'vitest';
import type { AbilityProfile } from '@jobagent/shared';
import { toHtml, toMarkdown } from './report-format.js';

function sampleProfile(overrides: Partial<AbilityProfile> = {}): AbilityProfile {
  return {
    profileId: 'prof-test',
    analyzerVersion: 'schema-0.1-engine-0.1.0',
    generatedAt: '2026-09-11T08:00:00.000Z',
    dataWindow: { since: '2025-09-11T00:00:00.000Z', until: '2026-09-11T00:00:00.000Z' },
    analysisLayers: ['L0', 'L1'],
    subject: {
      platform: 'github',
      login: 'octocat',
      profileUrl: 'https://github.com/octocat',
      claimed: false,
    },
    summary: { headline: 'Solid backend developer' },
    skillTags: [
      { name: 'TypeScript', kind: 'language', depth: 'proficient', confidence: 0.9, evidenceRefs: ['e1'] },
    ],
    activity: { longevityMonths: 36, metrics: { totalCommits: 500 } },
    collaboration: { evidenceRefs: [], prSummary: 'Active in external repos' },
    authenticity: {
      status: 'likely_authentic',
      confidence: 0.82,
      signals: [
        { code: 'external_contributions', severity: 'positive', label: 'External PRs merged', detail: '3 merged upstream', evidenceRefs: ['e2'] },
      ],
    },
    interviewQuestions: [
      { question: 'Describe your hardest PR.', intent: 'Probe depth', basisEvidenceRef: 'e2' },
    ],
    caveats: ['Private contribution graph hidden'],
    ...overrides,
  } as AbilityProfile;
}

describe('toMarkdown', () => {
  it('renders headline, login and key sections', () => {
    const md = toMarkdown(sampleProfile());
    expect(md).toContain('# Ability Profile — octocat');
    expect(md).toContain('Solid backend developer');
    expect(md).toContain('`TypeScript`');
    expect(md).toContain('36 months');
    expect(md).toContain('Likely Authentic');
    expect(md).toContain('82%');
    expect(md).toContain('Describe your hardest PR.');
    expect(md).toContain('Private contribution graph hidden');
  });

  it('handles empty skill tags, questions and caveats', () => {
    const md = toMarkdown(
      sampleProfile({
        skillTags: [],
        interviewQuestions: [],
        caveats: [],
        activity: {},
        collaboration: { evidenceRefs: [] },
      }),
    );
    expect(md).toContain('_No skill tags detected._');
    expect(md).toContain('## Caveats');
  });

  it('escapes nothing unsafe in markdown but keeps profile url', () => {
    const md = toMarkdown(sampleProfile());
    expect(md).toContain('https://github.com/octocat');
  });
});

describe('toHtml', () => {
  it('renders a complete HTML document with escaped content', () => {
    const html = toHtml(sampleProfile());
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<title>Ability Profile — octocat</title>');
    expect(html).toContain('Solid backend developer');
    expect(html).toContain('TypeScript');
    expect(html).toContain('Likely Authentic');
    expect(html).toContain('82%');
  });

  it('HTML-escapes special characters in text fields', () => {
    const html = toHtml(
      sampleProfile({
        summary: { headline: 'x<script>alert(1)</script>' },
      }),
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('handles empty collections gracefully', () => {
    const html = toHtml(
      sampleProfile({
        skillTags: [],
        interviewQuestions: [],
        caveats: [],
      }),
    );
    expect(html).toContain('No skill tags detected.');
    expect(html).toContain('<em>None.</em>');
  });
});
