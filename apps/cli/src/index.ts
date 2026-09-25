/**
 * jobagent CLI（M1·W2）：命令行对真实 GitHub 账号出能力画像，不起 Web。
 * 供决策 #8 的 20–50 账号去风险实验：批量导出 JSONL。
 *
 * 用法：
 *   jobagent analyze <user> [--out <file>] [--format json|markdown|html] [--platform github|gitee|all]  # 单账号画像；all=GitHub+Gitee 去重融合
 *   jobagent batch <file> [--out <file>]        # 每行一个用户名 → JSONL
 *   jobagent waitlist [--status <s>] [--limit <n>] [--count]  # 只读查看落地页留资（MVP 无认证、不暴露 admin HTTP）
 *   jobagent resume build --profile <id|file> --job <jobId>    # 单个岗位定向简历（md/html/json，见 resume-commands）
 *   jobagent resume batch --profile <id|file> [--jobs id1,id2 | --limit 5]  # 多岗位批量简历（md/html，写 --out-dir）
 *
 * 凭证：环境变量 GITHUB_TOKEN（本地 PAT，见 .env.example；绝不下发前端/不入 Git）。
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { analyze, fuseInputs, type AnalyzerInput, type FusionReport } from '@jobagent/analyzer-core';
import { GitHubSource, type GitHubCollectedData } from '@jobagent/github-source';
import { GiteeSource, type GiteeCollectedData } from '@jobagent/gitee-source';
import type { SupportedPlatform } from '@jobagent/shared';
import { createStorage, WAITLIST_STATUSES } from '@jobagent/storage';
import type { StorageContext, WaitlistStatus } from '@jobagent/storage';
import { toHtml, toMarkdown } from './report-format.js';
import type { JobSourceAdapter } from '@jobagent/job-source';
import { runJobs } from './jobs-commands.js';
import { runDemo } from './demo-commands.js';
import { runAuth } from './auth-commands.js';
import { runProfiles } from './profiles-commands.js';
import { runResume } from './resume-commands.js';

export interface CliDeps {
  /** 环境变量 GITHUB_TOKEN 的值（由调用方注入，便于测试） */
  token?: string;
  /** 环境变量 GITEE_TOKEN（可选；Gitee 匿名也可读公开数据，token 仅用于提额） */
  giteeToken?: string;
  /** 采集器注入点（测试用 fake；生产默认 new GitHubSource） */
  source?: { collect(login: string): Promise<GitHubCollectedData | GiteeCollectedData> };
  /** 分平台采集器注入点（--platform all 双源融合测试用；优先于 source） */
  sources?: Partial<
    Record<SupportedPlatform, { collect(login: string): Promise<GitHubCollectedData | GiteeCollectedData> }>
  >;
  /** 持久化上下文注入点（waitlist 子命令用；测试注入临时库，生产默认 createStorage()） */
  storage?: StorageContext;
  /** Test injection for `jobs sync` (defaults to createDefaultAdapters) */
  jobAdapters?: JobSourceAdapter[];
  logger?: Pick<Console, 'error' | 'warn' | 'info' | 'log'>;
  /** 注入"现在"（测试确定性）；默认 new Date().toISOString() */
  now?: () => string;
  /** 注入 stdout（测试捕获）；默认 process.stdout */
  stdout?: { write(chunk: string): unknown };
}

export interface AnalyzeResult {
  profile: ReturnType<typeof analyze>;
  meta: (GitHubCollectedData['meta'] | GiteeCollectedData['meta']) & { fusion?: FusionReport };
}

function makeSource(
  deps: CliDeps,
  platform: SupportedPlatform,
): { collect(login: string): Promise<GitHubCollectedData | GiteeCollectedData> } {
  const injected = deps.sources?.[platform];
  if (injected) return injected;
  if (deps.source) return deps.source;
  if (platform === 'gitee') {
    // Gitee 匿名即可读公开数据，token 仅用于提额，因此不强制
    return new GiteeSource({ token: deps.giteeToken, log: deps.logger ?? console });
  }
  const token = deps.token;
  if (!token) {
    throw new CliError(
      'GITHUB_TOKEN is not set. Create a fine-grained PAT (public repo read-only) and put it in the environment or .env (see .env.example).',
      1,
    );
  }
  return new GitHubSource({ token, log: deps.logger ?? console });
}

