/**
 * 待确认新候选批次的「未读」判定（纯函数，零 I/O）。
 *
 * 背景：cron 每 5 分钟扫一轮，run 进入 `awaiting_approval` 就说明有一批候选
 * 在等用户确认，但用户不打开工作台就不知道。`job_runs.last_viewed_at` 记录
 * 拥有者上次查看的时刻，`updated_at` 在状态推进（含进入 awaiting_approval）时被盖。
 *
 * 未读口径（只认事实，不猜）：
 *   - 只有 `awaiting_approval`（人机闸前、等人确认）才算；
 *     submitting/tracking 等后续状态不再提醒；
 *   - 从未查看（lastViewedAt=null），或上次查看早于当前状态落定（updatedAt），即为未读。
 * 这样 reject 回 watching 后下一批重新进入 awaiting_approval，updatedAt 更新，
 * 徽标会再次点亮——每一批新候选都只在被看过之后才消音。
 */
export interface UnseenRunFacts {
  status: string;
  lastViewedAt: string | null;
  updatedAt: string;
}

export function hasUnseenApprovals(run: UnseenRunFacts): boolean {
  if (run.status !== 'awaiting_approval') return false;
  if (run.lastViewedAt === null) return true;
  return Date.parse(run.lastViewedAt) < Date.parse(run.updatedAt);
}
