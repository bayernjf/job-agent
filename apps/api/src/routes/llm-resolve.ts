/**
 * LLM 请求路由（decision #21，design-llm-model-provisioning-20261003 §4.3）：
 * **BYOK 优先 → 内置回落 → 功能既有策略（polish 规则版 / cover-letter 503）**。
 *
 * 每次 polish / cover-letter 调用前解析一次：
 * - BYOK：登录用户 + 已保存配置 + LLM_ENC_KEY 可用 → 新建 OpenAI 兼容 client
 *   （provider:'custom'，provenance 标注用户自配）；密文损坏/密钥变更按无 BYOK
 *   处理，回落内置（不静默产出垃圾）。
 * - 内置：服务端 LLM_* env 已配（createApp 已构造 provider；未配为 null）。
 *   目录的启停/默认由 admin 面管理（迁移 024），但运行面可用性以 env 为准——
 *   MVP 折中：admin 录入目录行属 P1 生产激活，代码默认目录兜底。
 * - none：两端点按既有策略处理（polish 规则版 / cover-letter LLM_NOT_CONFIGURED）。
 */
import type { Context } from 'hono';
import {
  LlmCoverLetterProvider,
  LlmResumePolishProvider,
  OpenAICompatibleClient,
  decryptApiKey,
  type CoverLetterProvider,
} from '@jobagent/llm';
import type { ResumePolishProvider } from '@jobagent/resume-core';
import type { RouteDeps } from './context.js';

export type LlmSource = 'byok' | 'builtin' | 'none';

export interface ResolvedTextLlm {
  source: LlmSource;
  cover: CoverLetterProvider | null;
  polish: ResumePolishProvider | null;
}

export async function resolveTextLlm(c: Context, d: RouteDeps): Promise<ResolvedTextLlm> {
  const principal = c.get('principal');

  // 1) BYOK 优先
  if (principal.kind === 'user' && d.llmEncKey) {
    const cfg = await d.repos.userLlmConfigs.getByAccountId(principal.accountId);
    if (cfg) {
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
        };
      } catch {
        // 密文损坏 / LLM_ENC_KEY 变更：按无 BYOK 处理，回落内置
      }
    }
  }

  // 2) 内置回落（cover / polish 各自独立：只配了 cover 时 cover 端点可用，反之亦然）
  if (d.coverLetterProvider || d.polishProvider) {
    return { source: 'builtin', cover: d.coverLetterProvider, polish: d.polishProvider };
  }

  // 3) none
  return { source: 'none', cover: null, polish: null };
}
