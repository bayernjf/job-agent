/**
 * JobRecommendations 纯 helper 单测（审查动作 #9）。
 * 重点：分档只用 shared.matchScoreTier（与扩展同口径）、模板占位必须真被替换、
 * 证据引用按顺序去重且查不到的 ref 必须丢弃（无证据不展示）。
 */
import { describe, expect, it } from 'vitest';
import {
  collectMatchEvidence,
  fillCount,
  fillRepost,
  formatDate,
  scoreClass,
} from './JobRecommendations.tsx';

describe('scoreClass', () => {
  it('maps scores to the shared tier classes (no independent thresholds)', () => {
    expect(scoreClass(30, 2)).toBe('rec-score--high'); // 30 / (2*6) = 2.5
    expect(scoreClass(6, 2)).toBe('rec-score--mid'); // 6 / (2*6) = 0.5
    expect(scoreClass(3, 2)).toBe('rec-score--low'); // 3 / (2*6) = 0.25
    expect(scoreClass(100, 0)).toBe('rec-score--low'); // 零命中技能一律 low
  });
});

describe('fillCount / fillRepost', () => {
  it('replaces every {count} placeholder and leaves other text intact', () => {
    expect(fillCount('{count} 个岗位 / {count} matches', 3)).toBe('3 个岗位 / 3 matches');
  });

  it('fills both {count} and {date} for the repost notice', () => {
    expect(fillRepost('{count} 个岗位于 {date} 再次上架', 2, '2026-10-14')).toBe(
      '2 个岗位于 2026-10-14 再次上架',
    );
  });

  it('does not interpret regex metacharacters in the date', () => {
    expect(fillRepost('{date}', 1, '$& {date}')).toBe('$& {date}');
  });
});

describe('collectMatchEvidence', () => {
  const dict = {
    'ev-1': { id: 'ev-1' },
    'ev-2': { id: 'ev-2' },
  } as unknown as Parameters<typeof collectMatchEvidence>[1];

  it('keeps first-seen order, de-duplicates refs and drops unknown refs', () => {
    const reasons = [
      { evidenceRefs: ['ev-2', 'ev-1'] },
      { evidenceRefs: ['ev-1', 'missing'] },
    ] as unknown as Parameters<typeof collectMatchEvidence>[0];
    expect(collectMatchEvidence(reasons, dict)).toEqual([{ id: 'ev-2' }, { id: 'ev-1' }]);
  });

  it('returns an empty list when reasons or the evidence dictionary is absent', () => {
    expect(collectMatchEvidence(undefined, dict)).toEqual([]);
    expect(collectMatchEvidence([], undefined)).toEqual([]);
  });
});

describe('formatDate', () => {
  it('returns an empty string for a missing timestamp', () => {
    expect(formatDate(undefined, 'en')).toBe('');
  });

  it('formats a valid timestamp for both locales', () => {
    expect(formatDate('2026-10-14T00:00:00.000Z', 'en')).toContain('2026');
    expect(formatDate('2026-10-14T00:00:00.000Z', 'zh-CN')).toContain('2026');
  });
});
