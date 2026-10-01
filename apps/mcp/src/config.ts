/**
 * MCP 接入面配置（决策 #19 已决策 2026-10-01）。
 *
 * 三条已定纪律（见 docs/design-mcp-surface-20260928.md §5/§7）：
 *  - fail-closed：未配置 MCP_API_KEY 时，画像类工具一律拒绝（401 MCP_KEY_REQUIRED），
 *    只有 search_jobs 这一公开岗位检索放行；生产环境缺 key 启动即失败。
 *  - 只读且绝不触发分析：不扣 demo 配额、不占 Worker 并发闸。
 *  - evidenceRefs 维持"只给内部 id"，本面不返回任何 http(s) 证据外链与面试题。
 */
import { createHash } from 'node:crypto';

export interface McpConfig {
  /** 服务到服务密钥；undefined = 未配置（fail-closed）。 */
  apiKey?: string;
  /** 是否生产环境（NODE_ENV=production）；生产缺 key 启动即失败。 */
  isProduction: boolean;
  /** 固定窗口长度（毫秒），默认 60s。 */
  windowMs: number;
  /** 每个 key+IP 每窗口最大请求数，默认 60。 */
  maxRequestsPerWindow: number;
  /** IP 滑窗加盐哈希用盐；缺省进程内随机（仅本地/实验可接受，生产必须固定）。 */
  ipSalt: string;
}

export const MCP_ERROR_CODES = {
  keyRequired: 'MCP_KEY_REQUIRED',
  rateLimited: 'MCP_RATE_LIMITED',
  profileNotFound: 'PROFILE_NOT_FOUND',
  invalidSubject: 'INVALID_SUBJECT',
} as const;

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_REQUESTS = 60;

export function loadMcpConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const isProduction = env.NODE_ENV === 'production';
  const apiKey = env.MCP_API_KEY?.trim() || undefined;

  // 与 API 的 T27 启动闸同纪律：生产缺 key 直接失败，而不是静默降级成"人人可用"。
  if (isProduction && !apiKey) {
    throw new Error(
      'MCP_API_KEY must be set in production (the MCP surface is fail-closed: without a key, profile tools would either be fully disabled or silently opened)',
    );
  }

  const windowMs = env.MCP_RATE_WINDOW_MS ? Number(env.MCP_RATE_WINDOW_MS) : DEFAULT_WINDOW_MS;
  const max = env.MCP_RATE_LIMIT_PER_WINDOW
    ? Number(env.MCP_RATE_LIMIT_PER_WINDOW)
    : DEFAULT_MAX_REQUESTS;
  if (!Number.isInteger(windowMs) || windowMs < 1_000) {
    throw new Error('MCP_RATE_WINDOW_MS must be an integer >= 1000 when set');
  }
  if (!Number.isInteger(max) || max < 1) {
    throw new Error('MCP_RATE_LIMIT_PER_WINDOW must be a positive integer when set');
  }

  return {
    apiKey,
    isProduction,
    windowMs,
    maxRequestsPerWindow: max,
    ipSalt: env.DEMO_IP_SALT || createHash('sha256').update(String(Date.now())).digest('hex'),
  };
}

/** IP 只存加盐哈希（沿用演示模式做法），不落原始 IP。无 IP（stdio 本地）返回 null。 */
export function hashIp(ip: string | null | undefined, salt: string): string | null {
  if (!ip) return null;
  return createHash('sha256').update(`${salt}:${ip}`).digest('hex');
}

/** 常量时间比较，避免密钥时序侧信道。 */
export function isApiKeyValid(provided: string | undefined, expected: string | undefined): boolean {
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqualLocal(a, b);
}

function timingSafeEqualLocal(a: Buffer, b: Buffer): boolean {
  // 不直接依赖 node:crypto 的 timingSafeEqual 类型重载差异，自己做按位累加。
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
