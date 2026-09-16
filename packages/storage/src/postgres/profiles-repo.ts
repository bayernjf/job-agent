import { and, desc, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  toStoredProfile,
  searchCandidates as searchCandidatesPure,
  type CandidateSearchQuery,
  type CandidateSummary,
  type NewProfile,
  type ProfileStatus,
  type StoredProfile,
} from '../entities/index.js';
import type { IProfilesRepository } from '../repositories/profiles.js';
import { profiles as profilesTable } from './schema.js';

/** 人才检索扫描上限：只取最近的 complete 画像在内存中精细过滤（MVP 画像量级可接受）。 */
const CANDIDATE_SCAN_CAP = 1000;

/** profiles 仓储的 Postgres 实现（postgres-js 全异步）。 */
export class PgProfilesRepository implements IProfilesRepository {
  constructor(private readonly db: PostgresJsDatabase) {}

  async insert(profile: NewProfile): Promise<void> {
    await this.db
      .insert(profilesTable)
      .values({
        id: profile.id,
        analyzerVersion: profile.analyzerVersion,
        subjectPlatform: profile.subjectPlatform ?? 'github',
        subjectLogin: profile.subjectLogin,
        subjectClaimed: profile.subjectClaimed ?? false,
        dataWindowSince: profile.dataWindowSince,
        dataWindowUntil: profile.dataWindowUntil,
        analysisLayers: JSON.stringify(profile.analysisLayers ?? ['L0', 'L1']),
        status: profile.status ?? 'partial',
        snapshot: JSON.stringify(profile.snapshot),
      });
  }

  async getById(id: string): Promise<StoredProfile | undefined> {
    const rows = await this.db.select().from(profilesTable).where(eq(profilesTable.id, id)).limit(1);
    return rows[0] ? toStoredProfile(rows[0]) : undefined;
  }

  async listBySubject(
    subjectPlatform: string,
    subjectLogin: string,
    limit = 20,
  ): Promise<StoredProfile[]> {
    const rows = await this.db
      .select()
      .from(profilesTable)
      .where(
        and(
          eq(profilesTable.subjectPlatform, subjectPlatform),
          eq(profilesTable.subjectLogin, subjectLogin),
        ),
      )
      .orderBy(desc(profilesTable.createdAt))
      .limit(limit);
    return rows.map(toStoredProfile);
  }

  async latestBySubject(
    subjectPlatform: string,
    subjectLogin: string,
  ): Promise<StoredProfile | undefined> {
    return (await this.listBySubject(subjectPlatform, subjectLogin, 1))[0];
  }

  async updateStatus(id: string, status: ProfileStatus): Promise<void> {
    await this.db
      .update(profilesTable)
      .set({ status, updatedAt: new Date().toISOString() })
      .where(eq(profilesTable.id, id));
  }

  async searchCandidates(
    query: CandidateSearchQuery,
  ): Promise<{ items: CandidateSummary[]; total: number }> {
    const rows = await this.db
      .select()
      .from(profilesTable)
      .where(eq(profilesTable.status, 'complete'))
      .orderBy(desc(profilesTable.updatedAt))
      .limit(CANDIDATE_SCAN_CAP);
    const stored: StoredProfile[] = rows.map((row) => toStoredProfile(row));
    return searchCandidatesPure(stored, query);
  }
}
