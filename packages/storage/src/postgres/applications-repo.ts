import { desc, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  toStoredApplication,
  type ApplicationPatch,
  type NewApplication,
  type StoredApplication,
} from '../entities/index.js';
import type { IApplicationsRepository } from '../repositories/applications.js';
import { applications as t, type ApplicationInsert } from './schema.js';

/** applications 仓储的 Postgres 实现（全异步）。 */
export class PgApplicationsRepository implements IApplicationsRepository {
  constructor(private readonly db: PostgresJsDatabase) {}

  async insert(application: NewApplication): Promise<void> {
    await this.db.insert(t).values({
      id: application.id,
      profileId: application.profileId,
      jobId: application.jobId ?? null,
      source: application.source ?? null,
      targetTitle: application.targetTitle,
      targetCompany: application.targetCompany,
      targetUrl: application.targetUrl ?? null,
      status: application.status ?? 'applied',
      note: application.note ?? null,
      origin: application.origin ?? 'manual',
      appliedAt: application.appliedAt,
      createdByAccountId: application.createdByAccountId ?? null,
    });
  }

  async getById(id: string): Promise<StoredApplication | undefined> {
    const rows = await this.db.select().from(t).where(eq(t.id, id)).limit(1);
    return rows[0] ? toStoredApplication(rows[0]!) : undefined;
  }

  async listByProfile(profileId: string): Promise<StoredApplication[]> {
    const rows = await this.db
      .select()
      .from(t)
      .where(eq(t.profileId, profileId))
      .orderBy(desc(t.appliedAt));
    return rows.map(toStoredApplication);
  }

  async update(
    id: string,
    patch: ApplicationPatch,
    ownerAccountId?: string | null,
  ): Promise<StoredApplication | undefined> {
    if (ownerAccountId !== undefined) {
      const current = await this.getById(id);
      // 有主且主不是调用者 → 与"不存在"同形返回，不泄露他人记录的存在性
      if (
        current &&
        current.createdByAccountId !== null &&
        current.createdByAccountId !== ownerAccountId
      ) {
        return undefined;
      }
    }
    const set: Partial<ApplicationInsert> & { updatedAt: string } = {
      updatedAt: new Date().toISOString(),
    };
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.note !== undefined) set.note = patch.note;
    if (patch.appliedAt !== undefined) set.appliedAt = patch.appliedAt;
    if (patch.targetUrl !== undefined) set.targetUrl = patch.targetUrl;
    await this.db.update(t).set(set).where(eq(t.id, id));
    return this.getById(id);
  }
}
