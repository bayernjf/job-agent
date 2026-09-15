/**
 * JobAgent Worker（M1·W3）：消费 analysis_jobs 队列，执行 GitHub 采集 + 能力分析，
 * 写入不可变画像快照，更新任务状态。
 *
 * 架构（技术选型 6.6）：
 * - 单 Worker 轮询/认领，不引入 Redis/MQ
 * - claimNext 原子事务保证只认领最老的一行，attempts<3 防无限重试
 * - 失败可重试（resetToQueued），超过 3 次标记 failed
 * - 采集→分析→写库全链路，任一层失败显式标注，禁止输出"看似完整"的报告
 * - 仓储统一 async、经 createStorage 选择方言，业务代码不感知 SQLite/Postgres
 *
 * 用法：
 *   pnpm --filter @jobagent/worker start
 *
 * 环境变量：
 *   GITHUB_TOKEN   — GitHub PAT（必填，public repo read-only 即可）
 *   DB_DRIVER      — sqlite（默认）| postgres
 *   DB_PATH        — SQLite 数据库路径（默认 data/job-agent.db）
 *   DATABASE_URL   — Postgres 连接串（DB_DRIVER=postgres 时）
 *   WORKER_ID      — Worker 标识（默认 worker-<随机8位>）
 *   POLL_INTERVAL_MS — 轮询间隔毫秒（默认 5000）
 *   MAX_RETRIES    — 最大重试次数（默认 3）
 *   DEMO_MAX_CONCURRENT — 同时处理的演示任务上限（默认 1；正式任务不限、永远优先）
 *   DEMO_BACKOFF_MS     — 演示任务被并发闸退回后的退避毫秒（默认 15000）
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze, type AnalyzerInput } from '@jobagent/analyzer-core';
import { GiteeSource, type GiteeCollectedData } from '@jobagent/gitee-source';
import { GitHubSource, type GitHubCollectedData } from '@jobagent/github-source';
import type { AbilityProfile } from '@jobagent/shared';
import {
  createStorage,
  type IAnalysisJobsRepository,
  type IProfilesRepository,
  type StoredAnalysisJob,
} from '@jobagent/storage';

// ─── 类型 ───────────────────────────────────────────────────────────────

export interface WorkerRepos {
  jobs: IAnalysisJobsRepository;
  profiles: IProfilesRepository;
}

/** 统一证据源接口：GitHubSource 与 GiteeSource 均满足此形态 */
export interface EvidenceSource {
  collect(login: string): Promise<GitHubCollectedData | GiteeCollectedData>;
}

export type SourceMap = Record<'github' | 'gitee', EvidenceSource>;

export interface WorkerDeps {
  /** 注入证据源 map（测试用 fake；生产默认 makeSources 创建） */
  sources?: SourceMap;
  /** 注入仓储（测试用内存库；生产默认 createStorage） */
  repos?: WorkerRepos;
  /** 注入 GITHUB_TOKEN（生产从环境变量读） */
  token?: string;
  /** 注入 GITEE_TOKEN（生产从环境变量读；Gitee 匿名可读，可为空） */
  giteeToken?: string;
  /** Worker 标识（默认随机） */
  workerId?: string;
  /** 轮询间隔毫秒（默认 5000） */
  pollIntervalMs?: number;
  /** 最大重试次数（默认 3） */
  maxRetries?: number;
  /** 同时处理的演示任务上限（默认 1；正式任务不限且永远优先认领） */
  demoMaxConcurrent?: number;
  /** 演示任务被并发闸退回后的退避毫秒（默认 15000） */
  demoBackoffMs?: number;
  /** 日志注入（默认 console） */
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
  /** 注入 sleep（测试用） */
  sleep?: (ms: number) => Promise<void>;
  /** 注入"是否继续运行"（测试用；默认一直运行直到 SIGINT/SIGTERM） */
  shouldContinue?: () => boolean;
}

export interface ProcessJobResult {
  profileId: string;
  profile: AbilityProfile;
  budgetUsed: GitHubCollectedData['meta']['budgetUsed'] | GiteeCollectedData['meta']['budgetUsed'];
  missing: string[];
}

