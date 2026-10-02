/**
 * 投递限频（设计 §3.4/§4.6：遵守平台规则、防海投）。
 *
 * 阶段 1 投递由人执行，但「确认」即等于承诺要投，故限频按 committed
 * （status = approved | submitted）计数；同一个来源的额度按自然日滚动窗口统计，
 * 统计口径由存储层 `countCommittedBySourceSince` 提供，这里只做纯判断。
 */

/** 还剩多少额度（不为负）。 */
export function remainingDailyQuota(committed: number, limit: number): number {
  return Math.max(0, limit - Math.max(0, committed));
}

/** 该来源当日额度是否已用尽（committed >= limit）。 */
export function submitLimitReached(committed: number, limit: number): boolean {
  return remainingDailyQuota(committed, limit) === 0;
}
