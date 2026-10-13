/**
 * 把通用 {@link LlmClient} 适配为 resume-core 的 ResumePolishProvider（B 档，设计 §7）。
 *
 * 职责边界：本文件只负责「构造受约束 prompt → 取结构化 JSON → Zod 校验 → 转成
 * ResumePolishEdits」。真正的防臆造闸门（数字/条目/refs 不变、契约校验、整条回退）
 * 在 resume-core 的 polishResume 中；adapter 输出任何违规内容都会被安全层拒绝并回退。
 */
import { z } from 'zod';
import type { JobPosting, ResumeDraft, ResumeLocale } from '@jobagent/shared';
import type { ResumePolishEdits, ResumePolishProvider } from '@jobagent/resume-core';
import { LlmResponseError, type LlmClient, type LlmUsageObserver } from './port.js';

/** prompt 模板版本：任何措辞/结构变更都 bump，写入 provenance.polish.promptVersion。 */
export const RESUME_POLISH_PROMPT_VERSION = 'resume-polish-0.1';

/**
 * 可计量的润色输入（决策 #25 ④）：在 resume-core 基础输入上加可选的用量观察回调。
 * 不改 resume-core 的原因：依赖方向是 llm → resume-core，反向引用会成环；onUsage
 * 走本包自己的输入类型，经 TS 参数逆变仍与 ResumePolishProvider 接口兼容。
 */
export interface ResumePolishInput {
  draft: ResumeDraft;
  posting: JobPosting;
  locale: ResumeLocale;
  /** 可选的用量观察回调（计量埋点用）；成功调用恰好回调一次。 */
  onUsage?: LlmUsageObserver;
}

/**
 * 可计量的润色 provider：polish 接受 {@link ResumePolishInput}（比基础接口多一个可选
 * onUsage 字段）。计量调用点把依赖声明为本类型即可传 onUsage；既有的
 * ResumePolishProvider 实现经参数逆变同样可赋给本类型。
 */
export interface MeteredResumePolishProvider extends ResumePolishProvider {
  polish(input: ResumePolishInput): Promise<ResumePolishEdits>;
}

/** LLM 必须返回的 JSON 形状（多余字段剥离；非法整体抛错由安全层回退）。 */
const LlmPolishOutputSchema = z
  .object({
    summary: z.string().optional(),
    highlights: z
      .array(z.object({ index: z.number().int().nonnegative(), text: z.string().min(1) }))
      .optional(),
  })
  .strip();

function systemPrompt(locale: ResumeLocale): string {
  return [
    'You are a conservative resume copy editor for an evidence-backed hiring product.',
    'You receive a rule-generated resume draft and may ONLY polish wording.',
    '',
    'Hard constraints (violating any makes the output unusable):',
    '- Rewrite ONLY the "summary" and the provided evidence highlight sentences.',
    '- Do NOT add, remove, or reorder any entry, skill, bullet, link, or reference.',
    '- Do NOT introduce ANY new facts: no new numbers, dates, years, percentages, headcounts, metrics, company or product names.',
    '- Keep every existing number, skill name, and fact unchanged.',
    '- Keep the reader-facing language identical to the requested locale',
    locale === 'en'
      ? '  (write in English).'
      : '  (write in Simplified Chinese even though these instructions are in English).',
    '- Output STRICT JSON only, no markdown fences, with this shape:',
    '  {"summary": string (optional), "highlights": [{"index": number, "text": string}]}',
    '- Include a field only when you actually improve it; otherwise omit it.',
  ].join('\n');
}

function userPrompt(draft: ResumeDraft, posting: JobPosting): string {
  const highlights = draft.evidenceHighlights.map((h, index) => ({ index, text: h.text }));
  return JSON.stringify(
    {
      job: { title: posting.title, company: posting.company },
      summary: draft.summary,
      highlights,
    },
    null,
    2,
  );
}

export class LlmResumePolishProvider implements MeteredResumePolishProvider {
  readonly provider: string;
  readonly model: string;
  readonly promptVersion = RESUME_POLISH_PROMPT_VERSION;

  constructor(
    private readonly client: LlmClient,
    private readonly options: { temperature?: number } = {},
  ) {
    this.provider = client.provider;
    this.model = client.model;
  }

  async polish(input: ResumePolishInput): Promise<ResumePolishEdits> {
    const raw = await this.client.generateJson<unknown>({
      messages: [
        { role: 'system', content: systemPrompt(input.locale) },
        { role: 'user', content: userPrompt(input.draft, input.posting) },
      ],
      temperature: this.options.temperature ?? 0.3,
      onUsage: input.onUsage,
    });

    const parsed = LlmPolishOutputSchema.safeParse(raw);
    if (!parsed.success) {
      throw new LlmResponseError(`resume polish output failed schema validation: ${parsed.error.message}`);
    }

    const edits: ResumePolishEdits = {};
    if (parsed.data.summary !== undefined) edits.summary = parsed.data.summary;
    if (parsed.data.highlights && parsed.data.highlights.length > 0) {
      edits.highlightText = {};
      for (const h of parsed.data.highlights) {
        edits.highlightText[h.index] = h.text;
      }
    }
    return edits;
  }
}
