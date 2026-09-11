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
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze, type AnalyzerInput } from '@jobagent/analyzer-core';
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

export interface WorkerDeps {
  /** 注入 GitHubSource（测试用 fake；生产默认 new GitHubSource） */
  source?: { collect(login: string): Promise<GitHubCollectedData> };
  /** 注入仓储（测试用内存库；生产默认 createStorage） */
  repos?: WorkerRepos;
  /** 注入 GITHUB_TOKEN（生产从环境变量读） */
  token?: string;
  /** Worker 标识（默认随机） */
  workerId?: string;
  /** 轮询间隔毫秒（默认 5000） */
  pollIntervalMs?: number;
  /** 最大重试次数（默认 3） */
  maxRetries?: number;
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
  budgetUsed: GitHubCollectedData['meta']['budgetUsed'];
  missing: string[];
}

function makeSource(deps: WorkerDeps): { collect(login: string): Promise<GitHubCollectedData> } {
  if (deps.source) return deps.source;
  const token = deps.token ?? process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      'GITHUB_TOKEN is not set. Create a fine-grained PAT (public repo read-only) and put it in the environment.',
    );
  }
  return new GitHubSource({ token, log: deps.logger ?? console });
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
  source: { collect(login: string): Promise<GitHubCollectedData> },
  logger: Pick<Console, 'info' | 'warn' | 'error'> = console,
): Promise<ProcessJobResult> {
  const login = job.subjectLogin;
  logger.info(`[worker] job ${job.id} start: collect ${login} (attempt ${job.attempts})`);

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
  const sleep = deps.sleep ?? defaultSleep;
  const shouldContinue = deps.shouldContinue ?? (() => true);

  const repos = deps.repos ?? (await createStorage());
  const source = makeSource(deps);

  logger.info(`[worker] ${workerId} started (poll=${pollIntervalMs}ms, maxRetries=${maxRetries})`);

  while (shouldContinue()) {
    const job = await repos.jobs.claimNext(workerId);
    if (!job) {
      await sleep(pollIntervalMs);
      continue;
    }

    try {
      await processJob(job, repos, source, logger);
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
