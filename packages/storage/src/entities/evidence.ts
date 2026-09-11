/**
 * evidence 实体：证据项索引的领域类型与纯映射（双方言共享）。
 */

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
