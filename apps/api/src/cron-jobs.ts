/**
 * 内部定时任务（serverless 部署用，2026-09-20）：
 * Vercel Cron 定时打到 Hono 的 /internal/cron/* 端点，替代常驻 Worker 轮询与宿主 cron。
 *
 * - runProcessJobOnce：认领并处理至多一个 analysis_job（复用 worker 的 claimAndProcessOne，
 *   含 demo 并发闸、失败重试/永久失败判定、僵尸任务回收）。
 * - runMaintenance：demo / auth 数据物理清理，默认保留窗口与 CLI 子命令一致
 *   （demo cleanup / auth cleanup，见 apps/cli/src/*-commands.ts）。
 *
 * 本地 / Docker 常驻部署不经过这里：常驻 Worker 自己轮询，清理走宿主 cron 调 CLI。
 */

import { claimAndProcessOne, type ClaimOneResult } from '@jobagent/worker';
import type {
  IAccountsRepository,
  IAuthSessionsRepository,
  IDemoSessionsRepository,
} from '@jobagent/storage';

/** 僵尸任务回收阈值：running 超过 5 分钟视为被函数超时/实例回收遗留（与常驻 Worker 一致）。 */
const STALE_RUNNING_MS = 5 * 60 * 1000;

/** 会话/限流事件过期后再保留 24h（对齐 CLI demo/auth cleanup 默认 --retain-hours 24）。 */
const SESSION_RETAIN_MS = 24 * 60 * 60 * 1000;
/** 未认领且无有效会话的账号保留 30 天（对齐 CLI auth cleanup 默认 --account-retain-hours 720）。 */
const ACCOUNT_RETAIN_MS = 30 * 24 * 60 * 60 * 1000;

export type MaintenanceTask = 'demo' | 'auth' | 'all';

export interface MaintenanceResult {
  task: MaintenanceTask;
  demoSessions: number;
  demoRateEvents: number;
  authSessions: number;
  unclaimedAccounts: number;
}

export interface MaintenanceRepos {
  demoSessions: Pick<
    IDemoSessionsRepository,
    'purgeExpired' | 'purgeRateEventsBefore'
  >;
  authSessions: Pick<IAuthSessionsRepository, 'purgeExpired'>;
  accounts: Pick<IAccountsRepository, 'deleteUnclaimed'>;
}

/**
 * 触发一次单任务处理（供 GET /internal/cron/process-job 调用）。
 * 凭证读 GITHUB_TOKEN / GITEE_TOKEN；缺失 GitHub token 时 worker 会抛错，由路由返回 500。
 */
export async function runProcessJobOnce(workerId = 'vercel-cron'): Promise<ClaimOneResult> {
  return claimAndProcessOne({
    token: process.env.GITHUB_TOKEN,
    giteeToken: process.env.GITEE_TOKEN,
    workerId,
    reclaimStaleMs: STALE_RUNNING_MS,
  });
}

/**
 * 执行数据清理（供 GET /internal/cron/cleanup?task= 调用）。
 * 只做物理删除并返回计数，绝不触碰 profiles/evidence；语义与 CLI cleanup 子命令一致。
 */
export async function runMaintenance(
  task: MaintenanceTask,
  repos: MaintenanceRepos,
  nowIso = new Date().toISOString(),
): Promise<MaintenanceResult> {
  const result: MaintenanceResult = {
    task,
    demoSessions: 0,
    demoRateEvents: 0,
    authSessions: 0,
    unclaimedAccounts: 0,
  };

  if (task === 'demo' || task === 'all') {
    result.demoSessions = await repos.demoSessions.purgeExpired(nowIso, SESSION_RETAIN_MS);
    const eventCutoff = new Date(Date.parse(nowIso) - SESSION_RETAIN_MS).toISOString();
    result.demoRateEvents = await repos.demoSessions.purgeRateEventsBefore(eventCutoff);
  }

  if (task === 'auth' || task === 'all') {
    // 先清会话，再清无有效会话的未认领账号（顺序保证 NOT EXISTS 判定反映清理后状态）。
    result.authSessions = await repos.authSessions.purgeExpired(nowIso, SESSION_RETAIN_MS);
    result.unclaimedAccounts = await repos.accounts.deleteUnclaimed(nowIso, ACCOUNT_RETAIN_MS);
  }

  return result;
}
