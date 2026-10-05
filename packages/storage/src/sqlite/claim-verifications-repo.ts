import { asc, eq, inArray, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { CLAIM_RULE_VERSION } from '@jobagent/claim-core';
import {
  toStoredClaimVerification,
  type NewClaimVerification,
  type StoredClaimVerification,
} from '../entities/index.js';
import type { IClaimVerificationsRepository } from '../repositories/claim-verifications.js';
import { claimVerifications as t } from './schema.js';

/**
 * claim_verifications 仓储的 SQLite 实现（异步接口、同步驱动）。
 *
 * 注意 `updatedAt`：这种"不同方言写时间的方式不同"的差异只允许出现在本层——
 * 这里直接给 SQLite 的字符串赋值，另一实现走 `new Date().toISOString()`，业务层无感。
 */
export class SqliteClaimVerificationsRepository implements IClaimVerificationsRepository {
  constructor(private readonly db: BetterSQLite3Database) {}

  async insert(row: NewClaimVerification): Promise<void> {
    this.db
      .insert(t)
      .values({
        id: row.id,
        profileId: row.profileId,
        subjectPlatform: row.subjectPlatform,
        subjectLogin: row.subjectLogin,
        claimText: row.claimText,
        claimSource: row.claimSource ?? 'manual',
        claimRef: row.claimRef ?? null,
        verdict: row.verdict,
        matchedEvidenceRefs: JSON.stringify(row.matchedEvidenceRefs ?? []),
        confidence: row.confidence ?? null,
        verifierAccountId: row.verifierAccountId ?? null,
        ruleVersion: row.ruleVersion ?? CLAIM_RULE_VERSION,
      })
      .run();
  }

  async getById(id: string): Promise<StoredClaimVerification | undefined> {
    const row = this.db.select().from(t).where(eq(t.id, id)).get();
    return row ? toStoredClaimVerification(row) : undefined;
  }

  async listByProfile(profileId: string): Promise<StoredClaimVerification[]> {
    const rows = this.db
      .select()
      .from(t)
      .where(eq(t.profileId, profileId))
      .orderBy(asc(t.createdAt))
      .all();
    return rows.map(toStoredClaimVerification);
  }

  async countByProfiles(profileIds: readonly string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (profileIds.length === 0) return counts;
    const rows = this.db
      .select({ profileId: t.profileId, count: sql<number>`count(*)` })
      .from(t)
      .where(inArray(t.profileId, [...profileIds]))
      .groupBy(t.profileId)
      .all();
    for (const row of rows) {
      if (row.profileId) counts.set(row.profileId, Number(row.count));
    }
    return counts;
  }

  async delete(id: string): Promise<boolean> {
    const changes = this.db.delete(t).where(eq(t.id, id)).run().changes;
    return changes > 0;
  }

  async deleteByProfile(profileId: string): Promise<void> {
    this.db.delete(t).where(eq(t.profileId, profileId)).run();
  }
}
