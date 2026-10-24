import { and, desc, eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { EvidenceItem } from '@jobagent/shared';
import {
  toStoredEvidence,
  evidenceInsertValues,
  toNewEvidence,
  type NewEvidence,
  type StoredEvidence,
} from '../entities/index.js';
import type { IEvidenceRepository } from '../repositories/evidence.js';
import { evidence as evidenceTable } from './schema.js';

/** evidence 仓储的 Postgres 实现（全异步；批量插入在 async 事务内完成）。 */
export class PgEvidenceRepository implements IEvidenceRepository {
  constructor(private readonly db: PostgresJsDatabase) {}

  async insert(ev: NewEvidence): Promise<void> {
    await this.db.insert(evidenceTable).values(evidenceInsertValues(ev));
  }

  async insertBatch(evidence: NewEvidence[]): Promise<void> {
    if (evidence.length === 0) return;
    await this.db.transaction(async (tx) => {
      for (const ev of evidence) {
        await tx.insert(evidenceTable).values(evidenceInsertValues(ev));
      }
    });
  }

  async importFromProfile(profileId: string, items: EvidenceItem[]): Promise<void> {
    await this.insertBatch(items.map((item) => toNewEvidence(profileId, item)));
  }

  async getById(profileId: string, id: string): Promise<StoredEvidence | undefined> {
    const rows = await this.db
      .select()
      .from(evidenceTable)
      .where(and(eq(evidenceTable.profileId, profileId), eq(evidenceTable.id, id)))
      .limit(1);
    return rows[0] ? toStoredEvidence(rows[0]) : undefined;
  }

  async listByProfile(profileId: string): Promise<StoredEvidence[]> {
    const rows = await this.db
      .select()
      .from(evidenceTable)
      .where(eq(evidenceTable.profileId, profileId))
      .orderBy(desc(evidenceTable.createdAt));
    return rows.map(toStoredEvidence);
  }

  async listBySource(
    sourcePlatform: string,
    sourceType: string,
    limit = 100,
  ): Promise<StoredEvidence[]> {
    const rows = await this.db
      .select()
      .from(evidenceTable)
      .where(
        and(
          eq(evidenceTable.sourcePlatform, sourcePlatform),
          eq(evidenceTable.sourceType, sourceType),
        ),
      )
      .orderBy(desc(evidenceTable.createdAt))
      .limit(limit);
    return rows.map(toStoredEvidence);
  }

  async countByProfile(profileId: string): Promise<number> {
    const rows = await this.db
      .select({ count: sql<string>`count(*)` })
      .from(evidenceTable)
      .where(eq(evidenceTable.profileId, profileId));
    return rows[0] ? Number(rows[0].count) : 0;
  }

  async deleteByProfile(profileId: string): Promise<void> {
    await this.db.delete(evidenceTable).where(eq(evidenceTable.profileId, profileId));
  }
}
