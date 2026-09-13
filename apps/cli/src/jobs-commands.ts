/**
 * `jobagent jobs ...` 子命令组（P2 职位聚合）：
 *   jobs sync   [--source=a,b] [--dry-run] [--stale-days=7]  # 抓取→清洗→去重→入库
 *   jobs search [--keyword k] [--remote] [--source=a,b] [--limit n] [--json]
 *   jobs stats                                              # 按源统计 active/inactive
 *   jobs match --skills=a,b [--remote] [--salary-min n] [--keyword k] [--json]  # 画像技能匹配排序
 *
 * 退出码：所有源失败=1；部分源失败=0（stderr 告警）；成功=0。
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { JobSource } from '@jobagent/shared';
import { createStorage, type StorageContext } from '@jobagent/storage';
import {
  createDefaultAdapters,
  createJobHttpClient,
  syncOnce,
  matchJobs,
  type JobHttpOptions,
} from '@jobagent/job-source';
import type { JobSourceAdapter } from '@jobagent/job-source';
import type { CliDeps } from './index.js';

// hn_whoishiring 为月度源：默认 sync 不含它，需 --source hn_whoishiring 显式触发（每月一次）
const ENABLED_SOURCES: JobSource[] = [
  'remoteok',
  'remotive',
  'greenhouse',
  'lever',
  'hn_whoishiring',
];

function makeCliStorage(): Promise<StorageContext> | StorageContext {
  const sqlitePath = process.env.DB_PATH ?? 'data/job-agent.db';
  mkdirSync(path.dirname(path.resolve(sqlitePath)), { recursive: true });
  return createStorage({ sqlitePath });
}

async function resolveStorage(deps: CliDeps): Promise<StorageContext> {
  return deps.storage ?? (await makeCliStorage());
}

function parseSources(raw: string | undefined, logger: Pick<Console, 'error'>): JobSource[] | null {
  if (!raw) return undefined as unknown as JobSource[];
  const picked = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0) as JobSource[];
  const bad = picked.filter((s) => !ENABLED_SOURCES.includes(s));
  if (bad.length > 0) {
    logger.error(`unknown source(s): ${bad.join(', ')} (expected one of: ${ENABLED_SOURCES.join(', ')})`);
    return null;
  }
  return picked;
}

/**
 * 解析出站代理：优先 JOB_HTTP_PROXY（本项目专用），再回退标准 HTTPS_PROXY/HTTP_PROXY（兼容大小写）。
 * Node 全局 fetch 不读这些变量，必须显式传给 createJobHttpClient 才生效。
 */
function resolveProxyFromEnv(): string | undefined {
  const raw =
    process.env.JOB_HTTP_PROXY ??
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.HTTP_PROXY ??
    process.env.http_proxy;
  const proxy = raw?.trim();
  return proxy ? proxy : undefined;
}

function httpOptionsFromEnv(): JobHttpOptions {
  const timeoutMs = process.env.JOB_HTTP_TIMEOUT_MS ? Number(process.env.JOB_HTTP_TIMEOUT_MS) : undefined;
  const retries = process.env.JOB_HTTP_RETRIES ? Number(process.env.JOB_HTTP_RETRIES) : undefined;
  const proxy = resolveProxyFromEnv();
  return {
    ...(timeoutMs && Number.isFinite(timeoutMs) ? { timeoutMs } : {}),
    ...(retries != null && Number.isFinite(retries) ? { retries } : {}),
    ...(proxy ? { proxy } : {}),
  };
}

