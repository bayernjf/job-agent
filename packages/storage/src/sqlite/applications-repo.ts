import { desc, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  toStoredApplication,
  type ApplicationPatch,
  type NewApplication,
  type StoredApplication,
} from '../entities/index.js';
import type { IApplicationsRepository } from '../repositories/applications.js';
import { applications as t, type ApplicationInsert } from './schema.js';

/** applications 仓储的 SQLite 实现（异步接口、同步驱动）。 */
export class SqliteApplicationsRepository implements IApplicationsRepository {
  constructor(private readonly db: BetterSQLite3Database) {}

  async insert(application: NewApplication): Promise<void> {
    this.db
      .insert(t)
      .values({
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
      })
      .run();
  }

  async getById(id: string): Promise<StoredApplication | undefined> {
    const row = this.db.select().from(t).where(eq(t.id, id)).get();
    return row ? toStoredApplication(row) : undefined;
  }

  async listByProfile(profileId: string): Promise<StoredApplication[]> {
    const rows = this.db
      .select()
      .from(t)
      .where(eq(t.profileId, profileId))
      .orderBy(desc(t.appliedAt))
      .all();
    return rows.map(toStoredApplication);
  }

  async update(id: string, patch: ApplicationPatch): Promise<StoredApplication | undefined> {
    const set: Partial<ApplicationInsert> & { updatedAt: string } = {
      updatedAt: new Date().toISOString(),
    };
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.note !== undefined) set.note = patch.note;
    if (patch.appliedAt !== undefined) set.appliedAt = patch.appliedAt;
    if (patch.targetUrl !== undefined) set.targetUrl = patch.targetUrl;
    this.db.update(t).set(set).where(eq(t.id, id)).run();
    return this.getById(id);
  }
}