function makeSources(deps: WorkerDeps): SourceMap {
  if (deps.sources) return deps.sources;
  const githubToken = deps.token ?? process.env.GITHUB_TOKEN;
  const giteeToken = deps.giteeToken ?? process.env.GITEE_TOKEN;
  if (!githubToken) {
    throw new Error(
      'GITHUB_TOKEN is not set. Create a fine-grained PAT (public repo read-only) and put it in the environment.',
    );
  }
  const logger = deps.logger ?? console;
  return {
    github: new GitHubSource({ token: githubToken, log: logger }),
    gitee: new GiteeSource({ token: giteeToken, log: logger }),
  };
}

// ─── 核心逻辑 ───────────────────────────────────────────────────────────

/**
 * 处理单个分析任务：采集 → 分析 → 写画像 → 标记成功。
 * 纯逻辑（无轮询/无循环），便于对固定夹具做单测。
 * 抛出异常时由调用方决定重试或标记失败。
 */
export async function processJob(
  job: StoredAnalysisJob,
  repos: WorkerRepos,
  sources: SourceMap,
  logger: Pick<Console, 'info' | 'warn' | 'error'> = console,
): Promise<ProcessJobResult> {
  const login = job.subjectLogin;
  const platform = (job.subjectPlatform as 'github' | 'gitee') ?? 'github';
  const source = sources[platform];
  logger.info(`[worker] job ${job.id} start: collect ${login} (platform=${platform}, attempt ${job.attempts})`);

  // 1. 采集（L0 + L1）
  const collected = await source.collect(login);
  logger.info(
    `[worker] job ${job.id} collected: ${collected.input.repos.length} repos, ` +
      `${collected.input.commits.length} commits, ${collected.input.pullRequests.length} PRs, ` +
      `missing=${collected.meta.missing.length}`,
  );

  // 2. 更新进度阶段
  await repos.jobs.updateStage(job.id, 'L1');

  // 3. 分析（纯函数，无 I/O）
  const profileId = randomUUID();
  const profile = analyze(collected.input as AnalyzerInput, {
    profileId,
    claimed: false,
    platform,
  });
  logger.info(
    `[worker] job ${job.id} analyzed: authenticity=${profile.authenticity.status} ` +
      `(confidence=${profile.authenticity.confidence}), ${profile.skillTags.length} skill tags`,
  );

  // 4. 写入不可变画像快照
  await repos.profiles.insert({
    id: profileId,
    analyzerVersion: profile.analyzerVersion,
    subjectPlatform: profile.subject.platform,
    subjectLogin: profile.subject.login,
    subjectClaimed: profile.subject.claimed,
    dataWindowSince: profile.dataWindow.since,
    dataWindowUntil: profile.dataWindow.until,
    analysisLayers: profile.analysisLayers,
    status: 'complete',
    snapshot: profile,
  });

  // 5. 标记任务成功
  await repos.jobs.succeed(job.id, profileId, collected.meta.budgetUsed, collected.meta.missing);
  logger.info(`[worker] job ${job.id} succeeded: profile ${profileId}`);

  return { profileId, profile, budgetUsed: collected.meta.budgetUsed, missing: collected.meta.missing };
}

/**
 * 处理任务失败：根据 attempts 决定重试或永久失败。
 * - attempts < maxRetries：resetToQueued 等待下次认领
 * - attempts >= maxRetries：fail 永久标记失败
 */
export async function handleJobFailure(
  job: StoredAnalysisJob,
  repos: WorkerRepos,
  error: Error,
  maxRetries: number,
  logger: Pick<Console, 'info' | 'warn' | 'error'> = console,
): Promise<void> {
  const message = error.message;
  const code = (error as { code?: string }).code;
  // not_found (account/repo does not exist) is deterministic — retrying cannot help.
  if (code === 'not_found') {
    await repos.jobs.fail(job.id, message);
    logger.error(`[worker] job ${job.id} not found, failing permanently: ${message}`);
    return;
  }
  if (job.attempts < maxRetries) {
    await repos.jobs.resetToQueued(job.id, message);
    logger.warn(
      `[worker] job ${job.id} failed (attempt ${job.attempts}/${maxRetries}), requeued: ${message}`,
    );
  } else {
    await repos.jobs.fail(job.id, message);
    logger.error(`[worker] job ${job.id} failed permanently (attempt ${job.attempts}): ${message}`);
  }
}