async function runSync(rest: string[], deps: CliDeps): Promise<number> {
  const logger = deps.logger ?? console;
  const stdout = deps.stdout ?? process.stdout;
  const { values } = parseArgs({
    args: rest,
    options: {
      source: { type: 'string' },
      'dry-run': { type: 'boolean' },
      'stale-days': { type: 'string' },
    },
  });

  // 命令行 --source 优先，其次环境变量 JOB_SYNC_SOURCES
  const sources = parseSources(values.source ?? process.env.JOB_SYNC_SOURCES, logger);
  if (sources === null) return 2;

  let staleDays = process.env.JOB_STALE_DAYS ? Number(process.env.JOB_STALE_DAYS) : 7;
  if (values['stale-days'] !== undefined) {
    staleDays = Number(values['stale-days']);
  }
  if (!Number.isInteger(staleDays) || staleDays < 0) {
    logger.error('--stale-days (or JOB_STALE_DAYS) must be a non-negative integer');
    return 2;
  }

  const storage = await resolveStorage(deps);
  const adapters: JobSourceAdapter[] =
    deps.jobAdapters ?? createDefaultAdapters({ sources: sources ?? undefined, logger });
  const http = createJobHttpClient({ ...httpOptionsFromEnv(), logger });
  const now = deps.now ? () => new Date(deps.now!()) : undefined;

  const result = await syncOnce({
    adapters,
    repo: storage.jobPostings,
    http,
    staleDays,
    dryRun: Boolean(values['dry-run']),
    now,
    logger,
  });

  const header = ['source', 'fetched', 'inserted', 'updated', 'unchanged', 'invalid', 'error'].join('\t');
  const lines = result.outcomes.map((o) =>
    [o.source, o.fetched, o.inserted, o.updated, o.unchanged, o.invalid, o.error ?? ''].join('\t'),
  );
  stdout.write(`${header}\n${lines.join('\n')}\n`);
  stdout.write(
    `finished in ${result.finishedAt} markedStale=${result.markedStale}${values['dry-run'] ? ' (dry-run)' : ''}\n`,
  );

  const failed = result.outcomes.filter((o) => o.error);
  if (!result.ok) {
    logger.error('all sources failed or returned nothing');
    return 1;
  }
  if (failed.length > 0) {
    logger.warn(`partial failure: ${failed.map((o) => o.source).join(', ')}`);
  }
  return 0;
}

async function runSearch(rest: string[], deps: CliDeps): Promise<number> {
  const logger = deps.logger ?? console;
  const stdout = deps.stdout ?? process.stdout;
  const { values } = parseArgs({
    args: rest,
    options: {
      keyword: { type: 'string', short: 'k' },
      remote: { type: 'boolean' },
      source: { type: 'string' },
      limit: { type: 'string' },
      json: { type: 'boolean' },
    },
  });

  const sources = parseSources(values.source, logger);
  if (sources === null) return 2;
  let limit: number | undefined;
  if (values.limit !== undefined) {
    limit = Number(values.limit);
    if (!Number.isInteger(limit) || limit < 1) {
      logger.error('--limit must be a positive integer');
      return 2;
    }
  }

  const storage = await resolveStorage(deps);
  const rows = await storage.jobPostings.search({
    keyword: values.keyword,
    remote: values.remote ? true : undefined,
    sources: sources ?? undefined,
    limit,
  });

  if (values.json) {
    stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return 0;
  }
  if (rows.length === 0) {
    stdout.write('(no matching job postings)\n');
    return 0;
  }
  const lines = rows.map(
    (r) =>
      `${r.source}\t${r.postedAt}\t${r.title} @ ${r.company}\t${r.location ?? (r.remote ? 'Remote' : '-')}\t${r.sourceUrl}`,
  );
  stdout.write(`${lines.join('\n')}\n(${rows.length} results)\n`);
  return 0;
}

async function runStats(_rest: string[], deps: CliDeps): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const storage = await resolveStorage(deps);
  const active = await storage.jobPostings.countBySource('active');
  const inactive = await storage.jobPostings.countBySource('inactive');
  const sources = Array.from(new Set([...Object.keys(active), ...Object.keys(inactive)])).sort();
  if (sources.length === 0) {
    stdout.write('(no job postings yet; run `jobagent jobs sync` first)\n');
    return 0;
  }
  const lines = sources.map((s) => `${s}\tactive=${active[s] ?? 0}\tinactive=${inactive[s] ?? 0}`);
  const totalActive = Object.values(active).reduce((a, b) => a + b, 0);
  const totalInactive = Object.values(inactive).reduce((a, b) => a + b, 0);
  stdout.write(`${lines.join('\n')}\ntotal\tactive=${totalActive}\tinactive=${totalInactive}\n`);
  return 0;
}

