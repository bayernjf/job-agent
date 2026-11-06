/**
 * 内置 LLM 账号级限流配置（决策 #29）。
 *
 * 只做一件事：把 `LLM_ACCOUNT_RATE_PER_HOUR` 从 env 读成结构化配置。
 * 计数本身复用 demo 滑窗仓储，不新增迁移；本配置与 demo 配额（DEMO_*）无关。
 */
export interface LlmQuotaConfig {
  /** 单账号每小时允许发起的内置 LLM 调用次数（求职信 + 润色共用单桶） */
  accountRatePerHour: number;
}

export const LLM_QUOTA_DEFAULTS = {
  accountRatePerHour: 20,
} as const;

/** 从环境变量对象加载配置（默认 process.env），纯函数、可测试。 */
export function loadLlmQuotaConfig(env: NodeJS.ProcessEnv = process.env): LlmQuotaConfig {
  const raw = env.LLM_ACCOUNT_RATE_PER_HOUR;
  if (raw === undefined || raw.trim() === '') {
    return { accountRatePerHour: LLM_QUOTA_DEFAULTS.accountRatePerHour };
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    console.warn(
      `[llm-quota] invalid LLM_ACCOUNT_RATE_PER_HOUR=${JSON.stringify(raw)}, fallback to ${LLM_QUOTA_DEFAULTS.accountRatePerHour}`,
    );
    return { accountRatePerHour: LLM_QUOTA_DEFAULTS.accountRatePerHour };
  }
  return { accountRatePerHour: n };
}
