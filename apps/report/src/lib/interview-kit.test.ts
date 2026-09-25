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

  it('renders English kit', () => {
    const md = renderInterviewKit(profile(), [evidence('e1', 'perf PR', 'https://github.test/pr/1')], 'en');
    expect(md).toContain('# Interview Prep Kit · Alice');
    expect(md).toContain('TypeScript developer with 24 months of GitHub activity');
    expect(md).toContain('## Interview questions grounded in real projects');
    expect(md).toContain('[perf PR](https://github.test/pr/1)');
  });
});
