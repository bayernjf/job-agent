/**
 * `jobagent profiles ...` 子命令组（T26 删除与解绑最小版，评审 P0-4）：
 *   profiles delete --profile <profileId>
 *     # 物理删除画像与全部证据，撤掉分享链（报告页/API 随即取不到内容）。
 *     # 只做删除与计数，不触碰 accounts/auth_sessions/applications（历史记录保留）。
 *
 * 退出码：成功=0；参数错误=2；画像不存在=1；存储错误=1。
 */

import { parseArgs } from 'node:util';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createStorage, type StorageContext } from '@jobagent/storage';
import type { CliDeps } from './index.js';

async function makeCliStorage(): Promise<StorageContext> {
  const sqlitePath = process.env.DB_PATH ?? 'data/job-agent.db';
  mkdirSync(path.dirname(path.resolve(sqlitePath)), { recursive: true });
  return createStorage({ sqlitePath });
}

async function resolveStorage(deps: CliDeps): Promise<StorageContext> {
  return deps.storage ?? (await makeCliStorage());
}

async function runDelete(rest: string[], deps: CliDeps): Promise<number> {
  const logger = deps.logger ?? console;
  const stdout = deps.stdout ?? process.stdout;
  const { values } = parseArgs({
    args: rest,
    options: { profile: { type: 'string' } },
  });
  const profileId = values.profile;
  if (!profileId) {
    logger.error('--profile <profileId> is required');
    return 2;
  }

  const storage = await resolveStorage(deps);
  const existed = await storage.profiles.deleteById(profileId);
  if (!existed) {
    logger.error(`profile not found: ${profileId}`);
    return 1;
  }
  // 证据随画像一起物理删除（T25 已提供 deleteByProfile）；分享链指向 /report/<id>，删除后自然 404。
  await storage.evidence.deleteByProfile(profileId);
  stdout.write(
    `deleted profile ${profileId} and its evidence; its share links now return not-found\n`,
  );
  return 0;
}

/** profiles 子命令入口，返回进程退出码。 */
export async function runProfiles(rest: string[], deps: CliDeps): Promise<number> {
  const logger = deps.logger ?? console;
  const [sub, ...subRest] = rest;
  try {
    if (sub === 'delete') return await runDelete(subRest, deps);
    logger.error('Usage: jobagent profiles delete --profile <profileId>');
    return 2;
  } catch (err) {
    logger.error(`profiles ${sub ?? ''} failed: ${(err as Error).message}`);
    return 1;
  }
}
