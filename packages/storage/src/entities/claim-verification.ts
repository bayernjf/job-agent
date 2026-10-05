/**
 * claim_verifications 实体：一条"简历声明"的核验结论（决策 #23，2026-10-05）。
 *
 * 与方言无关的领域类型 + 纯映射逻辑（sqlite/postgres 两套仓储共享）。
 *
 * 三条必须写在这里的口径，因为它们决定了这行数据的语义：
 * - 这是**画像之上一层**：核验结论绝不回写画像快照，本表只存结论本身与证据指针。
 * - `verdict` 与 `ruleVersion` 是这一层自己的版本体系，与画像的 `RULE_VERSION` 解耦。
 * - `matchedEvidenceRefs` 是 evidence id 数组（**JSON 文本存储**），`no_trace` 与
 *   `insufficient_data` 必须是空数组——"没有证据"与"有证据"的区别就在这列上。
 */
import {
  CLAIM_RULE_VERSION,
  type ClaimAssessment,
  type ClaimSource,
  type ClaimVerdict,
} from '@jobagent/claim-core';
import type { SupportedPlatform } from '@jobagent/shared';

export type { ClaimSource, ClaimVerdict };

export interface StoredClaimVerification {
  id: string;
  /** 被核验的画像快照 id；按设计 §4 可空（声明可能先于画像存在） */
  profileId: string | null;
  subjectPlatform: SupportedPlatform;
  subjectLogin: string;
  /** 数据层原文（英文优先）：必须是用户原话，不得被渲染层改写 */
  claimText: string;
  claimSource: ClaimSource;
  /** 来源文档内的定位（页/条目），手工填写时为 null */
  claimRef: string | null;
  verdict: ClaimVerdict;
  /** 支撑该结论的 evidence id；no_trace / insufficient_data 时为空数组 */
  matchedEvidenceRefs: string[];
  /** 支撑强度 0..1，非"造假概率"；supportable/partial 之外为 null */
  confidence: number | null;
  /** 发起核验的 accounts.id；匿名路径为 null */
  verifierAccountId: string | null;
  ruleVersion: string;
  createdAt: string;
  updatedAt: string;
}

export interface NewClaimVerification {
  id: string;
  profileId: string | null;
  subjectPlatform: SupportedPlatform;
  subjectLogin: string;
  claimText: string;
  claimSource?: ClaimSource;
  claimRef?: string | null;
  verdict: ClaimVerdict;
  matchedEvidenceRefs?: string[];
  confidence?: number | null;
  verifierAccountId?: string | null;
  ruleVersion?: string;
}

/** Drizzle 查询返回的原始行（camelCase），两方言结构一致 */
export interface RawClaimVerificationRow {
  id: string;
  profileId: string | null;
  subjectPlatform: string;
  subjectLogin: string;
  claimText: string;
  claimSource: string;
  claimRef: string | null;
  verdict: string;
  matchedEvidenceRefs: string;
  confidence: number | null;
  verifierAccountId: string | null;
  ruleVersion: string;
  createdAt: string;
  updatedAt: string;
}

const CLAIM_VERDICTS = ['supportable', 'partial', 'no_trace', 'insufficient_data'] as const;
const CLAIM_SOURCES = ['manual', 'resume_import'] as const;

/** 坏数据兜底：宁可按"无法核验"读出来，也不要让它被当成"有些证据" */
export function toStoredClaimVerification(row: RawClaimVerificationRow): StoredClaimVerification {
  const verdict = (CLAIM_VERDICTS as readonly string[]).includes(row.verdict)
    ? (row.verdict as ClaimVerdict)
    : 'insufficient_data';
  const claimSource = (CLAIM_SOURCES as readonly string[]).includes(row.claimSource)
    ? (row.claimSource as ClaimSource)
    : 'manual';
  return {
    id: row.id,
    profileId: row.profileId,
    subjectPlatform: row.subjectPlatform === 'gitee' ? 'gitee' : 'github',
    subjectLogin: row.subjectLogin,
    claimText: row.claimText,
    claimSource,
    claimRef: row.claimRef,
    verdict,
    matchedEvidenceRefs: parseEvidenceRefs(row.matchedEvidenceRefs),
    confidence: row.confidence,
    verifierAccountId: row.verifierAccountId,
    ruleVersion: row.ruleVersion || CLAIM_RULE_VERSION,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** JSON 数组解析：坏格式按空数组处理（＝没有证据），绝不抛也不编造 */
function parseEvidenceRefs(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string' && v.length > 0);
  } catch {
    return [];
  }
}

/** 由内核给的判定装配待落库的行——业务层不必自己拼列名 */
export function newClaimVerificationFromAssessment(
  base: Omit<NewClaimVerification, 'verdict' | 'matchedEvidenceRefs' | 'confidence'> & {
    assessment: ClaimAssessment;
  },
): NewClaimVerification {
  const { assessment, ...rest } = base;
  return {
    ...rest,
    verdict: assessment.verdict,
    matchedEvidenceRefs: assessment.evidenceIds,
    confidence: assessment.confidence,
    ruleVersion: assessment.ruleVersion,
  };
}
