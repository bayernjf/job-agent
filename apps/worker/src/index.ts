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
import { analyze, fuseInputs, type AnalyzerInput, type FusionReport } from '@jobagent/analyzer-core';
import { GiteeSource, type GiteeCollectedData } from '@jobagent/gitee-source';
import { GitHubSource, type GitHubCollectedData } from '@jobagent/github-source';
import type { AbilityProfile, EvidenceItem } from '@jobagent/shared';
import {
  createStorage,
  type IAnalysisJobsRepository,
  type IEvidenceRepository,
  type IProfilesRepository,
  type StoredAnalysisJob,
} from '@jobagent/storage';

// ─── 类型 ───────────────────────────────────────────────────────────────

export interface WorkerRepos {
  jobs: IAnalysisJobsRepository;
  profiles: IProfilesRepository;
  evidence: IEvidenceRepository;
}

/** 统一证据源接口：GitHubSource 与 GiteeSource 均满足此形态 */
export interface EvidenceSource {
  collect(login: string): Promise<GitHubCollectedData | GiteeCollectedData>;
}

/**
 * 分阶段采集（GitHubSource/GiteeSource 均实现；测试 fake 源可不实现——worker 探测到
 * 缺失时回退一次性 collect）。`handle` 为采集器内部句柄，worker 原样回传给 collectStagedL1。
 * T28 之后它的用途是**降级**，不是提前发布：`l0Input` 只在 L1 失败时作为"仅 L0"的终态输入，
 * 正常路径等 L1 到齐后**一次性**落画像——一次分析永远只发布一份可分享结论。
 */
export interface StagedEvidenceSource {
  collectStagedL0(login: string): Promise<{
    handle: unknown;
    l0Input: AnalyzerInput;
    l0Evidence: EvidenceItem[];
    budgetUsed: Record<string, number>;
  }>;
  collectStagedL1(
    login: string,
    handle: unknown,
  ): Promise<{
    fullInput: AnalyzerInput;
    fullEvidence: EvidenceItem[];
    missing: string[];
    budgetUsed: Record<string, number>;
    l1Error?: string;
  }>;
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
  budgetUsed: Record<string, number>;
  missing: string[];
  /** platform=all 且两源都成功时的融合报告（同时挂进 profile.fusion 随快照持久化，见 fusion 设计 §8） */
  fusion?: FusionReport;
  /** platform=all 时辅源 Gitee 是否真的采到（false=Gitee 无同名账号，已降级纯 GitHub） */
  secondaryAvailable?: boolean;
}

/** 合并两源预算计量：同 key 累加（graphqlPoints 仅 GitHub 有；restCalls 两源相加）。 */
function mergeBudget(
  primary: Record<string, number>,
  secondary?: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = { ...primary };
  if (secondary) {
    for (const [key, value] of Object.entries(secondary)) {
      out[key] = (out[key] ?? 0) + value;
    }
  }
  return out;
}

