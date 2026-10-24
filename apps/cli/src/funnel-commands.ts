/**
 * `jobagent funnel ...` 子命令组（验证漏斗读口，
 * design-funnel-analytics-20261015 §6）：
 *   funnel summary --since <ISO> [--until <ISO>] [--format json|table]
 *     # 每个 event 的次数、去重会话数（COUNT(DISTINCT session_ref)）、NULL 会话数。
 *   funnel daily --since <ISO> [--until <ISO>] [--format json|table]
 *     # 自然日（UTC 'YYYY-MM-DD'）× event 次数。
 *
 * 运营工具无身份闸（与 usage 命令一致）。窗口口径 since 含、until 不含。
 * 退出码：成功=0；参数错误=2；存储错误=1。
 */

import { parseArgs } from 'node:util';
import {
  FunnelSummaryQuerySchema,
  type FunnelDailyRow,
  type FunnelSummaryQuery,
  type FunnelSummaryRow,
} from '@jobagent/shared';
import type { CliDeps } from './index.js';
import { resolveCliStorage } from './storage-bootstrap.js';

type Format = 'json' | 'table';

/** 解析两个子命令共用的窗口/格式参数；不合法时写好错误并返回 null。 */
function parseWindowArgs(
  rest: string[],
  deps: CliDeps,
): { query: FunnelSummaryQuery; format: Format } | null {
  const logger = deps.logger ?? console;
  const { values } = parseArgs({
    args: rest,
    options: {
      since: { type: 'string' },
      until: { type: 'string' },
      format: { type: 'string' },
    },
  });
  if (!values.since) {
    logger.error('--since <ISO timestamp> is required');
    return null;
  }
  const format = values.format ?? 'table';
  if (format !== 'json' && format !== 'table') {
    logger.error('--format must be one of: json, table (default table)');
    return null;
  }
  const parsed = FunnelSummaryQuerySchema.safeParse({
    sinceIso: values.since,
    ...(values.until !== undefined ? { untilIso: values.until } : {}),
  });
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(query)'}: ${i.message}`)
      .join('; ');
    logger.error(`invalid funnel query: ${issues}`);
    return null;
  }
  return { query: parsed.data, format };
}

function renderSummaryTable(rows: FunnelSummaryRow[]): string {
  const header = 'event\tevents\tdistinctSessions\tnullSessions';
  const lines = rows.map(
    (r) => `${r.event}\t${r.events}\t${r.distinctSessions}\t${r.nullSessions}`,
  );
  return `${header}\n${lines.join('\n')}\n`;
}

function renderDailyTable(rows: FunnelDailyRow[]): string {
  const header = 'day\tevent\tevents';
  const lines = rows.map((r) => `${r.day}\t${r.event}\t${r.events}`);
  return `${header}\n${lines.join('\n')}\n`;
}

async function runSummary(rest: string[], deps: CliDeps): Promise<number> {
  const parsed = parseWindowArgs(rest, deps);
  if (!parsed) return 2;
  const stdout = deps.stdout ?? process.stdout;
  const storage = await resolveCliStorage(deps);
  const rows = await storage.funnelEvents.summarize(parsed.query);
  if (parsed.format === 'json') {
    stdout.write(`${JSON.stringify({ summary: rows }, null, 2)}\n`);
  } else if (rows.length === 0) {
    stdout.write('(no funnel events in window)\n');
  } else {
    stdout.write(renderSummaryTable(rows));
  }
  return 0;
}

async function runDaily(rest: string[], deps: CliDeps): Promise<number> {
  const parsed = parseWindowArgs(rest, deps);
  if (!parsed) return 2;
  const stdout = deps.stdout ?? process.stdout;
  const storage = await resolveCliStorage(deps);
  const rows = await storage.funnelEvents.summarizeDaily(parsed.query);
  if (parsed.format === 'json') {
    stdout.write(`${JSON.stringify({ daily: rows }, null, 2)}\n`);
  } else if (rows.length === 0) {
    stdout.write('(no funnel events in window)\n');
  } else {
    stdout.write(renderDailyTable(rows));
  }
  return 0;
}

/** funnel 子命令入口，返回进程退出码。 */
export async function runFunnel(rest: string[], deps: CliDeps): Promise<number> {
  const logger = deps.logger ?? console;
  const [sub, ...subRest] = rest;
  try {
    if (sub === 'summary') return await runSummary(subRest, deps);
    if (sub === 'daily') return await runDaily(subRest, deps);
    logger.error(
      'Usage: jobagent funnel summary --since <ISO> [--until <ISO>] [--format json|table] | funnel daily --since <ISO> [--until <ISO>] [--format json|table]',
    );
    return 2;
  } catch (err) {
    logger.error(`funnel ${sub ?? ''} failed: ${(err as Error).message}`);
    return 1;
  }
}
