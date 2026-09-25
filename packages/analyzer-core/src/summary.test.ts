import { describe, expect, it } from 'vitest';
import { composeHeadline, headlineFactsFromProfile } from '@jobagent/shared';
import { analyze } from './index.js';
import { buildInput } from './test-input.js';

/**
 * T07：headline 的平台与语言口径。快照里存的是英文数据层原文，
 * 渲染侧（报告页/简历/面试包）用 shared 的同一套模板按读者语言现拼。
 */
describe('stored headline (T07)', () => {
  it('names the platform the subject actually lives on', () => {
    const github = analyze(buildInput(), { profileId: 'p-github' });
    expect(github.summary.headline).toContain('GitHub');
    expect(github.summary.headline).not.toContain('Gitee');

    const gitee = analyze(buildInput(), { profileId: 'p-gitee', platform: 'gitee' });
    expect(gitee.summary.headline).toContain('Gitee');
    expect(gitee.summary.headline).not.toContain('GitHub');
  });

  it('advertises the dominant language, not whichever repo was collected first', () => {
    const base = buildInput();
    // 把唯一的 Go 仓挪到采集顺序第一位：语言仍应取覆盖最多仓库的 TypeScript
    const input = {
      ...base,
      repos: [...base.repos].sort(
        (a, b) => Number(a.primaryLanguage !== 'Go') - Number(b.primaryLanguage !== 'Go'),
      ),
    };
    expect(input.repos[0]?.primaryLanguage).toBe('Go');

    const profile = analyze(input, { profileId: 'p-order' });
    expect(profile.summary.headline).toContain('TypeScript developer');
    expect(profile.summary.headline).not.toContain('Go developer');
  });

  it('stores exactly the sentence the render side composes for an English reader', () => {
    for (const platform of ['github', 'gitee'] as const) {
      const profile = analyze(buildInput(), { profileId: `p-${platform}`, platform });
      expect(profile.summary.headline).toBe(composeHeadline(headlineFactsFromProfile(profile), 'en'));
    }
  });
});
