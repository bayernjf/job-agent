/**
 * buildResume：岗位定向简历唯一装配入口（纯函数、零 I/O、确定性）。
 *
 * 三铁律（设计文档 §0.2）：
 *  1. no-fabrication：profile 条目必带 evidenceRefs，画像外字段只来自 local 补填；
 *  2. 只选择/排序/模板组装，不改写画像事实；
 *  3. 输出经 ResumeDraftSchema 校验并带 provenance。
 */
import {
  composeHeadline,
  composePrSummary,
  composeSeniorityBand,
  headlineFactsFromProfile,
  matchScoreTier,
  prSummaryFactsFromProfile,
  RESUME_RULE_VERSION,
  ResumeDraftSchema,
  SCHEMA_VERSION,
  type AbilityProfile,
  type EvidenceItem,
  type LocalResumeFields,
  type ResumeDraft,
  type ResumeEntry,
  type ResumeLocale,
  type ResumeSuggestion,
  type SkillTag,
} from '@jobagent/shared';
import { resumeCopy } from './i18n.js';
import { normalizeName, rankEvidence, rankSkills } from './rank.js';
import { DEFAULT_HIGHLIGHT_LIMIT, type BuildResumeInput, type ResumeMatchInput } from './types.js';

/** 岗位标签里的通用词，不是技能，missing_skill 提示时过滤（保守，避免噪音） */
const NON_SKILL_TAGS = new Set([
  'remote',
  'hybrid',
  'onsite',
  'on-site',
  'full-time',
  'part-time',
  'contract',
  'internship',
  'intern',
  'visa',
  'visa-sponsorship',
  'senior',
  'junior',
  'mid-level',
  'entry-level',
]);

function skillToEntry(skill: SkillTag, supports: boolean): ResumeEntry {
  return {
    text: skill.name,
    evidenceRefs: [...skill.evidenceRefs],
    source: 'profile',
    supportsSkills: supports ? [skill.name] : [],
    kind: skill.kind,
    depth: skill.depth,
  };
}

/**
 * 协作一句话（T23）。快照里的 `prSummary` 是数据层英文原句，能取到 PR 计数就按读者语言
 * 现拼；取不到（旧快照没写 metrics）就退回原句 —— 宁可留一句英文，也不臆造数字。
 */
function collaborationSentence(profile: AbilityProfile, locale: ResumeLocale): string | undefined {
  const facts = prSummaryFactsFromProfile(profile);
  if (facts) return composePrSummary(facts, locale);
  return profile.collaboration.prSummary?.trim() || undefined;
}

function evidenceToEntry(ranked: { item: EvidenceItem; supportsSkills: string[] }): ResumeEntry {
  return {
    text: ranked.item.claim,
    evidenceRefs: [ranked.item.evidenceId],
    source: 'profile',
    url: ranked.item.url,
    occurredAt: ranked.item.occurredAt,
    supportsSkills: ranked.supportsSkills,
  };
}

/** 句末标点归一：缺则按语言补句号，避免英文片段与中文片段直接黏连 */
function ensureSentence(text: string, locale: ResumeLocale): string {
  const trimmed = text.trim();
  if (/[.。!?！？]$/.test(trimmed)) return trimmed;
  return locale === 'en' ? `${trimmed}.` : `${trimmed}。`;
}

/** summary：槽位全部来自画像/岗位/匹配，缺省片段省略，不写空、不造事实 */
function buildSummary(
  input: BuildResumeInput,
  topMatchedNames: string[],
  locale: ResumeLocale,
): string {
  const copy = resumeCopy(locale);
  const { profile, posting } = input;

  // 首句：headline 为干，seniority 以括号紧随（不另起碎句）
  const headline = composeHeadline(headlineFactsFromProfile(profile), locale);
  const seniority = profile.summary.seniorityHint?.band?.trim();
  const band = seniority ? composeSeniorityBand(seniority, locale) : '';
  const lead = band
    ? `${headline}${locale === 'en' ? ` (${band})` : `（${band}）`}`
    : headline;
  const sentences: string[] = [ensureSentence(lead, locale)];

  if (topMatchedNames.length > 0) {
    sentences.push(ensureSentence(copy.summaryTargeting(posting.title, posting.company, topMatchedNames.join(', ')), locale));
  }

  const mergedCount = profile.collaboration.externalMergedContributions?.length ?? 0;
  const collabPhrase = copy.collaborationPhrase(mergedCount);
  const prSentence = collabPhrase ? undefined : collaborationSentence(profile, locale);
  if (collabPhrase) sentences.push(ensureSentence(collabPhrase, locale));
  else if (prSentence) sentences.push(ensureSentence(prSentence, locale));

  // 各句自带句末标点；中文直接相连，英文以空格分隔
  return sentences.join(locale === 'en' ? ' ' : '');
}

function buildContact(local: LocalResumeFields | undefined, profileUrl: string): Record<string, string> {
  const contact: Record<string, string> = { profileUrl };
  if (local?.email) contact.email = local.email;
  if (local?.phone) contact.phone = local.phone;
  if (local?.location) contact.location = local.location;
  if (local?.personalSite) contact.personalSite = local.personalSite;
  if (local?.linkedinUrl) contact.linkedinUrl = local.linkedinUrl;
  return contact;
}

/** 岗位 tags 中画像不具备、且非通用词的，提示用户（只提示，不写进正文） */
function findMissingSkills(input: BuildResumeInput): string[] {
  const owned = new Set(input.profile.skillTags.map((s) => normalizeName(s.name)));
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const rawTag of input.posting.tags ?? []) {
    const tag = rawTag.trim();
    const norm = normalizeName(tag);
    if (!tag || NON_SKILL_TAGS.has(norm) || owned.has(norm) || seen.has(norm)) continue;
    seen.add(norm);
    missing.push(tag);
  }
  return missing;
}

