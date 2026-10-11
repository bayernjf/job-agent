/**
 * 把通用 {@link LlmClient} 适配为 L3-B 语义摘要 provider。
 *
 * 职责边界：本文件只负责「构造受约束 prompt → 取结构化 JSON → Zod 校验」。
 * 防臆造纪律在 prompt 侧硬约束（只基于传入事实、禁止推断未给信息），
 * 输出任何不合规形状都会被 schema 拒绝并抛 {@link LlmResponseError}，
 * 由调用方（CLI）决定回落规则版（fail-closed，绝不把残缺输出当完整结果）。
 * 凭证只从服务端 LLM_* env 读；无 LLM_API_KEY → createSemanticProviderFromEnv 返回 null。
 */
import { z } from 'zod';
import type { L3SemanticInput } from '@jobagent/shared';
import { LlmResponseError, type LlmClient } from './port.js';

/** prompt 模板版本：任何措辞/结构变更都 bump，写入 provenance。 */
export const SEMANTIC_PROMPT_VERSION = 'semantic-0.1';

/** LLM 必须返回的 JSON 形状（多余字段剥离；非法整体抛错由调用方回落）。 */
const LlmSemanticOutputSchema = z
  .object({
    repoSummary: z.string().min(1).max(400),
    designDecisions: z.array(z.string().min(1).max(120)).max(6),
  })
  .strip();

/** L3-B 语义摘要（组装进 L3Signals.llmSummary，provider/model 由 provider 提供）。 */
export interface LlmSemanticSummary {
  repoSummary: string;
  designDecisions: string[];
}

export interface SemanticProvider {
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
  generate(input: L3SemanticInput): Promise<LlmSemanticSummary>;
}

/**
 * 输入裁剪：readme 只取前 1500 字符、文件树只取前 40 条、keyFiles 只传键名——
 * 控制单画像 token 预算，避免把采集原文整体外发。
 */
function compactInput(input: L3SemanticInput): unknown {
  return {
    login: input.login,
    repos: input.repos.map((r) => ({
      owner: r.owner,
      name: r.name,
      language: r.language,
      topics: r.topics,
      description: r.description,
      starred: r.starred,
      fileTree: r.fileTree.slice(0, 40),
      readmeExcerpt: r.readmeExcerpt.slice(0, 1500),
      keyFileNames: Object.keys(r.keyFiles),
      missing: r.missing,
    })),
  };
}

function systemPrompt(): string {
  return [
    'You are a conservative semantic analyst for an evidence-backed developer profile product.',
    'You receive public repository metadata and README excerpts. Produce a factual engineering summary.',
    '',
    'Hard constraints (violating any makes the output unusable):',
    '- Base EVERY statement only on the provided facts: repo names, description, language, topics, star count, file tree, README excerpt, key file names.',
    '- Do NOT invent facts: no technologies not named in the inputs, no companies, no dates, no metrics, no claimed achievements.',
    '- repoSummary: one concise sentence (under 60 words) describing the developer\u2019s most prominent engineering direction across the repos.',
    '- designDecisions: at most 6 short phrases (under 20 words each) about decisions that are directly evidenced by the file tree or README, each ending with " (evidence: <file or section>)" or omitted when no clear evidence.',
    '- Output STRICT JSON only, no markdown fences, with this shape:',
    '  {"repoSummary": string, "designDecisions": [string]}',
    '- If the evidence is too thin, still return valid JSON with a cautious repoSummary and an empty designDecisions array.',
  ].join('\n');
}

export class LlmSemanticProvider implements SemanticProvider {
  readonly provider: string;
  readonly model: string;
  readonly promptVersion = SEMANTIC_PROMPT_VERSION;

  constructor(
    private readonly client: LlmClient,
    private readonly options: { temperature?: number } = {},
  ) {
    this.provider = client.provider;
    this.model = client.model;
  }

  async generate(input: L3SemanticInput): Promise<LlmSemanticSummary> {
    const raw = await this.client.generateJson<unknown>({
      messages: [
        { role: 'system', content: systemPrompt() },
        { role: 'user', content: JSON.stringify(compactInput(input)) },
      ],
      temperature: this.options.temperature ?? 0.2,
    });

    const parsed = LlmSemanticOutputSchema.safeParse(raw);
    if (!parsed.success) {
      throw new LlmResponseError(
        `semantic summary output failed schema validation: ${parsed.error.message}`,
      );
    }
    return parsed.data;
  }
}
