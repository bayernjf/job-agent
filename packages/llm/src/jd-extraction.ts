/**
 * 把通用 {@link LlmClient} 适配为求职 Agent C1「LLM 读 JD」结构化提取 provider
 * （设计 docs/设计-求职Agent-20261002.md §3.2 / §10 C1）。
 *
 * 职责边界：只做「受约束 prompt → 取结构化 JSON → Zod 校验」，产出的是**岗位侧事实**
 * （岗位要求什么），绝不评价候选人、不做匹配判断、不造画像侧事实。匹配分/档位永远由
 * agent-core 纯规则决定，本 provider 不参与打分。
 *
 * fail-closed：输出不合规形状会被 schema 拒绝并抛 {@link LlmResponseError}，由编排壳
 * （apps/api agent-runner）捕获后回落纯规则 MatchReport，绝不把残缺提取当完整结果。
 * 凭证只从服务端 LLM_* env 读；无 LLM_API_KEY → createJdExtractionProviderFromEnv 返回 null。
 */
import { JdInsightSchema, type JdInsight } from '@jobagent/shared';
import { LlmResponseError, type LlmClient } from './port.js';

/** prompt 模板版本：任何措辞/结构变更都 bump，便于追溯。 */
export const JD_EXTRACTION_PROMPT_VERSION = 'jd-extract-0.1';

/** 单条 JD 正文外发上限（字符），控制 token 预算，避免把整页 HTML 外发。 */
export const JD_DESCRIPTION_CHAR_LIMIT = 6000;

export interface JdExtractionProvider {
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
  /** 从职位标题+正文提取岗位侧要求；正文不足或无法提取时返回三类空数组的合法对象。 */
  extract(title: string, description: string): Promise<JdInsight>;
}

function systemPrompt(): string {
  return [
    'You are a conservative job-description parser for an evidence-backed job-matching product.',
    'You receive ONE job posting (title plus description text). Extract only what the job explicitly asks for.',
    '',
    'Hard constraints (violating any makes the output unusable):',
    '- Extract ONLY facts stated in the job posting. Do NOT invent requirements, tools, seniority, or credentials that are not written in the text.',
    '- Do NOT assess, score, or describe the candidate. Do NOT infer suitability. Output describes the job, never a person.',
    '- requiredSkills: concrete technologies, tools, languages, frameworks or hard skills explicitly required, as short noun phrases (e.g. "TypeScript", "PostgreSQL", "distributed systems"). At most 15.',
    '- qualifications: seniority, years of experience, degrees, certifications or other eligibility requirements, as short phrases. At most 10.',
    '- responsibilities: what the role will do, as short phrases starting with a verb. At most 10.',
    '- Deduplicate near-identical items; trim each item to a concise phrase, no full sentences, no bullets, no numbering.',
    '- If a category is not mentioned in the text, return an empty array for it. Do not guess.',
    '- Output STRICT JSON only, no markdown fences, with exactly this shape:',
    '  {"responsibilities": [string], "requiredSkills": [string], "qualifications": [string]}',
  ].join('\n');
}

export class LlmJdExtractionProvider implements JdExtractionProvider {
  readonly provider: string;
  readonly model: string;
  readonly promptVersion = JD_EXTRACTION_PROMPT_VERSION;

  constructor(
    private readonly client: LlmClient,
    private readonly options: { temperature?: number; descriptionCharLimit?: number } = {},
  ) {
    this.provider = client.provider;
    this.model = client.model;
  }

  async extract(title: string, description: string): Promise<JdInsight> {
    const limit = this.options.descriptionCharLimit ?? JD_DESCRIPTION_CHAR_LIMIT;
    const userPayload = JSON.stringify({
      title: title.slice(0, 200),
      description: description.slice(0, limit),
    });

    const raw = await this.client.generateJson<unknown>({
      messages: [
        { role: 'system', content: systemPrompt() },
        { role: 'user', content: userPayload },
      ],
      // 提取任务要求稳定、保守，低温度。
      temperature: this.options.temperature ?? 0.1,
    });

    const parsed = JdInsightSchema.safeParse(raw);
    if (!parsed.success) {
      throw new LlmResponseError(
        `JD extraction output failed schema validation: ${parsed.error.message}`,
      );
    }
    return parsed.data;
  }
}
