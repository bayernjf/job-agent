/**
 * 项目条目解析（T13）单测：四类稳定 claim 格式 + 未知格式跳过 + no-fabrication refs。
 */
import { describe, expect, it } from 'vitest';
import type { EvidenceItem } from '@jobagent/shared';
import { actionLabel, parseProjectEntry, projectEntriesFromEvidence } from './project-entries.js';

function ev(partial: Partial<EvidenceItem> & { claim: string; sourceType: EvidenceItem['sourceType'] }): EvidenceItem {
  return {
    evidenceId: 'e1',
    sourcePlatform: 'github',
    url: 'https://github.test/x',
    layer: 'L1',
    rawRef: 'x',
    ...partial,
  } as EvidenceItem;
}

describe('parseProjectEntry', () => {
  it('parses a PR with diff stats (T06 format)', () => {
    const e = ev({
      sourceType: 'pr',
      claim: 'PR "Stream MCP responses" (dev-strong/core#42) · +120/-30 across 14 files',
      url: 'https://github.test/pr/1',
      occurredAt: '2026-01-02T00:00:00.000Z',
    });
    expect(parseProjectEntry(e)).toEqual({
      project: 'dev-strong/core',
      action: 'pr',
      title: 'Stream MCP responses',
      scale: '+120/-30 across 14 files',
      url: 'https://github.test/pr/1',
      occurredAt: '2026-01-02T00:00:00.000Z',
      evidenceRefs: ['e1'],
    });
  });

  it('parses a bare PR claim without stats (scale omitted, no zeros)', () => {
    const e = ev({ sourceType: 'pr', claim: 'PR "Refactor CLI" (me/tool#7)' });
    const parsed = parseProjectEntry(e);
    expect(parsed).not.toBeNull();
    expect(parsed!.scale).toBeUndefined();
    expect(parsed!.title).toBe('Refactor CLI');
    expect(parsed!.project).toBe('me/tool');
  });

  it('parses an issue claim', () => {
    const e = ev({ sourceType: 'issue', claim: 'Issue "Slow startup" (app/core#12)' });
    expect(parseProjectEntry(e)).toMatchObject({
      project: 'app/core',
      action: 'issue',
      title: 'Slow startup',
      evidenceRefs: ['e1'],
    });
  });

  it('parses a commit fallback claim', () => {
    const e = ev({ sourceType: 'commit', claim: 'Commit a1b2c3d (me/repo)' });
    expect(parseProjectEntry(e)).toMatchObject({
      project: 'me/repo',
      action: 'commit',
      title: 'Commit a1b2c3d',
    });
  });

  it('parses a repository claim with stars/forks as scale', () => {
    const e = ev({
      sourceType: 'repo',
      claim: 'Repository dev/kit (TypeScript): 128 stars / 9 forks, last pushed 2026-03-01',
    });
    expect(parseProjectEntry(e)).toMatchObject({
      project: 'dev/kit',
      action: 'repo',
      title: 'dev/kit',
      scale: '128 stars / 9 forks',
    });
  });

  it('skips unrecognized claims instead of guessing', () => {
    // messageHeadline 形式的 commit 无 repo 信息 → 不解析
    expect(parseProjectEntry(ev({ sourceType: 'commit', claim: 'Fix typo in docs' }))).toBeNull();
    expect(parseProjectEntry(ev({ sourceType: 'contribution', claim: 'GitHub account u: ...' }))).toBeNull();
    expect(parseProjectEntry(ev({ sourceType: 'pr', claim: 'PR broken format' }))).toBeNull();
    expect(parseProjectEntry(ev({ sourceType: 'file', claim: 'some file' }))).toBeNull();
  });
});

describe('projectEntriesFromEvidence', () => {
  it('orders by action strength then recency and slices by limit', () => {
    const pr = ev({
      sourceType: 'pr',
      claim: 'PR "A" (o/r#1)',
      occurredAt: '2026-01-01T00:00:00.000Z',
    });
    const issue = ev({
      sourceType: 'issue',
      claim: 'Issue "B" (o/r#2)',
      occurredAt: '2026-02-01T00:00:00.000Z',
    });
    const commit = ev({ sourceType: 'commit', claim: 'Commit abc1234 (o/r)' });
    const repo = ev({ sourceType: 'repo', claim: 'Repository o/r: 1 stars / 1 forks, last pushed 2026-01-01' });
    const entries = projectEntriesFromEvidence([repo, issue, commit, pr], 3);
    expect(entries.map((e) => e.action)).toEqual(['pr', 'issue', 'commit']);
    // 无时间排最后
    const all = projectEntriesFromEvidence([issue, commit, repo, pr], 0);
    expect(all[all.length - 1]!.action).toBe('repo');
  });

  it('drops unrecognized evidence entirely', () => {
    const e = ev({ sourceType: 'commit', claim: 'message headline without repo' });
    expect(projectEntriesFromEvidence([e], 0)).toEqual([]);
  });
});

describe('actionLabel', () => {
  it('maps known actions to display words', () => {
    expect(actionLabel('pr')).toBe('PR');
    expect(actionLabel('issue')).toBe('Issue');
    expect(actionLabel('commit')).toBe('Commit');
    expect(actionLabel('repo')).toBe('Repository');
  });
});
