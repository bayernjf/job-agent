/**
 * `repostObservations` 纯函数测试（C 端体验增量：重复上架 / ghost job 弱信号）。
 * 判据的核心是"此前那条已经下架够久"，所以每个用例都只动时间戳、
 * 岗位文本（normalizedKey）保持一致——静态日期会腐烂，全部相对 NOW 计算。
 */
import { describe, expect, it } from 'vitest';
import type { JobPostingSighting } from '@jobagent/storage';
import { REPOST_MIN_DARK_DAYS, repostObservations } from './match-explain.js';

const DAY_MS = 86_400_000;
const NOW = Date.parse('2026-10-13T00:00:00.000Z');
const iso = (daysAgo: number) => new Date(NOW - daysAgo * DAY_MS).toISOString();

function sighting(
  id: string,
  normalizedKey: string,
  opts: { firstSeenDaysAgo: number; lastSeenDaysAgo: number; source?: string } = {
    firstSeenDaysAgo: 40,
    lastSeenDaysAgo: 40,
  },
): JobPostingSighting {
  return {
    id,
    normalizedKey,
    source: opts.source ?? 'remoteok',
    firstSeenAt: iso(opts.firstSeenDaysAgo),
    lastSeenAt: iso(opts.lastSeenDaysAgo),
  };
}

describe('repostObservations', () => {
  it('flags a posting whose identical text had gone dark before it reappeared', () => {
    const current = sighting('row-new', 'nk-shared', { firstSeenDaysAgo: 1, lastSeenDaysAgo: 0 });
    const prior = sighting('row-old', 'nk-shared', { firstSeenDaysAgo: 60, lastSeenDaysAgo: 30 });

    const out = repostObservations([current], [current, prior]);
    expect(out['row-new']).toEqual({
      priorListings: 1,
      earliestFirstSeenAt: '2026-08-14T00:00:00.000Z',
    });
    // 只给"新出现的那条"产观察，历史行自己不重复提示
    expect(out['row-old']).toBeUndefined();
  });

  it('does not flag the same live job picked up by a second source on a later day', () => {
    // 反例（假阳性的来源）：另一条从 40 天前起一直被列着（lastSeen 很近），
    // 说明它是同一个在招岗位的跨源副本，不是"消失后重登"。
    const current = sighting('row-new', 'nk-shared', { firstSeenDaysAgo: 1, lastSeenDaysAgo: 0 });
    const sibling = sighting('row-live', 'nk-shared', { firstSeenDaysAgo: 40, lastSeenDaysAgo: 0 });

    expect(repostObservations([current], [current, sibling])).toEqual({});
  });

  it('ignores gaps shorter than the dark threshold', () => {
    const current = sighting('row-new', 'nk-shared', { firstSeenDaysAgo: 1, lastSeenDaysAgo: 0 });
    // 静默 2 天 < REPOST_MIN_DARK_DAYS(3)：同一次采集轮次里的抖动，不算再上架
    const recent = sighting('row-recent', 'nk-shared', {
      firstSeenDaysAgo: 5,
      lastSeenDaysAgo: REPOST_MIN_DARK_DAYS - 1,
    });

    expect(repostObservations([current], [current, recent])).toEqual({});
  });

  it('counts several prior cycles and reports the earliest one', () => {
    const current = sighting('row-new', 'nk-shared', { firstSeenDaysAgo: 1, lastSeenDaysAgo: 0 });
    const first = sighting('row-a', 'nk-shared', { firstSeenDaysAgo: 200, lastSeenDaysAgo: 150 });
    const second = sighting('row-b', 'nk-shared', { firstSeenDaysAgo: 120, lastSeenDaysAgo: 90 });

    expect(repostObservations([current], [current, first, second])['row-new']).toEqual({
      priorListings: 2,
      earliestFirstSeenAt: '2026-03-27T00:00:00.000Z',
    });
  });

  it('stays silent without a key or with unreadable timestamps (fail closed)', () => {
    // 无 normalizedKey（招聘方自建 JD）＝没有可比对的文本，宁可不显示也不编日期
    const noKey = { id: 'row-1', normalizedKey: '', firstSeenAt: iso(1) };
    expect(repostObservations([noKey], [sighting('row-2', '', { firstSeenDaysAgo: 40, lastSeenDaysAgo: 30 })])).toEqual(
      {},
    );

    const broken = sighting('row-new', 'nk-shared', { firstSeenDaysAgo: 1, lastSeenDaysAgo: 0 });
    const badRow = { ...broken, firstSeenAt: 'not-a-date' };
    expect(repostObservations([badRow], [badRow, sighting('row-old', 'nk-shared')])).toEqual({});
  });
});