/** waitlist 子命令的持久化上下文（测试注入；生产默认 SQLite data/job-agent.db） */
async function makeStorage(deps: CliDeps): Promise<StorageContext> {
  if (deps.storage) return deps.storage;
  const sqlitePath = process.env.DB_PATH ?? 'data/job-agent.db';
  mkdirSync(path.dirname(path.resolve(sqlitePath)), { recursive: true });
  return createStorage({ sqlitePath }); // 非只读 autoMigrate=true
}

class CliError extends Error {
  constructor(message: string, readonly exitCode: number) {
    super(message);
    this.name = 'CliError';
  }
}

export async function analyzeLogin(
  login: string,
  deps: CliDeps,
  platform: SupportedPlatform | 'all' = 'github',
): Promise<AnalyzeResult> {
  if (platform === 'all') {
    // B-5 最小双源融合：分别采集 GitHub/Gitee，去重镜像后由同一内核分析（在线多源融合仍缓做）
    const gh = await makeSource(deps, 'github').collect(login);
    const ge = await makeSource(deps, 'gitee').collect(login);
    const fused = fuseInputs(gh.input as AnalyzerInput, ge.input as AnalyzerInput, {
      primary: 'github',
      secondary: 'gitee',
    });
    const fusedProfile = analyze(fused.input, {
      profileId: randomUUID(),
      claimed: false,
      platform: 'github',
      fusion: fused.report,
    });
    return { profile: fusedProfile, meta: { ...gh.meta, fusion: fused.report } };
  }
  const source = makeSource(deps, platform);
  const collected = await source.collect(login);
  const profile = analyze(collected.input as AnalyzerInput, {
    profileId: randomUUID(),
    claimed: false,
    platform,
  });
  return { profile, meta: collected.meta };
}

/** 解析 --platform；缺省 github，非法值返回 undefined 由调用方报错退出 */
function parsePlatform(value: string | undefined): SupportedPlatform | 'all' | undefined {
  if (value === undefined) return 'github';
  return value === 'github' || value === 'gitee' || value === 'all' ? value : undefined;
}

