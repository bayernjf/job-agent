/**
 * JD 启发式抽取测试：标题清洗、公司（at / is hiring / 域名兜底）、
 * 地点/远程/薪资/技能标签。抽不出关键字段必须返回 null（不编造）。
 */
import { describe, expect, it } from 'vitest';
import { extractJobFromSearchResult, looksLikeJobPosting, type ExtractedJob } from './jd-extract.js';

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

describe('looksLikeJobPosting (T1-1 false-positive guard)', () => {
  it('rejects social/channel and data-site hosts', () => {
    expect(looksLikeJobPosting(item({ url: 'https://t.me/remote_workers', title: '远程工作者 – Telegram' }))).toBe(false);
    expect(
      looksLikeJobPosting(item({
        url: 'https://rocketreach.co/acme-management_abc',
        title: 'Acme Management Team | Org Chart',
        content: 'List of executives at Acme.',
      })),
    ).toBe(false);
  });

  it('rejects aggregator listing titles and listing URLs', () => {
    expect(
      looksLikeJobPosting(item({
        url: 'https://www.liepin.com/zhaopin/remote-java.shtml',
        title: '【全程远程办公JAVA招聘网_2026年全程远程办公JAVA招聘信息】-猎聘',
        content: '最新 Java 远程岗位列表，点击查看更多。',
      })),
    ).toBe(false);
    expect(looksLikeJobPosting(item({ url: 'https://example.com/jobs', title: 'Jobs' }))).toBe(false);
    expect(
      looksLikeJobPosting(item({ url: 'https://v2ex.com/t/12345', title: '8 年 Java 开发，找一份兼职，工作日远程' })),
    ).toBe(false);
    expect(
      looksLikeJobPosting(item({ url: 'https://boards.greenhouse.io/acme?job_board=true', title: 'Acme Jobs' })),
    ).toBe(false);
  });

  it('rejects SEO aggregator titles (Indeed/DevJobsScanner)', () => {
    expect(
      looksLikeJobPosting(item({
        url: 'https://www.indeed.com/jobs?q=AI+Agent',
        title: 'Now Hiring: 8,000 Ai Agent Developer Jobs',
        content: 'Browse all AI agent jobs and apply today.',
      })),
    ).toBe(false);
    expect(
      looksLikeJobPosting(item({
        url: 'https://devjobsscanner.com/jobs/ai',
        title: 'Ai agent build Latest Developer Job Openings',
        content: 'Browse the latest developer job openings aggregated here.',
      })),
    ).toBe(false);
    expect(
      looksLikeJobPosting(item({
        url: 'https://example.com/roles',
        title: 'Flexible Developer Jobs – Apply Today to Work From Home',
        content: 'Apply today to thousands of flexible developer jobs.',
      })),
    ).toBe(false);
  });

  it('rejects course platforms, explainer articles and generic jobs navigation', () => {
    expect(
      looksLikeJobPosting(item({
        url: 'https://www.ibm.com/topics/ai-agent-development',
        title: 'What Is AI Agent Development?',
        content: 'Learn how AI agents work, with examples of LLM orchestration and tool use in modern systems.',
      })),
    ).toBe(false);
    expect(
      looksLikeJobPosting(item({
        url: 'https://www.coursera.org/learn/ai-agent-developer',
        title: 'AI Agent Developer',
        content: 'This online course covers agent development with hands-on certification projects.',
      })),
    ).toBe(false);
    expect(
      looksLikeJobPosting(item({
        url: 'https://wellfound.com/location/miami',
        title: 'Miami Jobs - Tech & Startup Jobs',
        content: 'Browse tech and startup jobs in Miami across every role and industry.',
      })),
    ).toBe(false);
    expect(
      looksLikeJobPosting(item({
        url: 'https://sierra.ai/blog/meet-agent-engineer',
        title: 'Meet the AI agent engineer',
        content: 'A blog post describing the role, the team and a day in the life on the engineering floor.',
      })),
    ).toBe(false);
  });

  it('rejects generic articles without job words or JD signals', () => {
    expect(
      looksLikeJobPosting(item({
        url: 'https://example.com/blog/my-thoughts',
        title: 'My thoughts on the industry',
        content: 'Some long-form opinion content without any hiring language or skill terms at all.',
      })),
    ).toBe(false);
  });

  it('accepts real ATS detail pages and JD-like content', () => {
    expect(
      looksLikeJobPosting(item({
        url: 'https://jobs.lever.co/acme/abc-123-def',
        title: 'Senior Backend Engineer',
        content: '',
      })),
    ).toBe(true);
    expect(
      looksLikeJobPosting(item({
        url: 'https://example.com/careers/backend-role',
        title: 'Join our platform team',
        content: 'Requirements: 5 years of experience with distributed systems. Responsibilities include design reviews.',
      })),
    ).toBe(true);
    expect(
      looksLikeJobPosting(item({
        url: 'https://example.com/role',
        title: 'A role on the team',
        content: 'You will work daily with React, TypeScript and PostgreSQL across the stack.',
      })),
    ).toBe(true); // ≥2 skill hits
  });
});