/** 合并两源缺失标注：辅源项统一加 gitee: 前缀后与主源并集去重，避免歧义。 */
function mergeMissing(primary: string[], secondary: string[]): string[] {
  return [...new Set([...primary, ...secondary.map((m) => `gitee:${m}`)])];
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
  const requestedPlatform = job.subjectPlatform ?? 'github';
  const t0 = Date.now();
  logger.info(
    `[worker] job ${job.id} start: collect ${login} (platform=${requestedPlatform}, attempt ${job.attempts})`,
  );

  // NFR-7 可观测：采集 / 分析 / 持久化分段计时，随成功日志输出，供生产按日志聚合 P95。
  const collectStart = Date.now();

  // 1. 采集（L0 + L1）并准备分析输入。
  //    platform=all：主源 GitHub + 辅源 Gitee 双采、fuseInputs 镜像去重（fusion 设计 §8）；
  //    辅源 404（无同名账号）正常降级纯 GitHub，辅源临时错误上抛重试。
  let analyzerInput: AnalyzerInput;
  let budgetUsed: Record<string, number>;
  let missing: string[];
  let analyzePlatform: 'github' | 'gitee';
  let persistPlatform: 'github' | 'gitee' | 'all';
  let fusionReport: FusionReport | undefined;
  // T28：L1 降级为仅 L0 时，快照宣称的已分析层必须跟着降，不能仍写 ['L0','L1']
  let collectLayers: Array<'L0' | 'L1'> | undefined;
  let secondaryAvailable: boolean | undefined;

  if (requestedPlatform === 'all') {
    // 主源 GitHub：not_found/其他错误都上抛，由 handleJobFailure 决定永久失败或重试。
    const gh = await sources.github.collect(login);

    // 辅源 Gitee：404=该用户无 Gitee 账号（常态），降级主源；其余错误上抛重试，不静默降级。
    let ge: GitHubCollectedData | GiteeCollectedData | undefined;
    try {
      ge = await sources.gitee.collect(login);
    } catch (err) {
      if ((err as { code?: string }).code === 'not_found') {
        ge = undefined;
        logger.warn(
          `[worker] job ${job.id} gitee account '${login}' not found; falling back to a GitHub-only profile`,
        );
      } else {
        throw err;
      }
    }

    if (ge) {
      const fused = fuseInputs(gh.input as AnalyzerInput, ge.input as AnalyzerInput, {
        primary: 'github',
        secondary: 'gitee',
      });
      analyzerInput = fused.input;
      fusionReport = fused.report;
      secondaryAvailable = true;
      budgetUsed = mergeBudget(gh.meta.budgetUsed, ge.meta.budgetUsed);
      missing = mergeMissing(gh.meta.missing, ge.meta.missing);
      persistPlatform = 'all';
      logger.info(
        `[worker] job ${job.id} fused GitHub+Gitee: ${fused.report.mergedMirrors.length} mirror(s) merged, ` +
          `${fused.report.dedupedCommitCount} duplicate commit(s) dropped, ${fused.input.repos.length} repos`,
      );
    } else {
      // Gitee 无同名账号：产物本质是纯 GitHub 画像，按 'github' 持久化（不冒充融合）。
      analyzerInput = gh.input as AnalyzerInput;
      budgetUsed = { ...gh.meta.budgetUsed };
      missing = [...new Set([...gh.meta.missing, 'gitee:account_not_found'])];
      persistPlatform = 'github';
      secondaryAvailable = false;
    }
    analyzePlatform = 'github'; // 内核主源视角，snapshot.subject.platform 恒为 github（设计 §8.1）
  } else {
    const platform = requestedPlatform === 'gitee' ? 'gitee' : 'github';
    const source = sources[platform];

    // T28（评审 §9.3）：**一次分析只发布一份可分享结论**。
    // 分阶段采集保留，但用途回到 PRD F2 验收 3 的原意——只有 **L1 真失败/预算耗尽**时才
    // 降级为仅 L0 的 partial 画像。批次 6 把它做成了无条件主路径（先落 partial:L0 并提前
    // succeed，再升级同一 profileId），于是同一分享链接先后给出两份不同分级，违背 AGENTS
    // 第 5 条"画像以不可变快照写入、分享链接永远指向生成时版本"。
    const staged = source as unknown as Partial<StagedEvidenceSource>;
    if (staged.collectStagedL0 && staged.collectStagedL1) {
      const l0res = await staged.collectStagedL0(login);
      // 进度只写 jobs.stage（前端据此显示"已取 L0"），不产生半途画像。
      await repos.jobs.updateStage(job.id, 'L0');
      let l1res: Awaited<ReturnType<StagedEvidenceSource['collectStagedL1']>>;
      try {
        l1res = await staged.collectStagedL1(login, l0res.handle);
      } catch (err) {
        // 采集器内部已把 L1 失败降级掉；走到这里说明是意外抛错。
        // 仍然只发布**一份**画像：内容为仅 L0 数据 + l1_failed 标注，整单不失败。
        logger.warn(
          `[worker] job ${job.id} staged L1 threw, publishing L0-only partial: ${(err as Error).message}`,
        );
        l1res = {
          fullInput: { ...l0res.l0Input, missing: ['l1_failed'] },
          fullEvidence: l0res.l0Evidence,
          missing: ['l1_failed'],
          budgetUsed: l0res.budgetUsed,
          l1Error: (err as Error).message,
        };
      }
      analyzerInput = l1res.fullInput;
      budgetUsed = { ...l1res.budgetUsed };
      missing = l1res.missing;
      analyzePlatform = platform;
      persistPlatform = platform;
      // L1 降级时快照宣称的已分析层一起降，不能仍写 ['L0','L1']。
      if (l1res.l1Error || l1res.missing.includes('l1_failed')) collectLayers = ['L0'];
      logger.info(
        `[worker] job ${job.id} staged collect: ${analyzerInput.repos.length} repos, ` +
          `${analyzerInput.commits.length} commits, ${analyzerInput.pullRequests.length} PRs, ` +
          `missing=${missing.length}${l1res.l1Error ? ` l1Error=${l1res.l1Error}` : ''}`,
      );
    } else {
      // 回退路径：不支持分阶段的源（如测试 fake）一次性 collect。
      const collected = await source.collect(login);
      analyzerInput = collected.input as AnalyzerInput;
      budgetUsed = { ...collected.meta.budgetUsed };
      missing = collected.meta.missing;
      analyzePlatform = platform;
      persistPlatform = platform;
      logger.info(
        `[worker] job ${job.id} collected: ${collected.input.repos.length} repos, ` +
          `${collected.input.commits.length} commits, ${collected.input.pullRequests.length} PRs, ` +
          `missing=${collected.meta.missing.length}`,
      );
    }
  }

  // 2. 更新进度阶段
  await repos.jobs.updateStage(job.id, 'L1');
  const collectMs = Date.now() - collectStart;

  // 3. 分析（纯函数，无 I/O）
  const analyzeStart = Date.now();
  const profileId = randomUUID();
  const profile = analyze(analyzerInput, {
    profileId,
    claimed: false,
    platform: analyzePlatform,
    // 双源融合时把融合报告挂进画像快照（随 snapshot 持久化）；单源/Gitee 404 降级时缺省
    ...(collectLayers ? { layers: collectLayers } : {}),
    ...(fusionReport ? { fusion: fusionReport } : {}),
  });
  const analyzeMs = Date.now() - analyzeStart;
  logger.info(
    `[worker] job ${job.id} analyzed in ${analyzeMs}ms: authenticity=${profile.authenticity.status} ` +
      `(confidence=${profile.authenticity.confidence}), ${profile.skillTags.length} skill tags`,
  );

  // 4. 写入不可变画像快照。
  //    融合画像在检索键列存 'all'（与单源隔离），snapshot 内 subject.platform 仍为主源 github。
  const persistStart = Date.now();
  await repos.profiles.insert({
    id: profileId,
    analyzerVersion: profile.analyzerVersion,
    subjectPlatform: persistPlatform,
    subjectLogin: profile.subject.login,
    subjectClaimed: profile.subject.claimed,
    dataWindowSince: profile.dataWindow.since,
    dataWindowUntil: profile.dataWindow.until,
    analysisLayers: profile.analysisLayers,
    // T25 失败显式化：有 missing 的画像落库为 partial（报告页标注"部分数据"），
    // 不再硬编 complete——NFR-6 与 PRD F2 验收 3 的降级路径真实可达。
    status: missing.length > 0 ? 'partial' : 'complete',
    snapshot: profile,
  });

  // 5. Persist evidence rows so report pages can render source links and recruiters can
  //    trace every claim. analyzerInput.evidence is source-agnostic (fusion-deduped for all).
  await repos.evidence.importFromProfile(profileId, analyzerInput.evidence);

  // 6. 标记任务成功
  await repos.jobs.succeed(job.id, profileId, budgetUsed, missing);
  const persistMs = Date.now() - persistStart;
  const totalMs = Date.now() - t0;
  const budgetSummary = Object.entries(budgetUsed)
    .map(([k, v]) => `${k}=${v}`)
    .join(',');
  logger.info(
    `[worker] job ${job.id} succeeded: profile ${profileId} (persisted as ${persistPlatform}) ` +
      `timingMs total=${totalMs} collect=${collectMs} analyze=${analyzeMs} persist=${persistMs} ` +
      `budget[${budgetSummary}] missing=${missing.length}`,
  );

  return {
    profileId,
    profile,
    budgetUsed,
    missing,
    ...(fusionReport ? { fusion: fusionReport } : {}),
    ...(requestedPlatform === 'all' ? { secondaryAvailable } : {}),
  };
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

// ─── 单任务认领处理（常驻循环与 serverless cron 共用）────────────────────

const envPositiveInt = (v: string | undefined): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
};

