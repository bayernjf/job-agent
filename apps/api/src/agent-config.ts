/**
 * 求职 Agent 工作台的运行配置（阶段 1/2，设计 docs/设计-求职Agent-20261002.md）。
 *
 * 四个旋钮都有内置默认值：本次作业的候选上限、单轮扫描从岗位池取多少条、
 * 一次 cron tick 最多推进多少个任务、submitting 状态多久未回执视为超时。
 * 全部只在服务端读，不下发前端。
 * 非法值直接抛错（不让配置错误静默降级成别的行为）。
 */

export interface AgentConfig {
  /** 一轮扫描最多产出多少条待投票据 */
  candidateLimit: number;
  /** 单轮扫描从岗位池取的候选条数（排序按发布时间倒序，取最近的一批） */
  scanPoolLimit: number;
  /** 一次 agent-tick 最多推进多少任务 */
  tickMaxRuns: number;
  /** 阶段 2：submitting 状态超过该小时数无回执 → cron 回收为 failed（显式原因 submit_timeout） */
  submitStaleHours: number;
}

export const AGENT_DEFAULTS = {
  candidateLimit: 10,
  // 生产岗位池 active ≈ 9862 条（2026-09-30 实查），默认 2000 覆盖最近约 20%，
  // 兼顾覆盖面与单轮扫描成本；需要全量时部署方可用 env 调到上限 5000。
  scanPoolLimit: 2000,
  tickMaxRuns: 10,
  // 用户确认后 24h 内未在扩展完成提交 → 视为放弃，任务显式 failed 不再悬空
  submitStaleHours: 24,
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
    tickMaxRuns: positiveInt(env.AGENT_TICK_MAX_RUNS, AGENT_DEFAULTS.tickMaxRuns, 'AGENT_TICK_MAX_RUNS', 100),
    submitStaleHours: positiveInt(
      env.AGENT_SUBMIT_STALE_HOURS,
      AGENT_DEFAULTS.submitStaleHours,
      'AGENT_SUBMIT_STALE_HOURS',
      720,
    ),
  };
}
