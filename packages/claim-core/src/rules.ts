/**
 * 判定规则：一条声明 ↔ 一份画像证据的大小关系（design-claim-verification §5）。
 *
 * 纯函数、无 I/O——证据行由调用方读库后传进来，本层不知道 SQLite/Postgres/HTTP 的存在。
 *
 * 三条永不违反的口径：
 * 1. **无证据不下结论**。任何 `supportable`/`partial` 都必须有真实存在的证据 id 撑着；
 *    证据列表为空＝没查过，判 `insufficient_data` 而不是 `no_trace`。
 * 2. **抽不出可核验 token 就判 `insufficient_data`，绝不判 `no_trace`**。"优秀的沟通能力"
 *    不是造假，是我们没法核验；这两者的区别是产品的立身之本。
 * 3. **`no_trace` 只在"有明确可核验 token 且画像里确凿没有"时给出**，且对外措辞必须是
 *    "本工具未观察到"，永远不说"没做过"。
 */
import { extractSkillTokens } from '@jobagent/shared';
import type { ClaimAssessment, ClaimEvidence, ClaimInput, ClaimProfileFacts } from './types.js';
import { CLAIM_RULE_VERSION } from './version.js';

/**
 * 判定为 `supportable` 所需的最少**去重**证据条数。
 * 1 条只够说"见过"，不够说"支撑得起"——这是 `partial` 与 `supportable` 的分界线。
 */
export const SUPPORTABLE_MIN_EVIDENCE = 2;

/** 一次核验的输入：声明 + 画像事实 + 可供回溯的证据行（三者缺一不可） */
export interface AssessClaimInput {
  claim: ClaimInput;
  profile: ClaimProfileFacts;
  evidence: ClaimEvidence[];
}

/**
 * 声明里**写死**的指针：完整 URL 或 `owner/repo/pull/123` 形态。
 *
 * 刻意不接受孤立的 `#123` / "PR #42"：没有仓库信息就无法判定它说的是哪个仓库的那一条，
 * 强行匹配会在别人的仓库里碰巧撞出同名数字。宁可让它走 token 规则得出 `insufficient_data`，
 * 也不制造一个看起来很确定的 `supportable`。
 */
const EXPLICIT_REF = /\b(?:https?:\/\/)?(?:[\w-]+\.)?(?:github|gitee)\.com\/[\w.-]+\/[\w.-]+\/(?:pull|pulls|issue|issues|commit)\/[\w-]+\/?/gi;

/** 去掉协议/主机/www/尾斜杠，只留下可比较的路径部分 */
function comparablePath(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '') // 必须早于剥主机：否则 "www.github.com/..." 的主机名匹配不上
    .replace(/^[\w-]+\.(?:com|cn|org)\//, '')
    .replace(/\/+$/, '');
}

/** 抽出显式指针（去重、保序） */
function extractExplicitRefs(text: string): string[] {
  const hits = text.match(EXPLICIT_REF) ?? [];
  return [...new Set(hits.map((h) => h.trim()))];
}

/** 证据行是否在讲某个 token：与 stopword 口径一致地复用同一套词典，避免两处词典不同步 */
function evidenceMentionsToken(claimOfEvidence: string, canonical: string): boolean {
  return extractSkillTokens(claimOfEvidence).some((t) => t.canonical === canonical);
}

/**
 * 核验一条声明。
 *
 * 只读 `profile`，返回全新对象——**画像快照逐字节不变**是设计 §8 的验收项之一，
 * 这里的每一行代码都不能往 profile 上写东西。
 */
