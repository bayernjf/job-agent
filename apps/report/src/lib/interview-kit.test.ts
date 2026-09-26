import { describe, expect, it } from 'vitest';
import type { AbilityProfile, EvidenceItem } from '@jobagent/shared';
import { renderInterviewKit } from './interview-kit';

function evidence(id: string, claim: string, url: string): EvidenceItem {
  return {
    evidenceId: id,
    sourcePlatform: 'github',
    sourceType: 'pr',
    url,
    layer: 'L1',
    claim,
    rawRef: 'o/r#1',
  };
}

function profile(): AbilityProfile {
  return {
    profileId: 'p1',
    analyzerVersion: 'schema-0.1-engine-0.2.0',
    generatedAt: '2026-09-16T00:00:00.000Z',
    dataWindow: { since: '2025-09-16T00:00:00.000Z', until: '2026-09-16T00:00:00.000Z' },
    analysisLayers: ['L0', 'L1'],
    subject: {
      platform: 'github',
      login: 'alice',
      displayName: 'Alice',
      profileUrl: 'https://github.com/alice',
      claimed: false,
    },
    summary: { headline: 'frontend developer' },
    skillTags: [
      { name: 'TypeScript', kind: 'language', depth: 'proficient', confidence: 0.9, evidenceRefs: ['e1'] },
      { name: 'React', kind: 'framework', depth: 'used', confidence: 0.7, evidenceRefs: [] },
    ],
    activity: { longevityMonths: 24 },
    collaboration: { evidenceRefs: [] },
    authenticity: {
      status: 'likely_authentic',
      confidence: 0.9,
      signals: [{ code: 'long_history', severity: 'info', label: '长期活跃', detail: '账号活跃多年', evidenceRefs: [] }],
    },
    interviewQuestions: [
      {
        question: '讲讲你这个 PR 的性能优化？',
        intent: '考察性能分析能力',
        basisEvidenceRef: 'e1',
      },
      {
        question: '没有证据的问题？',
        intent: '考察降级',
        basisEvidenceRef: 'missing',
      },
    ],
    caveats: ['仅覆盖公开数据'],
  };
}

describe('renderInterviewKit', () => {
  it('renders Chinese kit with grouped skills and clickable evidence links', () => {
    const md = renderInterviewKit(profile(), [evidence('e1', 'perf PR', 'https://github.test/pr/1')], 'zh-CN');
    expect(md).toContain('# 面试准备包 · Alice');
    expect(md).toContain('@alice');
    // headline 随文档语言（T07）：中文准备包里不留英文原句
    expect(md).toContain('TypeScript 开发者，在 GitHub 持续活跃 24 个月');
    expect(md).toContain('### 编程语言');
    expect(md).toContain('**TypeScript**');
    expect(md).toContain('### 框架 / 工具');
    expect(md).toContain('[perf PR](https://github.test/pr/1)');
    expect(md).toContain('考察性能分析能力');
    expect(md).toContain('## 局限与说明');
    expect(md).toContain('仅覆盖公开数据');
  });

  it('falls back to a note when basis evidence has no URL', () => {
    const md = renderInterviewKit(profile(), [], 'zh-CN');
    expect(md).toContain('暂无可点击的原始证据');
  });

  it('renders the quantified overview when metrics have all three keys (T14)', () => {
    const p = profile();
    p.activity = { metrics: { mergedPullRequests: 38, commitRepoCount: 7, activeMonths: 24 } };
    const md = renderInterviewKit(p, [], 'zh-CN');
    expect(md).toContain('## 量化概览');
    expect(md).toContain('已合并 38 个 PR，覆盖 7 个活跃仓库，持续 24 个月');

    const en = renderInterviewKit(p, [], 'en');
    expect(en).toContain('## Quantified overview');
    expect(en).toContain('Merged 38 pull request(s) across 7 active repositories over 24 months.');
  });

  it('omits the quantified block when metrics lack a key (old snapshots stay clean)', () => {
    const md = renderInterviewKit(profile(), [], 'zh-CN');
    expect(md).not.toContain('量化概览');
    expect(md).not.toContain('已合并');
  });

  it('renders job-targeted prep with matched skills and ask-back questions (T16)', () => {
    const md = renderInterviewKit(
      profile(),
      [evidence('e1', 'perf PR', 'https://github.test/pr/1')],
      'zh-CN',
      {
        posting: { title: 'Frontend Engineer', company: 'Acme', sourceUrl: 'https://example.com/jobs/1' },
        matchedSkills: ['TypeScript'],
      },
    );
    expect(md).toContain('## 岗位定向准备');
    expect(md).toContain('目标岗位：**Frontend Engineer** @ Acme');
    expect(md).toContain('### 岗位命中技能');
    expect(md).toContain('**TypeScript**');
    expect(md).toContain('[perf PR](https://github.test/pr/1)');
    expect(md).toContain('## 你该反问什么');
    expect(md).toContain('针对「TypeScript」');

    const en = renderInterviewKit(
      profile(),
      [evidence('e1', 'perf PR', 'https://github.test/pr/1')],
      'en',
      {
        posting: { title: 'Frontend Engineer', company: 'Acme', sourceUrl: 'https://example.com/jobs/1' },
        matchedSkills: ['TypeScript'],
      },
    );
    expect(en).toContain('## Job-targeted prep');
    expect(en).toContain('## Questions to ask back');
    expect(en).toContain('For "TypeScript"');
  });

  it('stays generic when no job options are passed (T16 backward compatible)', () => {
    const md = renderInterviewKit(profile(), [], 'zh-CN');
    expect(md).not.toContain('岗位定向准备');
    expect(md).not.toContain('你该反问什么');
  });

  it('renders English kit', () => {
    const md = renderInterviewKit(profile(), [evidence('e1', 'perf PR', 'https://github.test/pr/1')], 'en');
    expect(md).toContain('# Interview Prep Kit · Alice');
    expect(md).toContain('TypeScript developer with 24 months of GitHub activity');
    expect(md).toContain('## Interview questions grounded in real projects');
    expect(md).toContain('[perf PR](https://github.test/pr/1)');
  });
});
