/**
 * 技能词典（决策 #23）的守护。
 *
 * 这里钉的是**两处刻意的保守**，而不是"词典里有多少词"这种会随业务增长的数字——后者
 * 变了不会错，前者变了会让"我没有证据"被包装成"你没做过"。
 */
import { describe, it, expect } from 'vitest';
import { extractSkillTokens } from './index.js';

const canonicals = (text: string) => extractSkillTokens(text).map((t) => t.canonical);

describe('extractSkillTokens', () => {
  it('matches known technology words case-insensitively', () => {
    expect(canonicals('I built a service in TypeScript')).toContain('TypeScript');
    expect(canonicals('i built a service in typescript')).toContain('TypeScript');
    expect(canonicals('Backend work with python and postgres')).toEqual(['Python', 'PostgreSQL']);
  });

  it('honors aliases and maps them back to the canonical name', () => {
    expect(canonicals('I wrote it in TS')).toContain('TypeScript');
    expect(canonicals('we use js across the stack')).toContain('JavaScript');
    expect(canonicals('deployed on k8s')).toContain('Kubernetes');
    expect(canonicals('a Go service')).toContain('Go');
  });

  it('respects word boundaries so company names and everyday words do not count', () => {
    // 这条是防误判的第一道护栏：把公司名/日常词当成技术声明，会把没有的东西说成有。
    expect(canonicals('I work at Google')).not.toContain('Go');
    expect(canonicals('Googling is fine')).not.toContain('Go');
    expect(canonicals('We use GraphQL')).not.toContain('Go');
  });

  it('handles entries whose canonical form contains regex metacharacters', () => {
    // C++ / Next.js / CI/CD 拼进 RegExp 前必须转义，否则 '/' 与 '+' 会被当成元字符。
    expect(canonicals('Systems programming in C++')).toContain('C++');
    expect(canonicals('Migrated the site to Next.js')).toContain('Next.js');
    expect(canonicals('We own the CI/CD pipeline')).toContain('CI/CD');
  });

  it('counts each canonical word once even when several writings appear', () => {
    // 去重不是洁癖：重复计数会把 partial 抬成 supportable。
    const tokens = extractSkillTokens('javascript first, then js for the tooling');
    expect(tokens.filter((t) => t.canonical === 'JavaScript')).toHaveLength(1);
  });

  it('returns nothing for free-form claims that carry no checkable token', () => {
    // "优秀的沟通能力" 这类必须退回 insufficient_data，绝不判 no_trace。
    expect(canonicals('Excellent communication skills and strong ownership')).toEqual([]);
    expect(canonicals('I am a great team player')).toEqual([]);
    expect(canonicals('')).toEqual([]);
  });

  it('keeps the matched writing so a human can audit why it matched', () => {
    const [token] = extractSkillTokens('deployed via k8s');
    expect(token?.canonical).toBe('Kubernetes');
    expect(token?.matched).toBe('k8s');
    expect(token?.kind).toBe('domain');
  });
});
