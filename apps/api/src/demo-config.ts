/**
 * 演示模式配置（design-demo-mode-20260915 §13）。
 *
 * 单一事实源：所有 DEMO_* / CORS / TRUST_PROXY 环境变量只在这里读取一次，
 * 非法值回退默认并 warn，不在各端点散落 process.env。纯函数便于单测。
 * 配额为待拍板建议值（§16-#1/#3），代码走可配默认、不写死业务决策。
 */

export interface DemoPresetLogin {
  platform: 'github' | 'gitee';
  login: string;
}

export interface DemoConfig {
  /** 演示会话有效期（ms），同时是 Cookie Max-Age */
  sessionTtlMs: number;
  /** 单会话可触发的新分析次数（硬配额） */
  analyzeQuota: number;
  /** 单 IP 每小时建会话上限 */
  sessionRatePerHour: number;
  /** 单 IP 每小时触发分析上限 */
  analyzeRatePerHour: number;
  /** match 只读计算的 IP 兜底窗口（仅观测/防刷，不设会话硬配额） */
  matchRatePerHour: number;
  /** Worker 同时运行的 demo job 上限 */
  maxConcurrent: number;
  /** demo 并发闸触发后的退避毫秒 */
  backoffMs: number;
  /** IP 哈希盐；空串=进程内随机（生产必须显式配置，否则重启后旧窗口失效） */
  ipSalt: string;
  /** 预置示例账号清单（DEMO_PRESET_LOGINS 覆盖；默认空，待拍板 §16-#5，不写死） */
  presetLogins: ReadonlyArray<DemoPresetLogin>;
  /** 跨域部署形态 B 的 Origin 白名单（空=保持现状宽松、不发凭证 Cookie） */
  corsAllowOrigins: ReadonlyArray<string>;
  /** 是否信任反向代理（生产反代后置 true，才从 X-Forwarded-For 取 IP） */
  trustProxy: boolean;
  /** 是否生产环境（决定 Cookie Secure） */
  isProduction: boolean;
}

export const DEMO_DEFAULTS = {
  sessionTtlMs: 7 * 24 * 60 * 60 * 1000, // 604800000，7 天
  analyzeQuota: 3,
  sessionRatePerHour: 5,
  analyzeRatePerHour: 10,
  matchRatePerHour: 60,
  maxConcurrent: 1,
  backoffMs: 15_000,
} as const;

const HOUR_MS = 60 * 60 * 1000;

function positiveInt(
  raw: string | undefined,
  fallback: number,
  label: string,
  min = 0,
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    console.warn(`[demo-config] invalid ${label}=${JSON.stringify(raw)}, fallback to ${fallback}`);
    return fallback;
  }
  return n;
}

function parsePresetLogins(raw: string | undefined): DemoPresetLogin[] {
  if (!raw || raw.trim() === '') return [];
  const out: DemoPresetLogin[] = [];
  for (const piece of raw.split(',')) {
    const item = piece.trim();
    if (!item) continue;
    const sep = item.indexOf(':');
    if (sep < 0) {
      console.warn(`[demo-config] ignore malformed preset "${item}" (expected platform:login)`);
      continue;
    }
    const platform = item.slice(0, sep).trim();
    const login = item.slice(sep + 1).trim();
    if ((platform !== 'github' && platform !== 'gitee') || !login) {
      console.warn(`[demo-config] ignore malformed preset "${item}"`);
      continue;
    }
    out.push({ platform, login });
  }
  return out;
}

function parseOriginList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 从环境变量对象加载配置（默认 process.env），纯函数、可测试。 */
export function loadDemoConfig(env: NodeJS.ProcessEnv = process.env): DemoConfig {
  const ipSalt = env.DEMO_IP_SALT ?? '';
  return {
    sessionTtlMs: positiveInt(env.DEMO_SESSION_TTL_MS, DEMO_DEFAULTS.sessionTtlMs, 'DEMO_SESSION_TTL_MS', 1000),
    analyzeQuota: positiveInt(env.DEMO_ANALYZE_QUOTA, DEMO_DEFAULTS.analyzeQuota, 'DEMO_ANALYZE_QUOTA', 0),
    sessionRatePerHour: positiveInt(
      env.DEMO_SESSION_RATE_PER_HOUR,
      DEMO_DEFAULTS.sessionRatePerHour,
      'DEMO_SESSION_RATE_PER_HOUR',
      1,
    ),
    analyzeRatePerHour: positiveInt(
      env.DEMO_ANALYZE_RATE_PER_HOUR,
      DEMO_DEFAULTS.analyzeRatePerHour,
      'DEMO_ANALYZE_RATE_PER_HOUR',
      1,
    ),
    matchRatePerHour: positiveInt(
      env.DEMO_MATCH_RATE_PER_HOUR,
      DEMO_DEFAULTS.matchRatePerHour,
      'DEMO_MATCH_RATE_PER_HOUR',
      1,
    ),
    maxConcurrent: positiveInt(env.DEMO_MAX_CONCURRENT, DEMO_DEFAULTS.maxConcurrent, 'DEMO_MAX_CONCURRENT', 1),
    backoffMs: positiveInt(env.DEMO_BACKOFF_MS, DEMO_DEFAULTS.backoffMs, 'DEMO_BACKOFF_MS', 0),
    ipSalt,
    presetLogins: parsePresetLogins(env.DEMO_PRESET_LOGINS),
    corsAllowOrigins: parseOriginList(env.CORS_ALLOW_ORIGINS),
    trustProxy: (env.TRUST_PROXY ?? 'false').toLowerCase() === 'true',
    isProduction: env.NODE_ENV === 'production',
  };
}

/** 滑动窗口的一小时前时间戳（ISO），供 IP 限流复用。 */
export function oneHourAgo(nowIso: string): string {
  return new Date(Date.parse(nowIso) - HOUR_MS).toISOString();
}
