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
import { LlmResponseError, type LlmClient } from './port.js';

/** prompt 模板版本：任何措辞/结构变更都 bump，写入 provenance.polish.promptVersion。 */
export const RESUME_POLISH_PROMPT_VERSION = 'resume-polish-0.1';

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

export class LlmResumePolishProvider implements ResumePolishProvider {
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

  async polish(input: { draft: ResumeDraft; posting: JobPosting; locale: ResumeLocale }): Promise<ResumePolishEdits> {
    const raw = await this.client.generateJson<unknown>({
      messages: [
        { role: 'system', content: systemPrompt(input.locale) },
        { role: 'user', content: userPrompt(input.draft, input.posting) },
      ],
      temperature: this.options.temperature ?? 0.3,
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
