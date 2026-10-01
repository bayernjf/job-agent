/**
 * `jobagent removal ...` 子命令组（审计 S3 按主体撤回的运营复核通道，2026-10-01）：
 *   removal list [--status pending] [--limit 50]
 *     # 列出移除申请单（默认 pending，即等待人工复核）。
 *   removal approve --request <id>
 *     # 复核通过：级联删除目标画像（evidence → applications → interviews → 撤销认领 → 删画像），
 *     # 然后把申请单翻为 approved。复核结论不可被后续调用覆盖。
 *   removal reject --request <id>
 *     # 复核驳回：把申请单翻为 rejected，并清除画像的软挂起标记（removal_requested_at），
 *     # 画像恢复公开分发。
 *
 * 申请单只增、只翻终态、不删除（审计流水不可抹）。退出码：成功=0；参数错误=2；
 * 申请不存在=1；已结单=2；存储错误=1。
 */

import { parseArgs } from 'node:util';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createStorage, type StorageContext } from '@jobagent/storage';
import type { RemovalRequestStatus } from '@jobagent/storage';
import type { CliDeps } from './index.js';

async function makeCliStorage(): Promise<StorageContext> {
  const sqlitePath = process.env.DB_PATH ?? 'data/job-agent.db';
  mkdirSync(path.dirname(path.resolve(sqlitePath)), { recursive: true });
  return createStorage({ sqlitePath });
}

async function resolveStorage(deps: CliDeps): Promise<StorageContext> {
  return deps.storage ?? (await makeCliStorage());
}

const VALID_STATUSES: readonly RemovalRequestStatus[] = ['pending', 'approved', 'rejected'];

async function runList(rest: string[], deps: CliDeps): Promise<number> {
  const logger = deps.logger ?? console;
  const stdout = deps.stdout ?? process.stdout;
  const { values } = parseArgs({
    args: rest,
    options: {
      status: { type: 'string' },
      limit: { type: 'string' },
    },
  });
  const status = (values.status as RemovalRequestStatus | undefined) ?? 'pending';
  if (!VALID_STATUSES.includes(status)) {
    logger.error(`--status must be one of: ${VALID_STATUSES.join(', ')}`);
    return 2;
  }
  let limit = 50;
  if (values.limit !== undefined) {
    const parsed = Number(values.limit);
    if (!Number.isInteger(parsed) || parsed < 1) {
      logger.error('--limit must be a positive integer');
      return 2;
    }
    limit = parsed;
  }

  const storage = await resolveStorage(deps);
  const rows = await storage.profileRemovalRequests.listByStatus(status, limit);
  if (rows.length === 0) {
    stdout.write(`(no ${status} removal requests)\n`);
  } else {
    const header = 'requestId\tprofileId\tstatus\tcreatedAt\tdecidedAt\tcontact\treason';
    const lines = rows.map(
      (r) =>
        `${r.id}\t${r.profileId}\t${r.status}\t${r.createdAt}\t${r.decidedAt ?? ''}\t${r.contact ?? ''}\t${(r.reason ?? '').replace(/\s+/g, ' ').slice(0, 80)}`,
    );
    stdout.write(`${header}\n${lines.join('\n')}\n`);
  }
  return 0;
}

async function runApprove(rest: string[], deps: CliDeps): Promise<number> {
  const logger = deps.logger ?? console;
  const stdout = deps.stdout ?? process.stdout;
  const { values } = parseArgs({
    args: rest,
    options: { request: { type: 'string' } },
  });
  const requestId = values.request;
  if (!requestId) {
    logger.error('--request <id> is required');
    return 2;
  }

  const storage = await resolveStorage(deps);
  const now = deps.now?.() ?? new Date().toISOString();
  const request = await storage.profileRemovalRequests.getById(requestId);
  if (!request) {
    logger.error(`removal request not found: ${requestId}`);
    return 1;
  }
  if (request.decidedAt !== null) {
    logger.error(`removal request ${requestId} is already decided (${request.status}); no action taken`);
    return 2;
  }

  // 级联删除目标画像（与 DELETE /profiles/:id 口径一致，但按 profileId 撤销认领指针）
  const profile = await storage.profiles.getById(request.profileId);
  if (profile) {
    await storage.evidence.deleteByProfile(profile.id);
    await storage.applications.deleteByProfile(profile.id);
    await storage.interviews.deleteByProfile(profile.id);
    await storage.accounts.clearClaimedProfileByProfileId(profile.id);
    await storage.profiles.deleteById(profile.id);
  }
  // 翻终态（幂等：已结单不会改写，这里 request.decidedAt 刚校验为 null）
  await storage.profileRemovalRequests.decide(requestId, 'approved', now);

  if (profile) {
    stdout.write(
      `approved ${requestId}: cascade-deleted profile ${request.profileId} (evidence+applications+interviews+claim cleared) and marked request approved\n`,
    );
  } else {
    stdout.write(
      `approved ${requestId}: target profile ${request.profileId} was already absent; request marked approved\n`,
    );
  }
  return 0;
}

async function runReject(rest: string[], deps: CliDeps): Promise<number> {
  const logger = deps.logger ?? console;
  const stdout = deps.stdout ?? process.stdout;
  const { values } = parseArgs({
    args: rest,
    options: { request: { type: 'string' } },
  });
  const requestId = values.request;
  if (!requestId) {
    logger.error('--request <id> is required');
    return 2;
  }

  const storage = await resolveStorage(deps);
  const now = deps.now?.() ?? new Date().toISOString();
  const request = await storage.profileRemovalRequests.getById(requestId);
  if (!request) {
    logger.error(`removal request not found: ${requestId}`);
    return 1;
  }
  if (request.decidedAt !== null) {
    logger.error(`removal request ${requestId} is already decided (${request.status}); no action taken`);
    return 2;
  }

  // 驳回：清除软挂起标记，画像恢复公开分发
  const profile = await storage.profiles.getById(request.profileId);
  if (profile?.removalRequestedAt) {
    await storage.profiles.setRemovalRequestedAt(request.profileId, null);
  }
  await storage.profileRemovalRequests.decide(requestId, 'rejected', now);
  stdout.write(
    `rejected ${requestId}: cleared soft-hold on profile ${request.profileId} (if any) and marked request rejected\n`,
  );
  return 0;
}

/** removal 子命令入口，返回进程退出码。 */
export async function runRemoval(rest: string[], deps: CliDeps): Promise<number> {
  const logger = deps.logger ?? console;
  const [sub, ...subRest] = rest;
  try {
    if (sub === 'list') return await runList(subRest, deps);
    if (sub === 'approve') return await runApprove(subRest, deps);
    if (sub === 'reject') return await runReject(subRest, deps);
    logger.error(
      'Usage: jobagent removal list [--status pending|approved|rejected] [--limit N] | removal approve --request <id> | removal reject --request <id>',
    );
    return 2;
  } catch (err) {
    logger.error(`removal ${sub ?? ''} failed: ${(err as Error).message}`);
    return 1;
  }
}
