/**
 * LLM 请求路由（decision #21，design-llm-model-provisioning-20261003 §4.3；
 * W5-1 接入 model-hub）：
 * **BYOK 优先 → 内置回落 → 功能既有策略（polish 规则版 / cover-letter 503）**。
 *
 * 每次 polish / cover-letter 调用前解析一次：
 * - BYOK：登录用户 + 已保存配置 + 可解密 → 新建 OpenAI 兼容 client
 *   （provider:'custom'，provenance 标注用户自配）。
 * - BYOK 存在但不可解密（密文损坏 / LLM_ENC_KEY 变更 / 加密钥缺失）→
 *   **fail-closed 503 LLM_BYOK_UNREADABLE**，不再静默回落内置：否则会把用户的
 *   简历/求职信内容发给平台内置供应商，且密钥轮换在日志里不可见。
 * - 内置（hub 模式，d.hubCatalog 非空）：凭证/目录都由 model-hub 投影下发，
 *   **hub 分配即授权**——任何登录用户只要投影里有文本模型即可用。
 * - 内置（本地模式，迁移期）：保留服务端 LLM_* env provider，仅
 *   `accounts.is_admin=1` 可用（由登录时按不可变身份白名单对账写入）。
 * - none：两端点按既有策略处理（polish 规则版 / cover-letter LLM_NOT_CONFIGURED）。
 */
import type { Context } from 'hono';
import {
  LlmCoverLetterProvider,
  LlmResumePolishProvider,
  OpenAICompatibleClient,
  decryptApiKey,
  type CoverLetterProvider,
  type MeteredResumePolishProvider,
} from '@jobagent/llm';
import { checkLlmEndpoint } from '../llm-endpoint-guard.js';
import { oneHourAgo } from '../demo-config.js';
import { describeError } from './helpers.js';
import type { RouteDeps } from './context.js';

/** 内置 LLM 账号配额超限（决策 #29）。前缀区分于 provider 错误码。 */
export const LLM_ACCOUNT_RATE_LIMITED = 'LLM_ACCOUNT_RATE_LIMITED';
/** 配额存储不可用时的 fail-closed 错误码（决策 #29 §6）。 */
export const LLM_QUOTA_UNAVAILABLE = 'LLM_QUOTA_UNAVAILABLE';
/** 已存 BYOK 配置无法解密时的 fail-closed 错误码（评审修复 3）。 */
export const LLM_BYOK_UNREADABLE = 'LLM_BYOK_UNREADABLE';

const RETRY_AFTER_SECONDS = 3600;

export type LlmSource = 'byok' | 'builtin' | 'none';
/** 解析成功时的失败原因；非 null 时调用点必须原样返回 503，不得降级。 */
export type LlmFailure = 'byok-unreadable' | null;

export interface ResolvedTextLlm {
  source: LlmSource;
  cover: CoverLetterProvider | null;
  // Metered 放宽（决策 #25 ④ Wave B）：调用点可注入 onUsage 观察者回采 token；
  // 既有的非 Metered 实现经方法双变仍可赋值（context.ts 的 builtin 注入不用动）。
  polish: MeteredResumePolishProvider | null;
  // hub 模式下投影模型的 assignmentId（供用量上报 /pub/v1/usage）；其余为 null。
  assignmentId: string | null;
  /** 不可降级的解析失败（目前只有 BYOK 不可解密）；调用点需返回 503。 */
  failure: LlmFailure;
}

function byokUnreadable(): ResolvedTextLlm {
  return { source: 'none', cover: null, polish: null, assignmentId: null, failure: 'byok-unreadable' };
}

/** 只记录错误类型，不记录 err.message/密文/密钥（避免敏感值进日志）。 */
function byokFailureReason(err: unknown): string {
  return err instanceof Error ? err.name || 'Error' : typeof err;
}

function warnByokUnreadable(accountId: string, reason: string): void {
  console.warn('[llm] byok unusable, failing closed', JSON.stringify({ accountId, reason }));
}

/** 统一的 503 响应；调用点在 `llm.failure` 非空时原样返回。 */
export function byokUnreadableResponse(c: Context): Response {
  return c.json(
    {
      error: 'saved LLM configuration cannot be decrypted; re-save it in account settings',
      code: LLM_BYOK_UNREADABLE,
    },
    503,
  );
}

