/**
 * `jobagent auth ...` 子命令组（账号体系运维，账号里程碑 item28-④）：
 *   auth cleanup [--retain-hours 24] [--account-retain-hours 720]
 *     # 删除过期/已撤销超过保留期的 auth_sessions，以及从未认领画像且无有效会话、
 *     # 超过账号保留期的闲置 accounts（生产 cron 调度随部署补，本命令只提供可执行本体）。
 *
 * 与 `demo cleanup` 对称：只做物理清理并打印计数，不触碰 profiles/evidence。
 * 退出码：成功=0；参数错误=2；存储错误=1。
 */

import { parseArgs } from 'node:util';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createStorage, type StorageContext } from '@jobagent/storage';
import type { CliDeps } from './index.js';

/** 会话清理默认保留窗口：过期/撤销后再留 24h（与 demo cleanup 默认一致）。 */
const DEFAULT_SESSION_RETAIN_HOURS = 24;
/** 未认领账号默认保留窗口：30 天，避免删掉刚登录尚未认领的用户。 */
const DEFAULT_ACCOUNT_RETAIN_HOURS = 24 * 30;

async function makeCliStorage(): Promise<StorageContext> {
  const sqlitePath = process.env.DB_PATH ?? 'data/job-agent.db';
  mkdirSync(path.dirname(path.resolve(sqlitePath)), { recursive: true });
  return createStorage({ sqlitePath });
}

async function resolveStorage(deps: CliDeps): Promise<StorageContext> {
  return deps.storage ?? (await makeCliStorage());
}

function parseNonNegativeHours(raw: string | undefined, fallback: number): number | null {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}

async function runCleanup(rest: string[], deps: CliDeps): Promise<number> {
  const logger = deps.logger ?? console;
  const stdout = deps.stdout ?? process.stdout;
  const { values } = parseArgs({
    args: rest,
    options: {
      'retain-hours': { type: 'string' },
      'account-retain-hours': { type: 'string' },
    },
  });

  const sessionRetainHours = parseNonNegativeHours(
    values['retain-hours'],
    DEFAULT_SESSION_RETAIN_HOURS,
  );
  const accountRetainHours = parseNonNegativeHours(
    values['account-retain-hours'],
    DEFAULT_ACCOUNT_RETAIN_HOURS,
  );
  if (sessionRetainHours === null) {
    logger.error('--retain-hours must be a non-negative number');
    return 2;
  }
  if (accountRetainHours === null) {
    logger.error('--account-retain-hours must be a non-negative number');
    return 2;
  }

  const storage = await resolveStorage(deps);
  const now = deps.now?.() ?? new Date().toISOString();
  const sessionRetainMs = Math.round(sessionRetainHours * 60 * 60 * 1000);
  const accountRetainMs = Math.round(accountRetainHours * 60 * 60 * 1000);

  // 先清会话，再清无有效会话的未认领账号（顺序保证 NOT EXISTS 判定反映清理后状态）
  const sessions = await storage.authSessions.purgeExpired(now, sessionRetainMs);
  const accounts = await storage.accounts.deleteUnclaimed(now, accountRetainMs);
  stdout.write(
    `purged ${sessions} expired/revoked auth session(s) (retain ${sessionRetainHours}h) ` +
      `and ${accounts} unclaimed account(s) without a live session (retain ${accountRetainHours}h)\n`,
  );
  return 0;
}

/** auth 子命令入口，返回进程退出码。 */
export async function runAuth(rest: string[], deps: CliDeps): Promise<number> {
  const logger = deps.logger ?? console;
  const [sub, ...subRest] = rest;
  try {
    if (sub === 'cleanup') return await runCleanup(subRest, deps);
    logger.error(
      'Usage: jobagent auth cleanup [--retain-hours 24] [--account-retain-hours 720]',
    );
    return 2;
  } catch (err) {
    logger.error(`auth ${sub ?? ''} failed: ${(err as Error).message}`);
    return 1;
  }
}
