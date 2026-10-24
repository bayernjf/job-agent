import { and, desc, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  toStoredProfile,
  searchCandidates as searchCandidatesPure,
  evidenceInsertValues,
  jobSucceedValues,
  profileInsertValues,
  toNewEvidence,
  type CandidateSearchQuery,
  type CandidateSummary,
  type NewProfile,
  type ProfileStatus,
  type StoredProfile,
} from '../entities/index.js';
import type { IProfilesRepository, ProfilePublication } from '../repositories/profiles.js';
import {
  analysisJobs as analysisJobsTable,
  evidence as evidenceTable,
  profiles as profilesTable,
} from './schema.js';

/** 人才检索扫描上限：只取最近的 complete 画像在内存中精细过滤（MVP 画像量级可接受）。 */
const CANDIDATE_SCAN_CAP = 1000;

/**
 * profiles 仓储的 SQLite 实现。better-sqlite3 驱动本身同步，
 * 方法统一声明 async 以对齐 IProfilesRepository（Postgres 实现为真异步）。
 */
export class SqliteProfilesRepository implements IProfilesRepository {
  constructor(private readonly db: BetterSQLite3Database) {}

  async insert(profile: NewProfile): Promise<void> {
    this.db.insert(profilesTable).values(profileInsertValues(profile)).run();
  }

  async publishWithEvidenceAndJob(input: ProfilePublication): Promise<void> {
    const now = new Date().toISOString();
    // 单事务三步：画像快照 → 证据行 → 任务成功终态。
    // 任一步抛错整体回滚，因此绝不会出现"有画像但任务仍 running"（会被 reclaim 重跑成
    // 第二份画像）或"有画像但无证据"（报告页证据链断裂）。
    // 注意 better-sqlite3 的事务回调是**同步**的，所以这里直接用 tx 写三张表，
    // 而不是去 await 兄弟仓储的 async 方法（那会在事务提交后才执行）。
    this.db.transaction((tx) => {
      tx.insert(profilesTable).values(profileInsertValues(input.profile)).run();
      for (const item of input.evidence) {
        tx.insert(evidenceTable)
          .values(evidenceInsertValues(toNewEvidence(input.profile.id, item)))
          .run();
      }
      tx.update(analysisJobsTable)
        .set(
          jobSucceedValues(input.profile.id, now, input.budgetUsed, input.missing),
        )
        .where(eq(analysisJobsTable.id, input.jobId))
        .run();
    });
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

  async unmarkClaimed(id: string): Promise<void> {
    this.db
      .update(profilesTable)
      .set({ subjectClaimed: false, updatedAt: new Date().toISOString() })
      .where(eq(profilesTable.id, id))
      .run();
  }

  async setRemovalRequestedAt(id: string, requestedAt: string | null): Promise<void> {
    this.db
      .update(profilesTable)
      .set({ removalRequestedAt: requestedAt, updatedAt: new Date().toISOString() })
      .where(eq(profilesTable.id, id))
      .run();
  }

  async deleteById(id: string): Promise<boolean> {
    const info = this.db.delete(profilesTable).where(eq(profilesTable.id, id)).run();
    return Number(info.changes) > 0;
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