export function buildResume(input: BuildResumeInput): ResumeDraft {
  const { profile, posting, match } = input;
  const locale: ResumeLocale = input.options?.locale ?? 'zh-CN';
  const highlightLimit = input.options?.highlightLimit ?? DEFAULT_HIGHLIGHT_LIMIT;
  const generatedAt = input.options?.now ?? new Date().toISOString();
  const copy = resumeCopy(locale);

  // 1) 技能定向排序
  // 简历正文只列可回溯（evidenceRefs 非空）的技能：技能条目同属 source:'profile'，
  // 契约强制 refs 非空（设计 §3 契约要点、§6 no-fabrication）。无证据的技能 tag 不臆造为
  // 简历陈述——简历是证据子集而非技能全集，完整技能仍在画像页展示。
  const evidencedSkills = profile.skillTags.filter((s) => s.evidenceRefs.length > 0);
  const hitScoreByName = new Map<string, number>(
    match.skillHits.map((h) => [normalizeName(h.skill), h.score]),
  );
  const ranked = rankSkills(evidencedSkills, match.matchedSkills, hitScoreByName);
  const matchedEntries = ranked.matched.map((r) => skillToEntry(r.skill, true));
  const otherEntries = ranked.other.map((r) => skillToEntry(r.skill, false));

  // 2) 证据亮点（只取支撑命中技能的证据）
  const matchedSkillTags = ranked.matched.map((r) => r.skill);
  const highlights = rankEvidence(input.evidence, matchedSkillTags, highlightLimit).map(evidenceToEntry);

  // 3) 协作强信号（外部 merged / prSummary），refs 挂 collaboration.evidenceRefs
  const collaboration: ResumeEntry[] = [];
  const collabRefs = profile.collaboration.evidenceRefs;
  for (const merged of profile.collaboration.externalMergedContributions ?? []) {
    collaboration.push({ text: merged, evidenceRefs: [...collabRefs], source: 'profile', supportsSkills: [] });
  }
  const prLine = collaborationSentence(profile, locale);
  if (prLine && collaboration.length === 0) {
    collaboration.push({
      text: prLine,
      evidenceRefs: [...collabRefs],
      source: 'profile',
      supportsSkills: [],
    });
  }

  // 4) 本地补填（source:'local'，允许 refs 为空）
  const education: ResumeEntry[] = (input.local?.education ?? []).map((e) => ({
    text: [e.degree, e.school, e.period].filter(Boolean).join(' · '),
    evidenceRefs: [],
    source: 'local',
    supportsSkills: [],
  }));
  const workHistory: ResumeEntry[] = (input.local?.workHistory ?? []).map((w) => ({
    text: [w.role, w.company, w.period].filter(Boolean).join(' · ') + (w.detail ? ` — ${w.detail}` : ''),
    evidenceRefs: [],
    source: 'local',
    supportsSkills: [],
  }));

  // 5) header / summary
  const name = input.local?.fullName?.trim() || profile.subject.displayName?.trim() || profile.subject.login;
  const contact = buildContact(input.local, profile.subject.profileUrl);
  const topMatchedNames = ranked.matched.slice(0, 3).map((r) => r.skill.name);
  const summary = buildSummary(input, topMatchedNames, locale);

  // 6) 匹配分档
  const tier = matchScoreTier(match.score, match.matchedSkills.length);

  // 7) suggestions / gaps（诚实边界）
  const suggestions: ResumeSuggestion[] = findMissingSkills(input).map((s) => ({
    kind: 'missing_skill' as const,
    text: copy.missingSkill(s),
  }));
  if (!input.local?.email) suggestions.push({ kind: 'missing_field' as const, text: copy.missingField(copy.gapContact) });
  if (education.length === 0) suggestions.push({ kind: 'missing_field' as const, text: copy.missingField(copy.gapField) });
  if (workHistory.length === 0) suggestions.push({ kind: 'missing_field' as const, text: copy.missingField(copy.gapWork) });
  if (tier === 'low') suggestions.push({ kind: 'low_match' as const, text: copy.lowMatch(tier, match.score) });

  const gaps: string[] = [];
  if (!input.local?.email) gaps.push(copy.gapContact);
  if (education.length === 0) gaps.push(copy.gapField);
  if (workHistory.length === 0) gaps.push(copy.gapWork);

  const draft = {
    schemaVersion: SCHEMA_VERSION,
    ruleVersion: RESUME_RULE_VERSION,
    generatedAt,
    subject: {
      login: profile.subject.login,
      displayName: profile.subject.displayName,
      profileUrl: profile.subject.profileUrl,
    },
    targetJob: {
      jobId: input.posting.jobId,
      title: posting.title,
      company: posting.company,
      sourceUrl: posting.sourceUrl,
      matchScore: match.score,
      tier,
      matchedSkills: [...match.matchedSkills],
      fieldScores: { ...match.fieldScores },
    },
    header: { name, headline: composeHeadline(headlineFactsFromProfile(profile), locale), contact },
    summary,
    matchedSkills: matchedEntries,
    otherSkills: otherEntries,
    evidenceHighlights: highlights,
    collaboration,
    localSections: { education, workHistory },
    suggestions,
    gaps,
    provenance: {
      profileId: profile.profileId,
      analyzerVersion: profile.analyzerVersion,
      ruleVersion: RESUME_RULE_VERSION,
    },
  };

  // 输出契约校验：任何 profile 条目缺 refs / 结构非法会在此抛错（测试与运行期双保险）
  return ResumeDraftSchema.parse(draft);
}

export type { ResumeMatchInput };
