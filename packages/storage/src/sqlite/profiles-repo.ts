import { and, desc, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
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

/**
 * profiles 仓储的 SQLite 实现。better-sqlite3 驱动本身同步，
 * 方法统一声明 async 以对齐 IProfilesRepository（Postgres 实现为真异步）。
 */
export class SqliteProfilesRepository implements IProfilesRepository {
  constructor(private readonly db: BetterSQLite3Database) {}

  async insert(profile: NewProfile): Promise<void> {
    this.db
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
      })
      .run();
  }

  async getById(id: string): Promise<StoredProfile | undefined> {
    const row = this.db.select().from(profilesTable).where(eq(profilesTable.id, id)).get();
    return row ? toStoredProfile(row) : undefined;
  }

  async listBySubject(
    subjectPlatform: string,
    subjectLogin: string,
    limit = 20,
  ): Promise<StoredProfile[]> {
    const rows = this.db
      .select()
      .from(profilesTable)
      .where(
        and(
          eq(profilesTable.subjectPlatform, subjectPlatform),
          eq(profilesTable.subjectLogin, subjectLogin),
        ),
      )
      .orderBy(desc(profilesTable.createdAt))
      .limit(limit)
      .all();
    return rows.map(toStoredProfile);
  }

  async latestBySubject(
    subjectPlatform: string,
    subjectLogin: string,
  ): Promise<StoredProfile | undefined> {
    return (await this.listBySubject(subjectPlatform, subjectLogin, 1))[0];
  }

  async updateStatus(id: string, status: ProfileStatus): Promise<void> {
    this.db
      .update(profilesTable)
      .set({ status, updatedAt: new Date().toISOString() })
      .where(eq(profilesTable.id, id))
      .run();
  }

  async markClaimed(id: string): Promise<void> {
    this.db
      .update(profilesTable)
      .set({ subjectClaimed: true, updatedAt: new Date().toISOString() })
      .where(eq(profilesTable.id, id))
      .run();
  }

  async searchCandidates(
    query: CandidateSearchQuery,
  ): Promise<{ items: CandidateSummary[]; total: number }> {
    const rows = this.db
      .select()
      .from(profilesTable)
      .where(eq(profilesTable.status, 'complete'))
      .orderBy(desc(profilesTable.updatedAt))
      .limit(CANDIDATE_SCAN_CAP)
      .all();
    const stored: StoredProfile[] = rows.map(toStoredProfile);
    return searchCandidatesPure(stored, query);
  }
}
