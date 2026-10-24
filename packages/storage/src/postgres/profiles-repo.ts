import { and, desc, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
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

/** profiles 仓储的 Postgres 实现（postgres-js 全异步）。 */
export class PgProfilesRepository implements IProfilesRepository {
  constructor(private readonly db: PostgresJsDatabase) {}

  async publishWithEvidenceAndJob(input: ProfilePublication): Promise<void> {
    const now = new Date().toISOString();
    // 单事务三步：画像快照 → 证据行 → 任务成功终态（理由见 IProfilesRepository 契约）。
    await this.db.transaction(async (tx) => {
      await tx.insert(profilesTable).values(profileInsertValues(input.profile));
      for (const item of input.evidence) {
        await tx
          .insert(evidenceTable)
          .values(evidenceInsertValues(toNewEvidence(input.profile.id, item)));
      }
      await tx
        .update(analysisJobsTable)
        .set(jobSucceedValues(input.profile.id, now, input.budgetUsed, input.missing))
        .where(eq(analysisJobsTable.id, input.jobId));
    });
  }

  async insert(profile: NewProfile): Promise<void> {
    await this.db.insert(profilesTable).values(profileInsertValues(profile));
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

  async markClaimed(id: string): Promise<void> {
    await this.db
      .update(profilesTable)
      .set({ subjectClaimed: true, updatedAt: new Date().toISOString() })
      .where(eq(profilesTable.id, id));
  }

  async unmarkClaimed(id: string): Promise<void> {
    await this.db
      .update(profilesTable)
      .set({ subjectClaimed: false, updatedAt: new Date().toISOString() })
      .where(eq(profilesTable.id, id));
  }

  async setRemovalRequestedAt(id: string, requestedAt: string | null): Promise<void> {
    await this.db
      .update(profilesTable)
      .set({ removalRequestedAt: requestedAt, updatedAt: new Date().toISOString() })
      .where(eq(profilesTable.id, id));
  }

  async deleteById(id: string): Promise<boolean> {
    const rows = await this.db
      .delete(profilesTable)
      .where(eq(profilesTable.id, id))
      .returning({ id: profilesTable.id });
    return rows.length > 0;
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
