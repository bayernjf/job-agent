/**
 * polishResume：B 档 LLM 受约束润色的**纯函数安全层**（设计 §7）。
 *
 * 分层：本模块不发任何网络请求、不依赖具体 LLM SDK。LLM 调用由注入的
 * {@link ResumePolishProvider} 完成（端口在 packages/llm，测试用 fake）；
 * 本模块只负责把 provider 的编辑安全地应用到规则版 ResumeDraft 上，并强制执行
 * §7 硬约束：
 *  1. 只允许改写 `summary` 与 `evidenceHighlights[].text` 的措辞；
 *  2. 不得新增/删除条目、不得改 evidenceRefs / 技能 / 数字；
 *  3. 润色结果重跑 Zod 契约 + 数字防臆造闸门，任一违例**整条回退规则版**；
 *  4. 通过则在 provenance.polish 记录 provider/model/promptVersion/appliedAt，可复现。
 *
 * 数字是简历臆造的最高危载体（年限、规模、百分比、年份），故对数字 token 做
 * "新文本数字 ⊆ 规则版草稿已出现数字" 的硬闸门。自然语言里的"新增技能名"难以
 * 无副作用地穷举判定，交给 prompt 约束 + 评审，不做会误伤正常措辞的硬匹配。
 */
import {
  ResumeDraftSchema,
  type JobPosting,
  type ResumeDraft,
  type ResumeLocale,
  type ResumePolishProvenance,
} from '@jobagent/shared';

/** provider 产出的受约束编辑：仅 summary 与证据亮点文本，其余字段一律不接受。 */
export interface ResumePolishEdits {
  /** 改写后的岗位定向概述；省略/非法则保留规则版原文。 */
  summary?: string;
  /** 按 evidenceHighlights 下标的逐条改写，缺省下标保留原文；不得改变条目数量。 */
  highlightText?: Record<number, string>;
}

/** LLM 润色端口（实现见 packages/llm；纯函数层只依赖此接口）。 */
export interface ResumePolishProvider {
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
  polish(input: { draft: ResumeDraft; posting: JobPosting; locale: ResumeLocale }): Promise<ResumePolishEdits>;
}

export type PolishSkipReason = 'provider_error' | 'validation_failed' | 'fabrication_detected';

export interface PolishResult {
  /** 润色通过则为新草稿，否则为原规则版草稿（引用不变）。 */
  draft: ResumeDraft;
  applied: boolean;
  /** 未应用时的原因，供调用方记录/埋点。 */
  reason?: PolishSkipReason;
}

const MAX_SUMMARY_CHARS = 1000;
const MAX_HIGHLIGHT_CHARS = 400;

/** 抽取数字 token（年份、整数、千分位、小数），归一化去逗号后比较。 */
function numberTokens(text: string): Set<string> {
  const out = new Set<string>();
  const re = /\d[\d,]*(?:\.\d+)?/g;
  for (const m of text.matchAll(re)) {
    out.add(m[0].replace(/,/g, ''));
  }
  return out;
}

/** 规则版草稿全文数字池：润色只允许复用这些既存数字，不得引入新数字。 */
function draftNumberPool(draft: ResumeDraft): Set<string> {
  const parts: string[] = [
    draft.summary,
    ...draft.matchedSkills,
    ...draft.otherSkills,
    ...draft.evidenceHighlights,
    ...draft.collaboration,
    ...draft.localSections.education,
    ...draft.localSections.workHistory,
  ].map((e) => (typeof e === 'string' ? e : e.text));
  return numberTokens(parts.join(' '));
}

function withinLength(text: string | undefined, max: number): text is string {
  return !!text && text.trim().length > 0 && text.trim().length <= max;
}

/**
 * 应用受约束润色。确定性：同样的 provider 响应得到同样结果；不做 I/O。
 * @param now 可注入时间戳（测试固定），默认当前 UTC。
 */
export async function polishResume(
  draft: ResumeDraft,
  posting: JobPosting,
  provider: ResumePolishProvider,
  options: { locale?: ResumeLocale; now?: string } = {},
): Promise<PolishResult> {
  const locale = options.locale ?? 'zh-CN';

  let edits: ResumePolishEdits;
  try {
    edits = await provider.polish({ draft, posting, locale });
  } catch {
    return { draft, applied: false, reason: 'provider_error' };
  }

  // ── 形状与长度校验（非法编辑直接回退，不做局部采纳）──
  const newSummary = edits.summary === undefined ? draft.summary : edits.summary;
  if (!withinLength(newSummary, MAX_SUMMARY_CHARS)) {
    return { draft, applied: false, reason: 'validation_failed' };
  }

  const highlightCount = draft.evidenceHighlights.length;
  const textByIndex = new Map<number, string>();
  if (edits.highlightText) {
    for (const [rawKey, text] of Object.entries(edits.highlightText)) {
      const idx = Number(rawKey);
      if (!Number.isInteger(idx) || idx < 0 || idx >= highlightCount) {
        return { draft, applied: false, reason: 'validation_failed' };
      }
      if (!withinLength(text, MAX_HIGHLIGHT_CHARS)) {
        return { draft, applied: false, reason: 'validation_failed' };
      }
      textByIndex.set(idx, text.trim());
    }
  }

  // ── 构造候选草稿：深拷贝，仅替换 summary 与指定 highlight.text，其余字段保持同一来源 ──
  const candidate: ResumeDraft = structuredClone(draft);
  candidate.summary = newSummary.trim();
  for (const [idx, text] of textByIndex) {
    const entry = candidate.evidenceHighlights[idx];
    if (!entry) return { draft, applied: false, reason: 'validation_failed' };
    entry.text = text;
  }

  // ── 数字防臆造闸门：新 summary / 被改写亮点的数字必须已存在于规则版草稿 ──
  const allowed = draftNumberPool(draft);
  const changedTexts: string[] = [candidate.summary];
  for (const idx of textByIndex.keys()) changedTexts.push(candidate.evidenceHighlights[idx]!.text);
  for (const token of numberTokens(changedTexts.join(' '))) {
    if (!allowed.has(token)) {
      return { draft, applied: false, reason: 'fabrication_detected' };
    }
  }

  // ── 契约校验（含 source:profile 条目 refs 非空等全部不变量）──
  const parsed = ResumeDraftSchema.safeParse({
    ...candidate,
    provenance: {
      ...candidate.provenance,
      polish: {
        provider: provider.provider,
        model: provider.model,
        promptVersion: provider.promptVersion,
        appliedAt: options.now ?? new Date().toISOString(),
      } satisfies ResumePolishProvenance,
    },
  });
  if (!parsed.success) {
    return { draft, applied: false, reason: 'validation_failed' };
  }

  return { draft: parsed.data, applied: true };
}