/**
 * jobs match：按画像技能对在招岗位打分排序（P2-D 消费侧）。
 * 先用结构化条件取候选池，再用 matchJobs 纯函数按 title/tags/description 命中加权。
 */
async function runMatch(rest: string[], deps: CliDeps): Promise<number> {
  const logger = deps.logger ?? console;
  const stdout = deps.stdout ?? process.stdout;
  const { values } = parseArgs({
    args: rest,
    options: {
      skills: { type: 'string' }, // 逗号分隔，必填（来自能力画像 skillTags.name）
      keyword: { type: 'string', short: 'k' },
      remote: { type: 'boolean' },
      source: { type: 'string' },
      'salary-min': { type: 'string' },
      'candidate-limit': { type: 'string' },
      limit: { type: 'string' },
      json: { type: 'boolean' },
    },
  });

  const skills = (values.skills ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (skills.length === 0) {
    logger.error('--skills=a,b is required (comma-separated skill names)');
    return 2;
  }
  const sources = parseSources(values.source, logger);
  if (sources === null) return 2;

  let salaryMinUsd: number | undefined;
  if (values['salary-min'] !== undefined) {
    salaryMinUsd = Number(values['salary-min']);
    if (!Number.isInteger(salaryMinUsd) || salaryMinUsd < 0) {
      logger.error('--salary-min must be a non-negative integer');
      return 2;
    }
  }
  const parsePositive = (raw: string | undefined, flag: string): number | undefined | 2 => {
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) {
      logger.error(`${flag} must be a positive integer`);
      return 2;
    }
    return n;
  };
  const candidateLimit = parsePositive(values['candidate-limit'], '--candidate-limit');
  if (candidateLimit === 2) return 2;
  const limit = parsePositive(values.limit, '--limit');
  if (limit === 2) return 2;

  const storage = await resolveStorage(deps);
  const candidates = await storage.jobPostings.search({
    keyword: values.keyword,
    sources: sources ?? undefined,
    remote: values.remote ? true : undefined,
    salaryMinUsd,
    limit: candidateLimit ?? 500,
    orderBy: 'posted_desc',
  });
  const matches = matchJobs(candidates, {
    skills,
    remote: values.remote ? true : undefined,
    salaryMinUsd,
    sources: sources ?? undefined,
    limit: limit ?? 20,
  });

  if (values.json) {
    stdout.write(`${JSON.stringify(matches, null, 2)}\n`);
    return 0;
  }
  if (matches.length === 0) {
    stdout.write('(no postings match the given skills)\n');
    return 0;
  }
  const lines = matches.map(
    (m) =>
      `${m.score}\t${m.posting.source}\t${m.posting.title} @ ${m.posting.company}\t[${m.matchedSkills.join(',')}]\t${m.posting.sourceUrl}`,
  );
  stdout.write(`${lines.join('\n')}\n(${matches.length} matches)\n`);
  return 0;
}

/** jobs 子命令入口，返回进程退出码。 */
export async function runJobs(rest: string[], deps: CliDeps): Promise<number> {
  const [sub, ...subRest] = rest;
  try {
    if (sub === 'sync') return await runSync(subRest, deps);
    if (sub === 'search') return await runSearch(subRest, deps);
    if (sub === 'stats') return await runStats(subRest, deps);
    if (sub === 'match') return await runMatch(subRest, deps);
    (deps.logger ?? console).error('Usage: jobagent jobs <sync|search|stats|match>  (see each subcommand --help in docs)');
    return 2;
  } catch (err) {
    (deps.logger ?? console).error(`jobs ${sub ?? ''} failed: ${(err as Error).message}`);
    return 1;
  }
}
