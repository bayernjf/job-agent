import { describe, expect, it } from 'vitest';
import {
  composePrSummary,
  composeSeniorityBand,
  composeSkillDepthLabel,
  prSummaryFactsFromProfile,
  type AbilityProfile,
} from './index.js';

describe('composeSkillDepthLabel', () => {
  it('renders the two depth levels per reader locale', () => {
    expect(composeSkillDepthLabel('proficient', 'zh-CN')).toBe('有深度');
    expect(composeSkillDepthLabel('used', 'zh-CN')).toBe('使用过');
    expect(composeSkillDepthLabel('proficient', 'en')).toBe('proficient');
    expect(composeSkillDepthLabel('used', 'en')).toBe('used');
  });
});

describe('composeSeniorityBand', () => {
  it('translates the three bands the kernel emits', () => {
    expect(composeSeniorityBand('senior', 'zh-CN')).toBe('资深');
    expect(composeSeniorityBand('mid', 'zh-CN')).toBe('中级');
    expect(composeSeniorityBand('junior', 'zh-CN')).toBe('初级');
  });

  it('returns an unknown band verbatim instead of inventing a label', () => {
    expect(composeSeniorityBand('principal', 'zh-CN')).toBe('principal');
  });
});

describe('composePrSummary', () => {
  it('keeps the English branch identical to the sentence stored in the snapshot', () => {
    expect(composePrSummary({ opened: 50, merged: 37 }, 'en')).toBe('50 PR(s) opened, 37 merged');
    expect(composePrSummary({ opened: 50, merged: 44, externalMerged: 44 }, 'en')).toBe(
      '50 PR(s) opened, 44 merged, 44 into external projects',
    );
  });

  it('renders Chinese with the same numbers and drops an absent external clause', () => {
    expect(composePrSummary({ opened: 50, merged: 37, externalMerged: 0 }, 'zh-CN')).toBe(
      '开过 50 个 PR，合并 37 个',
    );
    expect(composePrSummary({ opened: 50, merged: 44, externalMerged: 44 }, 'zh-CN')).toBe(
      '开过 50 个 PR，合并 44 个，其中 44 个合入他人仓库',
    );
  });
});

describe('prSummaryFactsFromProfile', () => {
  function withMetrics(metrics: Record<string, number> | undefined): Pick<AbilityProfile, 'activity'> {
    return { activity: { metrics } as AbilityProfile['activity'] };
  }

  it('reads the two counts the kernel writes into activity.metrics', () => {
    expect(
      prSummaryFactsFromProfile(withMetrics({ totalPullRequests: 50, mergedPullRequests: 37 })),
    ).toEqual({ opened: 50, merged: 37 });
  });

  it('returns null rather than a sentence with invented numbers', () => {
    expect(prSummaryFactsFromProfile(withMetrics(undefined))).toBeNull();
    expect(prSummaryFactsFromProfile(withMetrics({ totalPullRequests: 50 }))).toBeNull();
  });
});
