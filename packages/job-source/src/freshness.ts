/**
 * 岗位新鲜度的单一事实源。
 *
 * 逼出这个文件的三条事实：
 * 1. `last_seen_at` 是唯一能证明"这个岗位还被源站列着"的字段——`posted_at` 只说明它
 *    何时发布，一个半年前发布、每轮同步都还见到的岗位仍然在招；
 * 2. 同一套"7 天窗口"算法此前抄了三份（`/job-postings/stats`、CLI `jobs stats`、采集
 *    清扫），改一处就会让"stats 报的 active 数"与"推荐给候选人的岗位集合"悄悄分叉；
 * 3. 把一条早已关闭的岗位推荐给正在投简历的人是真实伤害：他写完求职信才发现岗位没了。
 */

/** 默认新鲜窗口（天）。`JOB_STALE_DAYS` 可覆盖。 */
export const JOB_DEFAULT_STALE_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 解析 `JOB_STALE_DAYS`：非法值、0、负数、小数一律回落到默认。
 * 刻意不承认"0＝不过滤"——那会把窗口静默关掉，正是要防的分叉。
 */
export function parseStaleDays(raw: string | undefined, fallback = JOB_DEFAULT_STALE_DAYS): number {
  if (raw === undefined) return fallback;
  const n = Number(String(raw).trim());
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

/** 新鲜窗口下界（ISO）：`last_seen_at >= 返回值` 才算仍然在招。`now` 可注入。 */
export function staleCutoffIso(staleDays: number, now: Date = new Date()): string {
  return new Date(now.getTime() - staleDays * DAY_MS).toISOString();
}