export function assessClaim(input: AssessClaimInput): ClaimAssessment {
  const { claim, profile, evidence } = input;
  const requiredEvidenceCount = SUPPORTABLE_MIN_EVIDENCE;
  const baseFacts = { requiredEvidenceCount };

  // ---- 规则 1：显式指针直接查证据 ----
  const explicitRefs = extractExplicitRefs(claim.text);
  if (explicitRefs.length > 0) {
    const matched: string[] = [];
    for (const evidenceItem of evidence) {
      const target = comparablePath(evidenceItem.url);
      const hit = explicitRefs.some((pointer) => comparablePath(pointer) === target);
      if (hit) matched.push(evidenceItem.evidenceId);
    }
    const unique = [...new Set(matched)];
    if (unique.length > 0) {
      return {
        claimId: claim.id,
        verdict: 'supportable',
        code: 'explicit_ref_hit',
        confidence: 1,
        evidenceIds: unique,
        facts: {
          ...baseFacts,
          tokens: [],
          skillTagNames: [],
          explicitRefs,
          evidenceCount: unique.length,
        },
        ruleVersion: CLAIM_RULE_VERSION,
      };
    }
  }

  // ---- 规则 2/3：按词典抽可核验 token ----
  const tokens = extractSkillTokens(claim.text);
  const tokenNames = tokens.map((t) => t.canonical);

  // 规则 3：抽不出任何一个可核验 token —— 不是"没做过"，是我们无法核验。
  if (tokens.length === 0) {
    return {
      claimId: claim.id,
      verdict: 'insufficient_data',
      code: 'no_checkable_token',
      confidence: null,
      evidenceIds: [],
      facts: { ...baseFacts, tokens: [], skillTagNames: [], explicitRefs, evidenceCount: 0 },
      ruleVersion: CLAIM_RULE_VERSION,
    };
  }

  // 没有证据行＝压根没查过，此时说 "no_trace" 是在编造结论。
  if (evidence.length === 0) {
    return {
      claimId: claim.id,
      verdict: 'insufficient_data',
      code: 'no_checkable_token',
      confidence: null,
      evidenceIds: [],
      facts: { ...baseFacts, tokens: tokenNames, skillTagNames: [], explicitRefs, evidenceCount: 0 },
      ruleVersion: CLAIM_RULE_VERSION,
    };
  }

  const evidenceById = new Map(evidence.map((e) => [e.evidenceId, e]));
  const resolved = new Set<string>();
  const skillTagNames: string[] = [];

  for (const token of tokens) {
    const tag = profile.skillTags.find(
      (t) => t.name.toLowerCase() === token.canonical.toLowerCase(),
    );
    if (tag) {
      skillTagNames.push(tag.name);
      for (const ref of tag.evidenceRefs) {
        // 只认真实存在的证据 id：画像里指向不存在的 ref 不能拿来撑结论。
        if (evidenceById.has(ref)) resolved.add(ref);
      }
    }
    for (const evidenceItem of evidence) {
      if (evidenceMentionsToken(evidenceItem.claim, token.canonical)) {
        resolved.add(evidenceItem.evidenceId);
      }
    }
  }

  const evidenceIds = [...resolved];
  const evidenceCount = evidenceIds.length;

  if (evidenceCount >= requiredEvidenceCount) {
    return {
      claimId: claim.id,
      verdict: 'supportable',
      code: 'token_skill_tag',
      confidence: Math.min(1, evidenceCount / requiredEvidenceCount),
      evidenceIds,
      facts: { ...baseFacts, tokens: tokenNames, skillTagNames, explicitRefs, evidenceCount },
      ruleVersion: CLAIM_RULE_VERSION,
    };
  }
  if (evidenceCount === 1) {
    return {
      claimId: claim.id,
      verdict: 'partial',
      code: 'token_weak_support',
      confidence: evidenceCount / requiredEvidenceCount,
      evidenceIds,
      facts: { ...baseFacts, tokens: tokenNames, skillTagNames, explicitRefs, evidenceCount },
      ruleVersion: CLAIM_RULE_VERSION,
    };
  }
  // 规则 4：有可核验 token、也确有证据数据可查，但一条都没对上。
  return {
    claimId: claim.id,
    verdict: 'no_trace',
    code: 'no_matching_evidence',
    confidence: null,
    evidenceIds: [],
    facts: { ...baseFacts, tokens: tokenNames, skillTagNames, explicitRefs, evidenceCount: 0 },
    ruleVersion: CLAIM_RULE_VERSION,
  };
}