// ─── 主循环 ─────────────────────────────────────────────────────────────

const defaultSleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Worker 主循环：轮询认领任务 → 处理 → 成功/失败。
 * 可注入全部依赖，便于测试；生产环境用默认值。
 */
export async function runWorker(deps: WorkerDeps = {}): Promise<void> {
  const logger = deps.logger ?? console;
  const workerId = deps.workerId ?? `worker-${randomUUID().slice(0, 8)}`;
  const pollIntervalMs = deps.pollIntervalMs ?? 5000;
  const maxRetries = deps.maxRetries ?? 3;
  const envPositiveInt = (v: string | undefined): number | undefined => {
    if (v === undefined) return undefined;
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 ? n : undefined;
  };
  const demoMaxConcurrent =
    deps.demoMaxConcurrent ?? envPositiveInt(process.env.DEMO_MAX_CONCURRENT) ?? 1;
  const demoBackoffMs =
    deps.demoBackoffMs ?? envPositiveInt(process.env.DEMO_BACKOFF_MS) ?? 15_000;
  const sleep = deps.sleep ?? defaultSleep;
  const shouldContinue = deps.shouldContinue ?? (() => true);

  const repos = deps.repos ?? (await createStorage());
  const sources = makeSources(deps);

  logger.info(
    `[worker] ${workerId} started (poll=${pollIntervalMs}ms, maxRetries=${maxRetries}, ` +
      `demoCap=${demoMaxConcurrent}, demoBackoff=${demoBackoffMs}ms)`,
  );

  // Reclaim running jobs left by a crashed worker before the previous shutdown.
  // A job running for >5 minutes is almost certainly orphaned (single analysis takes <1 min).
  const reclaimed = await repos.jobs.reclaimStaleRunning(5 * 60 * 1000);
  if (reclaimed > 0) {
    logger.warn(`[worker] reclaimed ${reclaimed} stale running job(s) from a crashed worker`);
  }

  while (shouldContinue()) {
    const job = await repos.jobs.claimNext(workerId);
    if (!job) {
      await sleep(pollIntervalMs);
      continue;
    }

    // 演示并发闸：只约束 demo 任务（正式任务不限，且 claimNext 已让正式任务优先）。
    // 此刻该 job 已被认领为 running，故计数包含它自己：cap=1 时首个 demo 计数为 1，放行。
    if (job.requesterKind === 'demo') {
      const demoRunning = await repos.jobs.countRunningByRequesterKind('demo');
      if (demoRunning > demoMaxConcurrent) {
        await repos.jobs.deferToQueued(job.id, 'Deferred: demo concurrency cap');
        logger.info(
          `[worker] demo job ${job.id} deferred (demoRunning=${demoRunning} > cap=${demoMaxConcurrent}); ` +
            `back off ${demoBackoffMs}ms`,
        );
        await sleep(demoBackoffMs);
        continue;
      }
    }

    try {
      await processJob(job, repos, sources, logger);
    } catch (err) {
      await handleJobFailure(job, repos, err as Error, maxRetries, logger);
    }
  }

  logger.info(`[worker] ${workerId} stopped`);
}

// ─── 入口 ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const logger = console;
  let running = true;

  const shutdown = (signal: string) => {
    logger.info(`[worker] received ${signal}, shutting down after current job...`);
    running = false;
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    await runWorker({
      token: process.env.GITHUB_TOKEN,
      giteeToken: process.env.GITEE_TOKEN,
      workerId: process.env.WORKER_ID,
      pollIntervalMs: process.env.POLL_INTERVAL_MS ? Number(process.env.POLL_INTERVAL_MS) : undefined,
      maxRetries: process.env.MAX_RETRIES ? Number(process.env.MAX_RETRIES) : undefined,
      shouldContinue: () => running,
    });
  } catch (err) {
    logger.error(`[worker] fatal: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

// 仅在直接运行时启动（被 import 时不启动）
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
