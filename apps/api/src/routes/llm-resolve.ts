/**
 * LLM 请求路由（decision #21，design-llm-model-provisioning-20261003 §4.3；
 * W5-1 接入 model-hub）：
 * **BYOK 优先 → 内置回落 → 功能既有策略（polish 规则版 / cover-letter 503）**。
 *
 * 每次 polish / cover-letter 调用前解析一次：
 * - BYOK：登录用户 + 已保存配置 + LLM_ENC_KEY 可用 → 新建 OpenAI 兼容 client
 *   （provider:'custom'，provenance 标注用户自配）；密文损坏/密钥变更按无 BYOK
 *   处理，回落内置（不静默产出垃圾）。
 * - 内置（hub 模式，d.hubCatalog 非空）：凭证/目录都由 model-hub 投影下发，
 *   **hub 分配即授权**——任何登录用户只要投影里有文本模型即可用（取代
 *   ADMIN_ACCOUNT_LOGINS 白名单）。
 * - 内置（本地模式，迁移期）：保留服务端 LLM_* env provider，仅白名单账号可用。
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

const RETRY_AFTER_SECONDS = 3600;

export type LlmSource = 'byok' | 'builtin' | 'none';

export interface ResolvedTextLlm {
  source: LlmSource;
  cover: CoverLetterProvider | null;
  // Metered 放宽（决策 #25 ④ Wave B）：调用点可注入 onUsage 观察者回采 token；
  // 既有的非 Metered 实现经方法双变仍可赋值（context.ts 的 builtin 注入不用动）。
  polish: MeteredResumePolishProvider | null;
  // hub 模式下投影模型的 assignmentId（供用量上报 /pub/v1/usage）；其余为 null。
  assignmentId: string | null;
}

export async function resolveTextLlm(c: Context, d: RouteDeps): Promise<ResolvedTextLlm> {
  const principal = c.get('principal');

  // 1) BYOK 优先
  if (principal.kind === 'user' && d.llmEncKey) {
    const cfg = await d.repos.userLlmConfigs.getByAccountId(principal.accountId);
    if (cfg && !checkLlmEndpoint(cfg.baseUrl).ok) {
      // 决策 #26：已存配置也可能是在修复前落库的坏地址——按无 BYOK 处理并回落，
      // 绝不把用户密文发往元数据/link-local。
      console.warn('[llm] byok baseUrl blocked by SSRF guard; falling back');
    } else if (cfg) {
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
        };
      } catch {
        // 密文损坏 / LLM_ENC_KEY 变更：按无 BYOK 处理，回落内置
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
        };
      }
    } else {
      // 2b) 本地模式（迁移期）：内置 LLM 由产品方（owner）付费，仅
      // ADMIN_ACCOUNT_LOGINS 白名单账号可用。
      const adminLogins = (process.env.ADMIN_ACCOUNT_LOGINS ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (adminLogins.includes(principal.login)) {
        if (d.coverLetterProvider || d.polishProvider) {
          return {
            source: 'builtin',
            cover: d.coverLetterProvider,
            polish: d.polishProvider,
            assignmentId: null,
          };
        }
      }
    }
  }

  // 3) none
  return { source: 'none', cover: null, polish: null, assignmentId: null };
}

/**
 * 内置 LLM 的账号级滑窗配额（决策 #29）：
 * - 仅 `source === 'builtin'` 计数，BYOK / none 直接放行（#21-4）；
 * - 主体为登录账号 accountId，求职信与润色共用 `llm-account` 单桶；
 * - 先 count 后 insert（与 demo 桶同口径，接受并发边缘小幅超额）；
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
    const recent = await d.repos.demoSessions.countRateEvents(
      principal.accountId,
      'llm-account',
      oneHourAgo(nowIso),
    );
    if (recent >= d.llmQuota.accountRatePerHour) {
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
    await d.repos.demoSessions.insertRateEvent(principal.accountId, 'llm-account', nowIso);
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
