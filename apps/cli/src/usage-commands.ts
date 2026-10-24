/**
 * `jobagent usage ...` 子命令组（决策 #25 ④ 成本回采 Wave D 读侧运营面，
 * design-cost-metering-20261014 §7）：
 *   usage summary --since <ISO> [--until <ISO>] [--account <id>] [--category llm|search|analysis] [--format json|table]
 *     # 按 (category, feature, billing_source) 聚合窗口内用量事件（table 为默认格式）。
 *   usage daily --since <ISO> [--until <ISO>] [--account <id>] [--category llm|search|analysis] [--format json|table]
 *     # 按自然日（UTC 'YYYY-MM-DD'）+ category 聚合的日趋势（不细分 feature/billingSource）。
 *
 * 运营工具无身份闸：--account 省略＝全平台口径。窗口口径 since 含、until 不含。
 * 退出码：成功=0；参数错误=2；存储错误=1。
 */

import { parseArgs } from 'node:util';
import {
  UsageSummaryQuerySchema,
  type UsageDailyRow,
  type UsageSummaryQuery,
  type UsageSummaryRow,
} from '@jobagent/shared';
import type { CliDeps } from './index.js';
import { resolveCliStorage } from './storage-bootstrap.js';

type Format = 'json' | 'table';

/** 解析两个子命令共用的窗口/过滤参数；不合法时写好错误并返回 null。 */
function parseWindowArgs(
  rest: string[],
  deps: CliDeps,
): { query: UsageSummaryQuery; format: Format } | null {
  const logger = deps.logger ?? console;
  const { values } = parseArgs({
    args: rest,
    options: {
      since: { type: 'string' },
      until: { type: 'string' },
      account: { type: 'string' },
      category: { type: 'string' },
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
  const parsed = UsageSummaryQuerySchema.safeParse({
    sinceIso: values.since,
    ...(values.until !== undefined ? { untilIso: values.until } : {}),
    ...(values.account !== undefined ? { accountId: values.account } : {}),
    ...(values.category !== undefined ? { category: values.category } : {}),
  });
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(query)'}: ${i.message}`)
      .join('; ');
    logger.error(`invalid usage query: ${issues}`);
    return null;
  }
  return { query: parsed.data, format };
}

function renderSummaryTable(rows: UsageSummaryRow[]): string {
  const header =
    'category\tfeature\tbillingSource\tevents\tsumPromptTokens\tsumCompletionTokens\tsumQuantity';
  const lines = rows.map(
    (r) =>
      `${r.category}\t${r.feature}\t${r.billingSource}\t${r.events}\t${r.sumPromptTokens}\t${r.sumCompletionTokens}\t${r.sumQuantity}`,
  );
  return `${header}\n${lines.join('\n')}\n`;
}

function renderDailyTable(rows: UsageDailyRow[]): string {
  const header = 'day\tcategory\tevents\tsumPromptTokens\tsumCompletionTokens\tsumQuantity';
  const lines = rows.map(
    (r) =>
      `${r.day}\t${r.category}\t${r.events}\t${r.sumPromptTokens}\t${r.sumCompletionTokens}\t${r.sumQuantity}`,
  );
  return `${header}\n${lines.join('\n')}\n`;
}

async function runSummary(rest: string[], deps: CliDeps): Promise<number> {
  const parsed = parseWindowArgs(rest, deps);
  if (!parsed) return 2;
  const stdout = deps.stdout ?? process.stdout;
  const storage = await resolveCliStorage(deps);
  const rows = await storage.usageEvents.summarize(parsed.query);
  if (parsed.format === 'json') {
    stdout.write(`${JSON.stringify({ summary: rows }, null, 2)}\n`);
  } else if (rows.length === 0) {
    stdout.write('(no usage events in window)\n');
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
  const rows = await storage.usageEvents.summarizeDaily(parsed.query);
  if (parsed.format === 'json') {
    stdout.write(`${JSON.stringify({ daily: rows }, null, 2)}\n`);
  } else if (rows.length === 0) {
    stdout.write('(no usage events in window)\n');
  } else {
    stdout.write(renderDailyTable(rows));
  }
  return 0;
}

/** usage 子命令入口，返回进程退出码。 */
export async function runUsage(rest: string[], deps: CliDeps): Promise<number> {
  const logger = deps.logger ?? console;
  const [sub, ...subRest] = rest;
  try {
    if (sub === 'summary') return await runSummary(subRest, deps);
    if (sub === 'daily') return await runDaily(subRest, deps);
    logger.error(
      'Usage: jobagent usage summary --since <ISO> [--until <ISO>] [--account <id>] [--category llm|search|analysis] [--format json|table] | usage daily --since <ISO> [--until <ISO>] [--account <id>] [--category llm|search|analysis] [--format json|table]',
    );
    return 2;
  } catch (err) {
    logger.error(`usage ${sub ?? ''} failed: ${(err as Error).message}`);
    return 1;
  }
}
