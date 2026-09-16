/**
 * evidence 实体：证据项索引的领域类型与纯映射（双方言共享）。
 */

import type { EvidenceItem } from '@jobagent/shared';

export interface StoredEvidence {
  id: string;
  profileId: string;
  sourcePlatform: string;
  sourceType: string;
  url: string;
  occurredAt: string | null;
  layer: string;
  claim: string;
  rawRef: string;
  createdAt: string;
}

export interface NewEvidence {
  id: string;
  profileId: string;
  sourcePlatform?: string;
  sourceType: string;
  url: string;
  occurredAt?: string | null;
  layer: string;
  claim: string;
  rawRef: string;
}

/** Drizzle 查询返回的原始行（camelCase），两方言结构一致 */
export interface RawEvidenceRow {
  id: string;
  profileId: string;
  sourcePlatform: string;
  sourceType: string;
  url: string;
  occurredAt: string | null;
  layer: string;
  claim: string;
  rawRef: string;
  createdAt: string;
}

export function toStoredEvidence(row: RawEvidenceRow): StoredEvidence {
  return {
    id: row.id,
    profileId: row.profileId,
    sourcePlatform: row.sourcePlatform,
    sourceType: row.sourceType,
    url: row.url,
    occurredAt: row.occurredAt,
    layer: row.layer,
    claim: row.claim,
    rawRef: row.rawRef,
    createdAt: row.createdAt,
  };
}

/**
 * StoredEvidence（库行）→ shared EvidenceItem（画像/简历内核消费的证据契约）。
 * 库行由 importFromProfile 写入时已经过 EvidenceItemSchema 校验，故此处只做结构映射：
 * id → evidenceId、profileId/createdAt 不落 EvidenceItem、occurredAt 的 null → undefined。
 */
export function toEvidenceItem(row: StoredEvidence): EvidenceItem {
  return {
    evidenceId: row.id,
    sourcePlatform: row.sourcePlatform,
    sourceType: row.sourceType as EvidenceItem['sourceType'],
    url: row.url,
    ...(row.occurredAt ? { occurredAt: row.occurredAt } : {}),
    layer: row.layer as EvidenceItem['layer'],
    claim: row.claim,
    rawRef: row.rawRef,
  };
}

/** 批量映射库行为 EvidenceItem[]（listByProfile 的便捷投影，供简历/画像装配复用）。 */
export function toEvidenceItems(rows: StoredEvidence[]): EvidenceItem[] {
  return rows.map(toEvidenceItem);
}
