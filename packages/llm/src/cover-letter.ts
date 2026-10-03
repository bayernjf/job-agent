/**
 * 求职信生成（A 档，2026-10-03）：把通用 {@link LlmClient} 适配为 CoverLetterProvider。
 *
 * 与 resume-polish 的差异：求职信是**生成性 prose**（全新文本，不是改措辞），
 * 因此没有 resume-core 的契约级防臆造闸。防臆造依赖三层：
 *  1. prompt 硬约束——只允许引用 draft/posting 中已出现的事实，严禁新增数字/
 *     日期/公司/产品/技能名，不得提及"我缺乏…"式自贬；
 *  2. 输出 schema——非空、长度上限，防 runaway；
 *  3. 用户复核——产物是用户主动请求并人工过目后再使用。
 * 任何违规/失败抛 LlmResponseError，由 API 层如实标注（不降级为模板填充的
 * "伪求职信"，与"禁止输出看似完整的报告"口径一致）。
 */
import { z } from 'zod';
import type { JobPosting, ResumeDraft, ResumeLocale } from '@jobagent/shared';
import { LlmResponseError, type LlmClient } from './port.js';

/** prompt 模板版本：任何措辞/结构变更都 bump，随产物回传。 */
export const COVER_LETTER_PROMPT_VERSION = 'cover-letter-0.1';

export interface CoverLetterOutput {
  /** 可选邮件主题（提交求职信时可直接作为 subject 行） */
  subject?: string;
  /** 求职信正文（含称呼与结尾，用户可自行署名） */
  body: string;
}

export interface CoverLetterProvider {
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
  generate(input: {
    draft: ResumeDraft;
    posting: JobPosting;
    locale: ResumeLocale;
  }): Promise<CoverLetterOutput>;
}

/** LLM 必须返回的 JSON 形状（多余字段剥离；非法整体抛错，由 API 层如实标注）。 */
const LlmCoverLetterOutputSchema = z
  .object({
    subject: z.string().min(1).max(120).optional(),
    body: z.string().min(10).max(4000),
  })
  .strip();

function systemPrompt(locale: ResumeLocale): string {
  return [
    'You are a job-application letter writer for an evidence-backed hiring product.',
    'You receive a candidate resume draft (facts only, evidence-backed) and a target job posting.',
    'Write one cover letter from this candidate to this job.',
    '',
    'Hard constraints (violating any makes the output unusable):',
    '- Use ONLY facts that already appear in the resume draft or the job posting.',
    '- Do NOT invent or assume ANY fact: no new numbers, dates, years, percentages,',
    '  headcounts, metrics, company names, product names, or skills not in the draft.',
    '- Do NOT mention the absence of anything (no "although I lack...", "I have no ...").',
    '- Do NOT overstate: no superlatives like "world-class", "expert in everything".',
    '- Keep it concise: at most 220 words (English) / 380 characters (Simplified Chinese).',
    '- Keep the reader-facing language identical to the requested locale',
    locale === 'en'
      ? '  (write in English).'
      : '  (write in Simplified Chinese even though these instructions are in English).',
    '- Output STRICT JSON only, no markdown fences, with this shape:',
    '  {"subject": string (optional, short email subject line), "body": string}',
  ].join('\n');
}

function userPrompt(draft: ResumeDraft, posting: JobPosting): string {
  const skills = [...draft.matchedSkills, ...draft.otherSkills].map((s) => s.text);
  return JSON.stringify(
    {
      job: {
        title: posting.title,
        company: posting.company,
        description: posting.description?.slice(0, 2500),
      },
      candidate: {
        headline: draft.header.headline,
        summary: draft.summary,
        highlights: draft.evidenceHighlights.map((h) => h.text),
        skills,
      },
    },
    null,
    2,
  );
}

export class LlmCoverLetterProvider implements CoverLetterProvider {
  readonly provider: string;
  readonly model: string;
  readonly promptVersion = COVER_LETTER_PROMPT_VERSION;

  constructor(
    private readonly client: LlmClient,
    private readonly options: { temperature?: number } = {},
  ) {
    this.provider = client.provider;
    this.model = client.model;
  }

  async generate(input: {
    draft: ResumeDraft;
    posting: JobPosting;
    locale: ResumeLocale;
  }): Promise<CoverLetterOutput> {
    const raw = await this.client.generateJson<unknown>({
      messages: [
        { role: 'system', content: systemPrompt(input.locale) },
        { role: 'user', content: userPrompt(input.draft, input.posting) },
      ],
      temperature: this.options.temperature ?? 0.4,
    });

    const parsed = LlmCoverLetterOutputSchema.safeParse(raw);
    if (!parsed.success) {
      throw new LlmResponseError(
        `cover letter output failed schema validation: ${parsed.error.message}`,
      );
    }

    const out: CoverLetterOutput = { body: parsed.data.body };
    if (parsed.data.subject !== undefined) out.subject = parsed.data.subject;
    return out;
  }
}