export async function resolveTextLlm(c: Context, d: RouteDeps): Promise<ResolvedTextLlm> {
  const principal = c.get('principal');

  // 1) BYOK 优先。即使 LLM_ENC_KEY 缺失也要读配置：否则已存 BYOK 的用户会被
  // 静默切到内置供应商，且无法区分「没有 BYOK」与「BYOK 不可用」。
  if (principal.kind === 'user') {
    const cfg = await d.repos.userLlmConfigs.getByAccountId(principal.accountId);
    if (cfg && !checkLlmEndpoint(cfg.baseUrl).ok) {
      // 决策 #26：已存配置也可能是在修复前落库的坏地址——按无 BYOK 处理并回落，
      // 绝不把用户密文发往元数据/link-local。
      console.warn('[llm] byok baseUrl blocked by SSRF guard; falling back');
    } else if (cfg) {
      if (!d.llmEncKey) {
        warnByokUnreadable(principal.accountId, 'missing-encryption-key');
        return byokUnreadable();
      }
      try {
        const apiKey = decryptApiKey(cfg.apiKeyEncrypted, d.llmEncKey);
        const client = new OpenAICompatibleClient({
          baseUrl: cfg.baseUrl,
          apiKey,
          model: cfg.model,
          provider: 'custom',
        });
        return {
          source: 'byok',
          cover: new LlmCoverLetterProvider(client),
          polish: new LlmResumePolishProvider(client),
          assignmentId: null,
          failure: null,
        };
      } catch (err) {
        // 密文损坏 / LLM_ENC_KEY 变更：fail-closed，不回落内置。
        warnByokUnreadable(principal.accountId, byokFailureReason(err));
        return byokUnreadable();
      }
    }
  }

  // 2) 内置回落
  if (principal.kind === 'user') {
    // 2a) hub 模式：hub 分配即授权（任何登录用户），凭证来自 hub 投影。
    if (d.hubCatalog) {
      const builtin = await d.hubCatalog.resolveBuiltin();
      if (builtin) {
        return {
          source: 'builtin',
          cover: builtin.cover,
          polish: builtin.polish,
          assignmentId: builtin.model.assignmentId || null,
          failure: null,
        };
      }
    } else {
      // 2b) 本地模式（迁移期）：内置 LLM 由产品方（owner）付费，仅管理员账号可用。
      // 管理员资格由登录时基于不可变身份写入 accounts.is_admin（见 routes/auth.ts），
      // 这里读库而不是读 login env：可变 login 被再注册时无法接管，env 撤权也会生效。
      const account = await d.repos.accounts.getById(principal.accountId);
      if (account?.isAdmin && (d.coverLetterProvider || d.polishProvider)) {
        return {
          source: 'builtin',
          cover: d.coverLetterProvider,
          polish: d.polishProvider,
          assignmentId: null,
          failure: null,
        };
      }
    }
  }

  // 3) none
  return { source: 'none', cover: null, polish: null, assignmentId: null, failure: null };
}

/**
 * 内置 LLM 的账号级滑窗配额（决策 #29）：
 * - 仅 `source === 'builtin'` 计数，BYOK / none 直接放行（#21-4）；
 * - 主体为登录账号 accountId，求职信与润色共用 `llm-account` 单桶；
 * - 仓储层原子占位（`tryConsumeRateEvent`）：并发请求在同一 key 上串行，放行数不会
 *   超过上限；禁止退化为 count-then-insert；
 * - 存储故障 fail-closed（503），并留审计日志。
 *
 * 调用点必须在 `resolveTextLlm` 成功之后、真正发起 LLM 请求之前调用，
 * 且要把非 null 的 Response 原样返回（不要静默降级成规则版）。
 */
export async function enforceBuiltinLlmQuota(
  c: Context,
  d: RouteDeps,
  llm: ResolvedTextLlm,
): Promise<Response | null> {
  if (llm.source !== 'builtin') return null;
  const principal = c.get('principal');
  if (principal.kind !== 'user') return null;

  const nowIso = d.now();
  try {
    const granted = await d.repos.demoSessions.tryConsumeRateEvent(
      principal.accountId,
      'llm-account',
      oneHourAgo(nowIso),
      nowIso,
      d.llmQuota.accountRatePerHour,
    );
    if (!granted) {
      return c.json(
        {
          error: 'builtin LLM account rate limit exceeded',
          code: LLM_ACCOUNT_RATE_LIMITED,
          limitPerHour: d.llmQuota.accountRatePerHour,
          retryAfterSeconds: RETRY_AFTER_SECONDS,
        },
        429,
        { 'Retry-After': String(RETRY_AFTER_SECONDS) },
      );
    }
    return null;
  } catch (err) {
    console.error(
      '[llm] account quota check failed, failing closed:',
      JSON.stringify(describeError(err)),
    );
    return c.json(
      { error: 'LLM quota temporarily unavailable', code: LLM_QUOTA_UNAVAILABLE },
      503,
    );
  }
}