/** claimAndProcessOne 的结果判别联合（供 serverless cron 端点序列化返回）。 */
export type ClaimOneResult =
  | { kind: 'idle' }
  | { kind: 'deferred'; jobId: string }
  | { kind: 'processed'; jobId: string; profileId: string }
  | { kind: 'failed'; jobId: string; permanent: boolean; message: string };

export interface ClaimOneDeps {
  /** 注入证据源 map（测试用 fake；生产默认 makeSources 创建） */
  sources?: SourceMap;
  /** 注入仓储（测试用内存库；生产默认 createStorage） */
  repos?: WorkerRepos;
  /** 注入 GITHUB_TOKEN（生产从环境变量读） */
  token?: string;
  /** 注入 GITEE_TOKEN（生产从环境变量读；Gitee 匿名可读，可为空） */
  giteeToken?: string;
  /** Worker 标识（默认随机；serverless cron 用固定名如 vercel-cron） */
  workerId?: string;
  /** 最大重试次数（默认 3） */
  maxRetries?: number;
  /** 同时处理的演示任务上限（默认 1） */
  demoMaxConcurrent?: number;
  /**
   * 认领前先回收 running 超过该毫秒数的僵尸任务（serverless cron 每次调用都没有
   * "启动回收"环节，故传 5*60*1000；常驻 Worker 在 runWorker 启动时只回收一次，传 null）。
   * 默认 null（不回收）。
   */
  reclaimStaleMs?: number | null;
  /** 日志注入（默认 console） */
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
}

