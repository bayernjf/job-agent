/**
 * JD 启发式抽取测试：标题清洗、公司（at / is hiring / 域名兜底）、
 * 地点/远程/薪资/技能标签。抽不出关键字段必须返回 null（不编造）。
 */
import { describe, expect, it } from 'vitest';
import { extractJobFromSearchResult, type ExtractedJob } from './jd-extract.js';

const BASE_CONDITIONS = {
  queries: ['test'],
  location: null,
  remote: false,
  salaryMinUsd: null,
  keywords: [],
};

function item(partial: Partial<{ title: string; url: string; content: string }>) {
  return {
    title: partial.title ?? 'Software Engineer',
    url: partial.url ?? 'https://example.com/jobs/1',
    content: partial.content ?? '',
    score: 0.9,
  };
}

describe('extractJobFromSearchResult', () => {
  it('parses "X at Y" company and strips site suffix from title', () => {
    const ext = extractJobFromSearchResult(
      item({ title: 'Senior Backend Engineer at Acme - LinkedIn' }),
      BASE_CONDITIONS,
    ) as ExtractedJob;
    expect(ext).not.toBeNull();
    expect(ext.title).toBe('Senior Backend Engineer at Acme');
    expect(ext.company).toBe('Acme');
  });

  it('falls back to "Y is hiring" in content', () => {
    const ext = extractJobFromSearchResult(
      item({ content: 'Globex is hiring a Product Designer in Berlin. $90k-$110k' }),
      BASE_CONDITIONS,
    ) as ExtractedJob;
    expect(ext).not.toBeNull();
    expect(ext.company).toBe('Globex');
    expect(ext.location).toBe('Berlin');
    expect(ext.salaryMin).toBe(90000);
    expect(ext.salaryMax).toBe(110000);
  });

  it('falls back to the site domain when no company signal exists', () => {
    const ext = extractJobFromSearchResult(
      item({ title: 'Platform Engineer', url: 'https://jobs.acme.io/xyz' }),
      BASE_CONDITIONS,
    ) as ExtractedJob;
    expect(ext).not.toBeNull();
    expect(ext.company).toBe('jobs.acme.io');
  });

  it('flags remote from content and honors user condition', () => {
    const remoteExt = extractJobFromSearchResult(
      item({ title: 'Engineer at Acme', content: 'Fully remote, work from anywhere' }),
      BASE_CONDITIONS,
    ) as ExtractedJob;
    expect(remoteExt.remote).toBe(true);
    const forced = extractJobFromSearchResult(
      item({ title: 'Engineer at Acme', content: 'no mention' }),
      { ...BASE_CONDITIONS, remote: true },
    ) as ExtractedJob;
    expect(forced.remote).toBe(true);
  });

  it('extracts user keywords as tags', () => {
    const ext = extractJobFromSearchResult(
      item({ content: 'We use React and TypeScript daily' }),
      { ...BASE_CONDITIONS, keywords: ['React'] },
    ) as ExtractedJob;
    expect(ext.tags).toContain('React');
    expect(ext.tags).toContain('react');
  });

  it('returns null when no title/company can be extracted (never fabricates)', () => {
    expect(
      extractJobFromSearchResult(item({ title: '  ', content: 'spam' }), BASE_CONDITIONS),
    ).toBeNull();
    expect(
      extractJobFromSearchResult(item({ url: 'not-a-valid-url', content: 'completely unstructured text' }), BASE_CONDITIONS),
    ).toBeNull();
  });
});
