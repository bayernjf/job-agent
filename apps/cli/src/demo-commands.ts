/**
 * `jobagent demo ...` 子命令组（演示模式运维，design-demo-mode-20260915 §11）：
 *   demo seed    [--logins github:a,gitee:b]   # 校验预置示例是否都有 complete 画像（缺省读 DEMO_PRESET_LOGINS）
 *   demo cleanup [--retain-hours 24]            # 删除过期/退出超保留期的演示会话与更早的限流事件（cron 用）
 *
 * seed 为只读就绪检查、不需要 GitHub/Gitee token：真正的画像预热由 `jobagent analyze` 完成，
 * 本命令只报告每个预置账号是否已存在 complete 快照（与 API GET /demo/presets 的 ready 判定一致）。
 *
 * 退出码：成功=0；seed 存在缺失预置=1；参数错误=2；存储错误=1。
 */

import { parseArgs } from 'node:util';
import type { StorageContext } from '@jobagent/storage';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createStorage } from '@jobagent/storage';
import type { CliDeps } from './index.js';

interface PresetLogin {
  platform: 'github' | 'gitee';
  login: string;
}

async function makeCliStorage(): Promise<StorageContext> {
  const sqlitePath = process.env.DB_PATH ?? 'data/job-agent.db';
  mkdirSync(path.dirname(path.resolve(sqlitePath)), { recursive: true });
  return createStorage({ sqlitePath });
}

async function resolveStorage(deps: CliDeps): Promise<StorageContext> {
  return deps.storage ?? (await makeCliStorage());
}

/** 解析 `github:alice,gitee:bob`；非法条目返回 null（调用方报错退出）。缺省回退 DEMO_PRESET_LOGINS。 */
function parsePresetLogins(
  raw: string | undefined,
  logger: Pick<Console, 'error'>,
): PresetLogin[] | null {
  const source = raw ?? process.env.DEMO_PRESET_LOGINS;
  if (!source || source.trim() === '') return [];
  const out: PresetLogin[] = [];
  for (const part of source.split(',')) {
    const token = part.trim();
    if (token === '') continue;
    const sep = token.indexOf(':');
    const platform = sep > 0 ? token.slice(0, sep).trim() : '';
    const login = sep > 0 ? token.slice(sep + 1).trim() : '';
    if ((platform !== 'github' && platform !== 'gitee') || login === '') {
      logger.error(`bad preset entry '${token}' (expected github:login or gitee:login)`);
      return null;
    }
    out.push({ platform, login });
  }
  return out;
}

async function runSeed(rest: string[], deps: CliDeps): Promise<number> {
  const logger = deps.logger ?? console;
  const stdout = deps.stdout ?? process.stdout;
  const { values } = parseArgs({
    args: rest,
    options: { logins: { type: 'string' } },
  });

  const presets = parsePresetLogins(values.logins, logger);
  if (presets === null) return 2;
  if (presets.length === 0) {
    logger.error('no presets: pass --logins github:a,gitee:b or set DEMO_PRESET_LOGINS');
    return 2;
  }

  const storage = await resolveStorage(deps);
  let ready = 0;
  let missing = 0;
  for (const preset of presets) {
    const record = await storage.profiles.latestBySubject(preset.platform, preset.login);
    if (record && record.status === 'complete' && record.snapshot) {
      ready += 1;
      const authenticity = record.snapshot.authenticity.status;
      stdout.write(`ready\t${preset.platform}:${preset.login}\t${record.id}\t${authenticity}\n`);
    } else {
      missing += 1;
      stdout.write(`missing\t${preset.platform}:${preset.login}\n`);
    }
  }
  stdout.write(`seed: ${ready} ready, ${missing} missing\n`);
  if (missing > 0) {
    logger.error('some presets lack a complete profile — warm them with `jobagent analyze <login>` first');
    return 1;
  }
  return 0;
}

async function runCleanup(rest: string[], deps: CliDeps): Promise<number> {
  const logger = deps.logger ?? console;
  const stdout = deps.stdout ?? process.stdout;
  const { values } = parseArgs({
    args: rest,
    options: { 'retain-hours': { type: 'string' } },
  });

  const retainHours = values['retain-hours'] !== undefined ? Number(values['retain-hours']) : 24;
  if (!Number.isFinite(retainHours) || retainHours < 0) {
    logger.error('--retain-hours must be a non-negative number');
    return 2;
  }

  const storage = await resolveStorage(deps);
  const now = deps.now?.() ?? new Date().toISOString();
  const retainMs = Math.round(retainHours * 60 * 60 * 1000);
  const sessions = await storage.demoSessions.purgeExpired(now, retainMs);
  const eventCutoff = new Date(Date.parse(now) - retainMs).toISOString();
  const events = await storage.demoSessions.purgeRateEventsBefore(eventCutoff);
  stdout.write(
    `purged ${sessions} expired/exited demo session(s) and ${events} rate event(s) older than ${retainHours}h\n`,
  );
  return 0;
}

/** demo 子命令入口，返回进程退出码。 */
export async function runDemo(rest: string[], deps: CliDeps): Promise<number> {
  const logger = deps.logger ?? console;
  const [sub, ...subRest] = rest;
  try {
    if (sub === 'seed') return await runSeed(subRest, deps);
    if (sub === 'cleanup') return await runCleanup(subRest, deps);
    logger.error('Usage: jobagent demo seed [--logins github:a,gitee:b] | demo cleanup [--retain-hours 24]');
    return 2;
  } catch (err) {
    logger.error(`demo ${sub ?? ''} failed: ${(err as Error).message}`);
    return 1;
  }
}