/**
 * 认领并处理至多一个任务（无轮询、无循环）：
 * claimNext → demo 并发闸（超闸退回 queued）→ processJob → 失败走 handleJobFailure。
 *
 * 常驻 Worker 的主循环每次迭代调用它；serverless 部署（Vercel Cron）由定时端点
 * 每次冷/温实例调用一次。函数超时被平台切断时，任务留在 running，由
 * reclaimStaleRunning（>5 分钟）在下一轮回收，不会丢任务。
 */
export async function claimAndProcessOne(deps: ClaimOneDeps = {}): Promise<ClaimOneResult> {
  const logger = deps.logger ?? console;
  const workerId = deps.workerId ?? `worker-${randomUUID().slice(0, 8)}`;
  const maxRetries = deps.maxRetries ?? 3;
  const demoMaxConcurrent =
    deps.demoMaxConcurrent ?? envPositiveInt(process.env.DEMO_MAX_CONCURRENT) ?? 1;

  const repos = deps.repos ?? (await createStorage());

  // serverless cron 没有"启动回收"环节：每次触发先回收 >阈值仍 running 的僵尸任务
  // （函数超时/实例被回收会留下 running；常驻 Worker 在 runWorker 启动时只回收一次）。
  if (deps.reclaimStaleMs != null) {
    const reclaimed = await repos.jobs.reclaimStaleRunning(deps.reclaimStaleMs);
    if (reclaimed > 0) {
      logger.warn(`[worker] reclaimed ${reclaimed} stale running job(s) before cron claim`);
    }
  }

  const job = await repos.jobs.claimNext(workerId);
  if (!job) return { kind: 'idle' };

  // 演示并发闸：只约束 demo 任务（正式任务不限，claimNext 已让正式任务优先）。
  if (job.requesterKind === 'demo') {
    const demoRunning = await repos.jobs.countRunningByRequesterKind('demo');
    if (demoRunning > demoMaxConcurrent) {
      await repos.jobs.deferToQueued(job.id, 'Deferred: demo concurrency cap');
      logger.info(
        `[worker] demo job ${job.id} deferred (demoRunning=${demoRunning} > cap=${demoMaxConcurrent})`,
      );
      return { kind: 'deferred', jobId: job.id };
    }
  }

  // 延迟到确认确有任务要处理时才构造 source（含 GITHUB_TOKEN 校验）：空队列 idle 与
  // demo 超闸 deferred 都不需要凭证，serverless cron 在无任务/未配 token 的空窗期也能
  // 正常返回，而不是在认领前就因缺 token 抛 500。常驻 runWorker 仍在启动时 fail-fast。
  const sources = deps.sources ?? makeSources(deps);

  try {
    const result = await processJob(job, repos, sources, logger);
    return { kind: 'processed', jobId: job.id, profileId: result.profileId };
  } catch (err) {
    const error = err as Error;
    const code = (error as { code?: string }).code;
    const permanent = code === 'not_found' || job.attempts >= maxRetries;
    await handleJobFailure(job, repos, error, maxRetries, logger);
    return { kind: 'failed', jobId: job.id, permanent, message: error.message };
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
    // 单任务认领/处理逻辑与 serverless cron 端点共用 claimAndProcessOne。
    const outcome = await claimAndProcessOne({
      repos,
      sources,
      token: deps.token,
      giteeToken: deps.giteeToken,
      workerId,
      maxRetries,
      demoMaxConcurrent,
      logger,
    });

    if (outcome.kind === 'idle') {
      await sleep(pollIntervalMs);
    } else if (outcome.kind === 'deferred') {
      await sleep(demoBackoffMs);
    }
    // processed / failed：立即进入下一轮认领（正式任务优先、不额外等待）。
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
