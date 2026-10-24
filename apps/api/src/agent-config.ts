/**
 * 求职 Agent 工作台的运行配置（阶段 1/2，设计 docs/设计-求职Agent-20261002.md）。
 *
 * 旋钮都有内置默认值：本次作业的候选上限、单轮扫描从岗位池取多少条、
 * 一次 cron tick 最多推进多少个任务、submitting 状态多久未回执视为超时、
 * 整轮 tick 的墙钟截止时间。
 * 全部只在服务端读，不下发前端。
 * 非法值直接抛错（不让配置错误静默降级成别的行为）。
 */

import type { LlmUsageObserver } from '@jobagent/llm';
import type { JdInsight, UsageBillingSource } from '@jobagent/shared';
import { JOB_DEFAULT_STALE_DAYS, parseStaleDays } from '@jobagent/job-source';

/**
 * 计量感知的 JD 抽取端口（决策 #25 ④ Wave B）：在 agent-core 的 {@link JdExtractor}
 * 二参签名上加可选第三参 onUsage 观察者；既有的二参注入天然兼容（可赋值给本类型）。
 */
export type MeteredJdExtractor = (
  title: string,
  description: string,
  onUsage?: LlmUsageObserver,
) => Promise<JdInsight | null>;

/**
 * JD 抽取 provider 的计量上下文（与 jdExtractor 由同一装配处一并给出）：
 * provider/model/billingSource 是装配决策的事实记录——后台 cron 无登录用户上下文，
 * 只走内置 env，故生产装配恒为 'builtin'；测试注入无 meta 时兜底 'builtin'。
 */
export interface JdExtractorMeta {
  provider: string | null;
  model: string | null;
  billingSource: UsageBillingSource;
}

export interface AgentConfig {
  /** 一轮扫描最多产出多少条待投票据 */
  candidateLimit: number;
  /** 单轮扫描从岗位池取的候选条数（排序按发布时间倒序，取最近的一批） */
  scanPoolLimit: number;
  /**
   * 岗位池新鲜窗口（天）。读的是既有 env `JOB_STALE_DAYS`（与 `/job-postings/stats`
   * 同一个旋钮，不新增配置面）：源站已不再列出的岗位不该被扫成"待投"票据。
   */
  poolStaleDays: number;
  /** 一次 agent-tick 最多推进多少任务 */
  tickMaxRuns: number;
  /** 阶段 2：submitting 状态超过该小时数无回执 → cron 回收为 failed（显式原因 submit_timeout） */
  submitStaleHours: number;
  /**
   * recommending 占位后超过该分钟数仍未回到 awaiting_approval（进程在写票据前被杀）
   * → cron 用 rescan 回收回 watching 重扫。正常生命周期是毫秒级，阈值必须显著大于
   * 单轮扫描耗时与 tick 间隔（cron-worker 每 5 分钟一 tick），避免回收正在进行中的扫描。
   */
  recommendStaleMinutes: number;
  /**
   * C1 语义增强端口（可选，默认 undefined＝关闭，纯规则 MatchReport）。
   * 运行时由 apps/api 装配（env AGENT_JD_LLM_ENABLED 且 LLM 可用时注入），
   * 不进 loadAgentConfig 的 env 数值解析；agent-core 只定义端口、不发请求。
   * 返回 null 或抛错都按 fail-closed 处理（保留纯规则报告，不阻塞推荐）。
   * 类型为计量感知的 {@link MeteredJdExtractor}（可选第三参 onUsage，
   * 决策 #25 ④ Wave B）；二参的 agent-core {@link JdExtractor} 天然兼容。
   */
  jdExtractor?: MeteredJdExtractor;
  /**
   * jdExtractor 的计量上下文（决策 #25 ④ Wave B）：与 jdExtractor 由同一装配处
   * 一并给出；埋点据此写 provider/model/billingSource，缺失时 provider/model
   * 记 null、billingSource 兜底 'builtin'（测试注入无 meta 的场景）。
   */
  jdExtractorMeta?: JdExtractorMeta;
  /**
   * 单轮扫描内 LLM JD 增强的整体墙钟预算（毫秒）：每条候选调用前检查，预算耗尽后
   * 剩余候选保留纯规则报告、票据照常写出。防止串行 LLM 等待把整轮 tick 拖过
   * cron-worker 的 60s 调用超时导致任务在 watching 上空转（单次调用本身另有
   * LLM_TIMEOUT_MS 上限，故最坏超支 ≤ 一次在途调用）。
   */
  jdLlmBudgetMs: number;
  /**
   * 一次 agent-tick 的整轮墙钟预算（毫秒，从 tick 开始推进任务前起算）：
   * 串行推进多个 run 时，每接一个新 run、每次 JD LLM 调用前都检查共享截止时刻，
   * 超时即停止接新 run（已在跑的 run 不打断）。必须显著小于 cron-worker 的 60s
   * fetch 超时，给回收/池查询/响应与在途调用留余量；手动「立即扫描」不走该预算。
   */
  tickDeadlineMs: number;
}

