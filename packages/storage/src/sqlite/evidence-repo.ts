import { and, desc, eq, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { EvidenceItem } from '@jobagent/shared';
import { toStoredEvidence, type NewEvidence, type StoredEvidence } from '../entities/index.js';
import type { IEvidenceRepository } from '../repositories/evidence.js';
import { evidence as evidenceTable } from './schema.js';

/** evidence 仓储的 SQLite 实现（异步接口、同步驱动）。 */
export class SqliteEvidenceRepository implements IEvidenceRepository {
  constructor(private readonly db: BetterSQLite3Database) {}

  async insert(ev: NewEvidence): Promise<void> {
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

  async insertBatch(evidence: NewEvidence[]): Promise<void> {
    if (evidence.length === 0) return;
    this.db.transaction((tx) => {
      for (const ev of evidence) {
        tx.insert(evidenceTable)
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
    });
  }

  async importFromProfile(profileId: string, items: EvidenceItem[]): Promise<void> {
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
    await this.insertBatch(evidence);
  }

  async getById(id: string): Promise<StoredEvidence | undefined> {
    const row = this.db.select().from(evidenceTable).where(eq(evidenceTable.id, id)).get();
    return row ? toStoredEvidence(row) : undefined;
  }

  async listByProfile(profileId: string): Promise<StoredEvidence[]> {
    const rows = this.db
      .select()
      .from(evidenceTable)
      .where(eq(evidenceTable.profileId, profileId))
      .orderBy(desc(evidenceTable.createdAt))
      .all();
    return rows.map(toStoredEvidence);
  }

  async listBySource(
    sourcePlatform: string,
    sourceType: string,
    limit = 100,
  ): Promise<StoredEvidence[]> {
    const rows = this.db
      .select()
      .from(evidenceTable)
      .where(
        and(
          eq(evidenceTable.sourcePlatform, sourcePlatform),
          eq(evidenceTable.sourceType, sourceType),
        ),
      )
      .orderBy(desc(evidenceTable.createdAt))
      .limit(limit)
      .all();
    return rows.map(toStoredEvidence);
  }

  async countByProfile(profileId: string): Promise<number> {
    const result = this.db
      .select({ count: sql<number>`count(*)` })
      .from(evidenceTable)
      .where(eq(evidenceTable.profileId, profileId))
      .get();
    return result ? Number(result.count) : 0;
  }

  async deleteByProfile(profileId: string): Promise<void> {
    this.db.delete(evidenceTable).where(eq(evidenceTable.profileId, profileId)).run();
  }
}
