import { asc, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { CLAIM_RULE_VERSION } from '@jobagent/claim-core';
import {
  toStoredClaimVerification,
  type NewClaimVerification,
  type StoredClaimVerification,
} from '../entities/index.js';
import type { IClaimVerificationsRepository } from '../repositories/claim-verifications.js';
import { claimVerifications as t } from './schema.js';

/**
 * claim_verifications 仓储的 Postgres 实现（全异步）。
 * 缺席 `real` 列的 SQLite/Postgres 差异由仓储层吸收：SQLite 用字符串时间戳，
 * 这里走 `new Date().toISOString()`，业务层无感。
 */
export class PgClaimVerificationsRepository implements IClaimVerificationsRepository {
  constructor(private readonly db: PostgresJsDatabase) {}

  async insert(row: NewClaimVerification): Promise<void> {
    await this.db.insert(t).values({
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
    });
  }

  async getById(id: string): Promise<StoredClaimVerification | undefined> {
    const rows = await this.db.select().from(t).where(eq(t.id, id)).limit(1);
    return rows[0] ? toStoredClaimVerification(rows[0]!) : undefined;
  }

  async listByProfile(profileId: string): Promise<StoredClaimVerification[]> {
    const rows = await this.db
      .select()
      .from(t)
      .where(eq(t.profileId, profileId))
      .orderBy(asc(t.createdAt));
    return rows.map(toStoredClaimVerification);
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.db.delete(t).where(eq(t.id, id)).returning({ id: t.id });
    return rows.length > 0;
  }

  async deleteByProfile(profileId: string): Promise<void> {
    await this.db.delete(t).where(eq(t.profileId, profileId));
  }
}
