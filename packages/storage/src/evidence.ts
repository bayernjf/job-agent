import { desc, eq, sql, and } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { EvidenceItem } from '@jobagent/shared';
import { evidence as evidenceTable, type EvidenceSelect } from './schema.js';

/**
 * evidence 仓储——证据项单独索引的唯一数据访问入口。
 *
 * 证据项同时存储在 profiles.snapshot JSON 中；本表提供单独索引用于
 * 按证据查询、跨画像关联、审计追溯（AGENTS.md「数据访问抽象层」硬约束）。
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

function toStoredEvidence(row: EvidenceSelect): StoredEvidence {
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

export class EvidenceRepository {
  constructor(private readonly db: BetterSQLite3Database) {}

  /** 插入单条证据 */
  insert(ev: NewEvidence): void {
    this.db
      .insert(evidenceTable)
      .values({
        id: ev.id,
        profileId: ev.profileId,
        sourcePlatform: ev.sourcePlatform ?? 'github',
        sourceType: ev.sourceType,
        url: ev.url,
        occurredAt: ev.occurredAt ?? null,
        layer: ev.layer,
        claim: ev.claim,
        rawRef: ev.rawRef,
      })
      .run();
  }

  /** 批量插入证据（事务，用于画像生成时一次性写入所有证据） */
  insertBatch(evidence: NewEvidence[]): void {
    if (evidence.length === 0) return;
    this.db.transaction((tx) => {
      for (const ev of evidence) {
        tx.insert(evidenceTable).values({
          id: ev.id,
          profileId: ev.profileId,
          sourcePlatform: ev.sourcePlatform ?? 'github',
          sourceType: ev.sourceType,
          url: ev.url,
          occurredAt: ev.occurredAt ?? null,
          layer: ev.layer,
          claim: ev.claim,
          rawRef: ev.rawRef,
        }).run();
      }
    });
  }

  /** 从 AbilityProfile 的 EvidenceItem 列表批量导入（转换为存储格式） */
  importFromProfile(profileId: string, items: EvidenceItem[]): void {
    const evidence: NewEvidence[] = items.map((item) => ({
      id: item.evidenceId,
      profileId,
      sourcePlatform: item.sourcePlatform,
      sourceType: item.sourceType,
      url: item.url,
      occurredAt: item.occurredAt ?? null,
      layer: item.layer,
      claim: item.claim,
      rawRef: item.rawRef,
    }));
    this.insertBatch(evidence);
  }

  /** 按 ID 查询单条证据 */
  getById(id: string): StoredEvidence | undefined {
    const row = this.db.select().from(evidenceTable).where(eq(evidenceTable.id, id)).get();
    return row ? toStoredEvidence(row) : undefined;
  }

  /** 按画像 ID 查询所有证据（按创建时间倒序） */
  listByProfile(profileId: string): StoredEvidence[] {
    const rows = this.db
      .select()
      .from(evidenceTable)
      .where(eq(evidenceTable.profileId, profileId))
      .orderBy(desc(evidenceTable.createdAt))
      .all();
    return rows.map(toStoredEvidence);
  }

  /** 按来源平台+类型查询（跨画像关联） */
  listBySource(sourcePlatform: string, sourceType: string, limit = 100): StoredEvidence[] {
    const rows = this.db
      .select()
      .from(evidenceTable)
      .where(and(eq(evidenceTable.sourcePlatform, sourcePlatform), eq(evidenceTable.sourceType, sourceType)))
      .orderBy(desc(evidenceTable.createdAt))
      .limit(limit)
      .all();
    return rows.map(toStoredEvidence);
  }

  /** 统计某画像的证据数量 */
  countByProfile(profileId: string): number {
    const result = this.db
      .select({ count: sql<number>`count(*)` })
      .from(evidenceTable)
      .where(eq(evidenceTable.profileId, profileId))
      .get();
    return result ? Number(result.count) : 0;
  }
}
