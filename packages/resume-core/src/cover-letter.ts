import {
  COVER_LETTER_RULE_VERSION,
  CoverLetterDraftSchema,
  SCHEMA_VERSION,
  composeSkillDepthLabel,
  type AbilityProfile,
  type CoverLetterDraft,
  type CoverLetterParagraph,
  type EvidenceItem,
  type JobPosting,
  type ResumeLocale,
} from '@jobagent/shared';
import { aiAssistedDisclosure, coverLetterCopy, resumeCopy } from './i18n.js';
import { normalizeName, rankEvidence, rankSkills } from './rank.js';
import type { ResumeMatchInput } from './types.js';

/**
 * 求职信生成（阶段 1「改」的第二个交付物，设计 §3.3，规则版本见 COVER_LETTER_RULE_VERSION）。
 *
 * 硬约束与岗位定向简历完全一致（no-fabrication）：
 *  1. 每个断言画像事实的段落（match / evidence）必须挂至少一个 evidenceRef，且只引用画像已有事实；
 *  2. 技能名、深度、证据 claim、岗位/公司名保持原文，模板只提供连接词与礼貌用语；
 *  3. 没有命中技能、没有可回溯证据时**不产出该段**（宁缺勿编），而不是写一句空话；
 *  4. 出口 `CoverLetterDraftSchema.parse` 兜底，越界即抛错（不产出看似完整的交付物）。
 *
 * LLM 改写/润色沿用简历的 A/B 档模式，阶段 1 不做（设计 §8 开放问题 3：可选增强，不阻塞）。
 */

export interface BuildCoverLetterInput {
  profile: AbilityProfile;
  /** 画像证据全集（storage.listByProfile 或离线 JSON） */
  evidence: EvidenceItem[];
  posting: JobPosting;
  /** 与简历同一份匹配输入（调用方先用 matchJobs 算好），保证两件交付物口径一致 */
  match: ResumeMatchInput;
  options?: {
    locale?: ResumeLocale;
    /** 注入生成时间（测试确定性）；默认 new Date().toISOString() */
    now?: string;
  };
}

/** 匹配段最多列几个技能（求职信要短，不是技能清单） */
const MAX_MATCH_SKILLS = 4;

export function buildCoverLetter(input: BuildCoverLetterInput): CoverLetterDraft {
  const locale = input.options?.locale ?? 'zh-CN';
  const copy = coverLetterCopy(locale);
  const { profile, posting, match } = input;

  const hitScoreByName = new Map(
    match.skillHits.map((hit) => [normalizeName(hit.skill), hit.score] as const),
  );
  // 只有挂了证据的技能才能写进信里（与简历同一道闸）
  const evidencedSkills = profile.skillTags.filter((skill) => skill.evidenceRefs.length > 0);
  const { matched } = rankSkills(evidencedSkills, match.matchedSkills, hitScoreByName);

  const company = posting.company ?? '';
  const paragraphs: CoverLetterParagraph[] = [
    { code: 'opening', text: copy.opening(posting.title, company), evidenceRefs: [] },
  ];

  const topMatched = matched.slice(0, MAX_MATCH_SKILLS);
  if (topMatched.length > 0) {
    const skillText = topMatched
      .map((entry) => `${entry.skill.name}（${composeSkillDepthLabel(entry.skill.depth, locale)}）`)
      .join(locale === 'en' ? ', ' : '、');
    paragraphs.push({
      code: 'match',
      text: copy.matchLine(skillText),
      evidenceRefs: [
        ...new Set(topMatched.flatMap((entry) => entry.skill.evidenceRefs)),
      ],
    });
  }

  // 证据段：取排序后的第一条（支撑命中技能最多 → 证据强度 → 最新），整条 claim 原文照引
  const strongest = rankEvidence(input.evidence, topMatched.map((entry) => entry.skill), 1)[0];
  if (strongest) {
    paragraphs.push({
      code: 'evidence',
      text: copy.evidenceLine(strongest.item.claim, strongest.item.url),
      evidenceRefs: [strongest.item.evidenceId],
    });
  }

  paragraphs.push({ code: 'close', text: copy.close, evidenceRefs: [] });

  const displayName = profile.subject.displayName ?? profile.subject.login;
  const draft: CoverLetterDraft = {
    schemaVersion: SCHEMA_VERSION,
    ruleVersion: COVER_LETTER_RULE_VERSION,
    generatedAt: input.options?.now ?? new Date().toISOString(),
    locale,
    subject: {
      login: profile.subject.login,
      ...(profile.subject.displayName !== undefined ? { displayName: profile.subject.displayName } : {}),
      profileUrl: profile.subject.profileUrl,
    },
    targetJob: {
      jobId: posting.jobId,
      title: posting.title,
      company,
      sourceUrl: posting.sourceUrl,
    },
    greeting: copy.greeting(company),
    closing: copy.signature(displayName),
    paragraphs,
    provenance: {
      profileId: profile.profileId,
      analyzerVersion: profile.analyzerVersion,
      ruleVersion: COVER_LETTER_RULE_VERSION,
    },
    gaps: [],
    ...(profile.authenticity.status === 'insufficient_data' || profile.authenticity.status === 'suspicious'
      ? { dataQualityNote: resumeCopy(locale).dataQualityNote(profile.authenticity.status) }
      : {}),
  };

  return CoverLetterDraftSchema.parse(draft);
}

/**
 * 渲染 Markdown 求职信（交付物卫生 T12：不把匹配分/内部批注印进交付物）。
 * 事实文案已在草稿里按 locale 组好，渲染层不再拼句子。
 */
export function renderCoverLetterMarkdown(draft: CoverLetterDraft): string {
  const body = draft.paragraphs.map((p) => p.text).join('\n\n');
  // E1 决策 #20-4：固定 AI 辅助投递披露，招聘方可见，不可被省略。
  const disclosure = aiAssistedDisclosure(draft.locale);
  return `${draft.greeting}\n\n${body}\n\n${draft.closing}\n\n${disclosure}\n`;
}
