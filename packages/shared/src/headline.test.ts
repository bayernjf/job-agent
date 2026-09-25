import { describe, expect, it } from 'vitest';
import {
  composeHeadline,
  headlineFactsFromProfile,
  type AbilityProfile,
  type SkillTag,
} from './index.js';

type ProfileFacts = Pick<AbilityProfile, 'subject' | 'skillTags' | 'activity'>;

function tag(name: string, kind: SkillTag['kind'], confidence: number): SkillTag {
  return { name, kind, depth: 'used', confidence, evidenceRefs: [] };
}

function profile(overrides: Partial<ProfileFacts> = {}): ProfileFacts {
  return {
    subject: {
      platform: 'github',
      login: 'alice',
      profileUrl: 'https://github.com/alice',
      claimed: false,
    },
    skillTags: [tag('react', 'framework', 0.9), tag('TypeScript', 'language', 0.8), tag('Go', 'language', 0.6)],
    activity: { longevityMonths: 14, metrics: { totalRepos: 9 } },
    ...overrides,
  };
}

describe('composeHeadline', () => {
  it('names the platform the subject lives on, so Gitee is never labelled GitHub', () => {
    const gitee = composeHeadline({ platform: 'gitee', language: 'Go', repoCount: 3, months: 5 }, 'en');
    expect(gitee).toBe('Go developer with 3 public repos and 5 months of Gitee activity');
    expect(composeHeadline({ platform: 'gitee', months: 5 }, 'zh-CN')).toContain('Gitee');
  });

  it('renders both locales from the same facts', () => {
    const facts = { platform: 'github' as const, language: 'TypeScript', repoCount: 12, months: 14 };
    expect(composeHeadline(facts, 'en')).toBe(
      'TypeScript developer with 12 public repos and 14 months of GitHub activity',
    );
    expect(composeHeadline(facts, 'zh-CN')).toBe(
      'TypeScript 开发者，12 个公开仓库，在 GitHub 持续活跃 14 个月',
    );
  });

  it('keeps a single repo singular', () => {
    expect(composeHeadline({ platform: 'github', repoCount: 1, months: 3 }, 'en')).toBe(
      'GitHub developer with 1 public repo and 3 months of GitHub activity',
    );
  });

  it('drops missing facts instead of leaving dangling connective tissue', () => {
    expect(composeHeadline({ platform: 'github' }, 'en')).toBe('GitHub developer');
    expect(composeHeadline({ platform: 'github' }, 'en')).not.toContain('with');
    expect(composeHeadline({ platform: 'gitee', months: 0 }, 'zh-CN')).toBe('Gitee 开发者');
    expect(composeHeadline({ platform: 'github', language: 'Go', months: 7 }, 'en')).toBe(
      'Go developer with 7 months of GitHub activity',
    );
    expect(composeHeadline({ platform: 'github', language: 'Go', repoCount: 4 }, 'en')).toBe(
      'Go developer with 4 public repos',
    );
    expect(composeHeadline({ platform: 'github', language: 'Go', repoCount: 4 }, 'zh-CN')).toBe(
      'Go 开发者，4 个公开仓库',
    );
  });

  it('ignores a blank language rather than emitting " developer"', () => {
    expect(composeHeadline({ platform: 'github', language: '   ', months: 2 }, 'en')).toBe(
      'GitHub developer with 2 months of GitHub activity',
    );
  });
});

describe('headlineFactsFromProfile', () => {
  it('picks the first language tag in snapshot order, skipping frameworks', () => {
    // 分析内核写快照时已按置信度排好 language 标签，这里按序取第一个语言标签
    expect(headlineFactsFromProfile(profile()).language).toBe('TypeScript');
    const reordered = profile({
      skillTags: [tag('react', 'framework', 0.9), tag('Go', 'language', 0.6), tag('TypeScript', 'language', 0.8)],
    });
    expect(headlineFactsFromProfile(reordered).language).toBe('Go');
  });

  it('reads counts from activity and degrades to nulls when absent', () => {
    const facts = headlineFactsFromProfile(profile());
    expect(facts.repoCount).toBe(9);
    expect(facts.months).toBe(14);
    const empty = headlineFactsFromProfile(profile({ activity: {} }));
    expect(empty.repoCount).toBeNull();
    expect(empty.months).toBeNull();
    expect(composeHeadline(empty, 'zh-CN')).toBe('TypeScript 开发者');
  });

  it('has no language to report for a snapshot whose tags are all frameworks', () => {
    const facts = headlineFactsFromProfile(profile({ skillTags: [tag('react', 'framework', 0.9)] }));
    expect(facts.language).toBeNull();
    expect(composeHeadline(facts, 'en')).toBe(
      'GitHub developer with 9 public repos and 14 months of GitHub activity',
    );
  });
});