export const AGENT_DEFAULTS = {
  candidateLimit: 10,
  // 生产岗位池 active ≈ 9862 条（2026-09-30 实查），默认 2000 覆盖最近约 20%，
  // 兼顾覆盖面与单轮扫描成本；需要全量时部署方可用 env 调到上限 5000。
  scanPoolLimit: 2000,
  // 新鲜窗口沿用 job-source 的单一默认（JOB_STALE_DAYS 可覆盖）
  poolStaleDays: JOB_DEFAULT_STALE_DAYS,
  tickMaxRuns: 10,
  // 用户确认后 24h 内未在扩展完成提交 → 视为放弃，任务显式 failed 不再悬空
  submitStaleHours: 24,
  // 3 个 tick 间隔：足以确认占位进程已死，又不会长时间卡在不可推进的 recommending
  recommendStaleMinutes: 15,
  // cron-worker 调用超时 60s，预算 20s 给增强阶段留出池子拉取/匹配与多任务余量
  jdLlmBudgetMs: 20_000,
  // 整轮 tick 预算 50s：小于 cron-worker 60s fetch 超时，留 10s 给回收/池查询/响应
  tickDeadlineMs: 50_000,
} as const;

function positiveInt(raw: string | undefined, fallback: number, name: string, max: number): number {
  const text = (raw ?? '').trim();
  if (text === '') return fallback;
  const value = Number(text);
  if (!Number.isInteger(value) || value <= 0 || value > max) {
    throw new Error(`${name} must be a positive integer <= ${max} (got "${text}")`);
  }
  return value;
}

export function loadAgentConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  return {
    candidateLimit: positiveInt(env.AGENT_CANDIDATE_LIMIT, AGENT_DEFAULTS.candidateLimit, 'AGENT_CANDIDATE_LIMIT', 50),
    scanPoolLimit: positiveInt(env.AGENT_SCAN_POOL_LIMIT, AGENT_DEFAULTS.scanPoolLimit, 'AGENT_SCAN_POOL_LIMIT', 5000),
    poolStaleDays: parseStaleDays(env.JOB_STALE_DAYS, AGENT_DEFAULTS.poolStaleDays),
    tickMaxRuns: positiveInt(env.AGENT_TICK_MAX_RUNS, AGENT_DEFAULTS.tickMaxRuns, 'AGENT_TICK_MAX_RUNS', 100),
    submitStaleHours: positiveInt(
      env.AGENT_SUBMIT_STALE_HOURS,
      AGENT_DEFAULTS.submitStaleHours,
      'AGENT_SUBMIT_STALE_HOURS',
      720,
    ),
    recommendStaleMinutes: positiveInt(
      env.AGENT_RECOMMEND_STALE_MINUTES,
      AGENT_DEFAULTS.recommendStaleMinutes,
      'AGENT_RECOMMEND_STALE_MINUTES',
      1440,
    ),
    jdLlmBudgetMs: positiveInt(
      env.AGENT_JD_LLM_BUDGET_MS,
      AGENT_DEFAULTS.jdLlmBudgetMs,
      'AGENT_JD_LLM_BUDGET_MS',
      // 上限留出在途调用与 tick 内其余工作的余量，配置错误不能把预算放到 60s 超时之外
      50_000,
    ),
    tickDeadlineMs: positiveInt(
      env.AGENT_TICK_DEADLINE_MS,
      AGENT_DEFAULTS.tickDeadlineMs,
      'AGENT_TICK_DEADLINE_MS',
      // 硬上限 55s：必须小于 cron-worker 60s fetch 超时，至少留 5s 响应余量
      55_000,
    ),
  };
}
