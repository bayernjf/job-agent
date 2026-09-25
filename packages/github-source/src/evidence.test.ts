import { describe, expect, it } from 'vitest';
import { buildPullRequestEvidence } from './evidence.js';
import type { AnalyzerInput } from '@jobagent/analyzer-core';

/**
 * PR 证据文案（T06）。改动规模是招聘方真正会看的一行，但它只在证据源
 * 真的给出统计时才允许出现——缺失必须表现为"这行不存在"，不是 "+0/-0"。
 */
type Pr = AnalyzerInput['pullRequests'][number];

function pr(stats: Partial<Pick<Pr, 'additions' | 'deletions' | 'changedFiles'>>): Pr {
  return {
    number: 42,
    title: 'Stream MCP responses',
    url: 'https://github.com/dev-strong/core/pull/42',
    state: 'MERGED',
    createdAt: '2026-07-02T10:00:00Z',
    mergedAt: '2026-07-03T10:00:00Z',
    repoNameWithOwner: 'dev-strong/core',
    repoIsFork: false,
    repoOwnerIsSelf: false,
    additions: 120,
    deletions: 30,
    changedFiles: 14,
    ...stats,
  };
}

describe('buildPullRequestEvidence', () => {
  it('states the diff scale when the source provides it', () => {
    const item = buildPullRequestEvidence(pr({}));
    expect(item.claim).toBe('PR "Stream MCP responses" (dev-strong/core#42) · +120/-30 across 14 files');
    // 指针与 id 不因文案变化，旧快照的 evidenceId 仍可解析
    expect(item.evidenceId).toBe('pr:dev-strong/core:42');
    expect(item.rawRef).toBe('dev-strong/core#42');
  });

  it('keeps the bare claim when stats are unknown, rather than writing zeros', () => {
    const item = buildPullRequestEvidence(pr({ additions: null, deletions: null, changedFiles: null }));
    expect(item.claim).toBe('PR "Stream MCP responses" (dev-strong/core#42)');
    expect(item.claim).not.toContain('0');
  });

  it('withholds the scale if any single stat is missing', () => {
    const item = buildPullRequestEvidence(pr({ changedFiles: null }));
    expect(item.claim).not.toContain('across');
  });
});