function readBatchFile(file: string): string[] {
  const content = readFileSync(file, 'utf8');
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

function writeOutput(
  outFile: string | undefined,
  content: string,
  logger: Pick<Console, 'log'>,
  stdout: { write(chunk: string): unknown },
): void {
  if (outFile) {
    mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
    writeFileSync(outFile, content, 'utf8');
    logger.log(`Wrote ${outFile}`);
  } else {
    stdout.write(content);
  }
}

function renderProfile(result: AnalyzeResult, format: string): string {
  const p = result.profile;
  if (format === 'markdown' || format === 'md') return toMarkdown(p);
  if (format === 'html') return toHtml(p);
  return JSON.stringify(result, null, 2);
}

export async function run(argv: string[], deps: CliDeps): Promise<number> {
  const logger = deps.logger ?? console;
  const stdout = deps.stdout ?? process.stdout;
  const [command, ...rest] = argv;

  if (command === 'analyze') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        out: { type: 'string', short: 'o' },
        platform: { type: 'string' },
        format: { type: 'string' },
      },
    });
    const login = positionals[0];
    const platform = parsePlatform(values.platform);
    if (!platform) {
      logger.error('--platform must be one of: github, gitee, all (default github; all = fused GitHub+Gitee, analyze only)');
      return 2;
    }
    const format = values.format ?? 'json';
    if (!['json', 'markdown', 'md', 'html'].includes(format)) {
      logger.error('--format must be one of: json, markdown, html (default json)');
      return 2;
    }
    if (!login) {
      logger.error('Usage: jobagent analyze <user> [--out <file>] [--format json|markdown|html] [--platform github|gitee|all]');
      return 2;
    }
    try {
      const result = await analyzeLogin(login, deps, platform);
      writeOutput(values.out, renderProfile(result, format), logger, stdout);
      return 0;
    } catch (err) {
      logger.error(`analyze failed for ${login}: ${(err as Error).message}`);
      return 1;
    }
  }

  if (command === 'batch') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { out: { type: 'string', short: 'o' }, platform: { type: 'string' } },
    });
    const file = positionals[0];
    if (!file) {
      logger.error('Usage: jobagent batch <file> [--out <file>] [--platform github|gitee]   # file: one username per line');
      return 2;
    }
    let logins: string[];
    try {
      logins = readBatchFile(file);
    } catch (err) {
      logger.error(`cannot read batch file: ${(err as Error).message}`);
      return 1;
    }
    if (logins.length === 0) {
      logger.error('batch file is empty (one username per line, # for comments)');
      return 1;
    }
    const platform = parsePlatform(values.platform);
    if (!platform) {
      logger.error('--platform must be one of: github, gitee, all (default github; all = fused GitHub+Gitee, analyze only)');
      return 2;
    }
    if (platform === 'all') {
      logger.error('batch does not support --platform all; run analyze <user> --platform all for a fused profile');
      return 2;
    }
    const lines: string[] = [];
    let failed = 0;
    for (const login of logins) {
      try {
        const result = await analyzeLogin(login, deps, platform);
        lines.push(JSON.stringify(result));
        logger.log(`ok ${login}`);
      } catch (err) {
        failed += 1;
        logger.error(`failed ${login}: ${(err as Error).message}`);
        lines.push(JSON.stringify({ login, error: (err as Error).message }));
      }
    }
    const content = `${lines.join('\n')}\n`;
    writeOutput(values.out, content, logger, stdout);
    logger.log(`batch done: ${logins.length} total, ${failed} failed`);
    return failed > 0 ? 1 : 0;
  }

  if (command === 'waitlist') {
    const { values } = parseArgs({
      args: rest,
      options: {
        status: { type: 'string' },
        limit: { type: 'string' },
        count: { type: 'boolean' },
      },
    });
    if (values.status !== undefined && !WAITLIST_STATUSES.includes(values.status as WaitlistStatus)) {
      logger.error(
        `unknown waitlist status '${values.status}' (expected one of: ${WAITLIST_STATUSES.join(', ')})`,
      );
      return 2;
    }
    let limit: number | undefined;
    if (values.limit !== undefined) {
      limit = Number(values.limit);
      if (!Number.isInteger(limit) || limit < 1) {
        logger.error('--limit must be a positive integer');
        return 2;
      }
    }
    try {
      const storage = await makeStorage(deps);
      if (values.count || values.status === undefined) {
        // 默认/--count：按状态计数
        const counts = await storage.waitlist.countByStatus();
        const total = WAITLIST_STATUSES.reduce((sum, s) => sum + (counts[s] ?? 0), 0);
        const rows = WAITLIST_STATUSES.map((s) => `${s.padEnd(10)} ${counts[s] ?? 0}`);
        stdout.write(`${rows.join('\n')}\n${'total'.padEnd(10)} ${total}\n`);
      } else {
        const rows = await storage.waitlist.listByStatus(values.status as WaitlistStatus, limit);
        if (rows.length === 0) {
          stdout.write(`(no ${values.status} entries)\n`);
        } else {
          const lines = rows.map(
            (r) => `${r.email}\t${r.status}\t${r.githubUsername ?? ''}\t${r.createdAt}`,
          );
          stdout.write(`${lines.join('\n')}\n`);
        }
      }
      return 0;
    } catch (err) {
      logger.error(`waitlist failed: ${(err as Error).message}`);
      return 1;
    }
  }

  if (command === 'jobs') {
    return runJobs(rest, deps);
  }

  if (command === 'demo') {
    return runDemo(rest, deps);
  }

  if (command === 'auth') {
    return runAuth(rest, deps);
  }

  if (command === 'resume') {
    return runResume(rest, deps);
  }

  if (command === 'profiles') {
    return runProfiles(rest, deps);
  }

  logger.error(
    'Usage: jobagent analyze <user> [--out <file>] [--format json|markdown|html] | batch <file> [--out <file>] | waitlist [--status <s>] [--limit <n>] [--count] | jobs <sync|search|stats|match> | demo <seed|cleanup> | auth cleanup | resume build ... | resume batch ... | profiles delete --profile <id>',
  );
  return 2;
}

async function main(): Promise<void> {
  const code = await run(process.argv.slice(2), {
    token: process.env.GITHUB_TOKEN,
    giteeToken: process.env.GITEE_TOKEN,
  });
  process.exitCode = code;
}

main().catch((err) => {
  console.error(`jobagent: ${(err as Error).message}`);
  process.exitCode = 1;
});
