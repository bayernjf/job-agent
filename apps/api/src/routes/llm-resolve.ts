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
import type { RouteDeps } from './context.js';

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
