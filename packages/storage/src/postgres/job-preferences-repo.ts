import { desc, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  toStoredJobPreference,
  type JobPreferencePatch,
  type NewJobPreference,
  type StoredJobPreference,
} from '../entities/index.js';
import type { IJobPreferencesRepository } from '../repositories/job-preferences.js';
import { jobPreferences as t, type JobPreferenceInsert } from './schema.js';

/** job_preferences 仓储的 Postgres 实现（全异步）。 */
export class PgJobPreferencesRepository implements IJobPreferencesRepository {
  constructor(private readonly db: PostgresJsDatabase) {}

  async insert(pref: NewJobPreference): Promise<void> {
    await this.db.insert(t).values({
      id: pref.id,
      accountId: pref.accountId,
      label: pref.label,
      targetTitles: JSON.stringify(pref.targetTitles),
      // 集合缺省与列默认值一致（'[]'）；显式传空数组与不传等价
      skills: JSON.stringify(pref.skills ?? []),
      locations: JSON.stringify(pref.locations ?? []),
      remoteOnly: pref.remoteOnly ?? false,
      salaryMinUsd: pref.salaryMinUsd ?? null,
      sources: JSON.stringify(pref.sources ?? []),
      companyWhitelist: JSON.stringify(pref.companyWhitelist ?? []),
      companyBlacklist: JSON.stringify(pref.companyBlacklist ?? []),
      minTier: pref.minTier ?? 'mid',
      dailySubmitLimit: pref.dailySubmitLimit ?? 20,
      createdAt: pref.createdAt,
      updatedAt: pref.updatedAt,
    });
  }

  async getById(id: string): Promise<StoredJobPreference | undefined> {
    const rows = await this.db.select().from(t).where(eq(t.id, id)).limit(1);
    return rows[0] ? toStoredJobPreference(rows[0]) : undefined;
  }

  async listByAccount(accountId: string, limit = 50): Promise<StoredJobPreference[]> {
    const rows = await this.db
      .select()
      .from(t)
      .where(eq(t.accountId, accountId))
      .orderBy(desc(t.createdAt))
      .limit(limit);
    return rows.map(toStoredJobPreference);
  }

  async update(
    id: string,
    patch: JobPreferencePatch,
    updatedAt: string,
  ): Promise<StoredJobPreference | undefined> {
    const set: Partial<JobPreferenceInsert> & { updatedAt: string } = { updatedAt };
    // 只写显式提供的字段：undefined = 不改；null 是 salaryMinUsd 的合法清空值
    if (patch.label !== undefined) set.label = patch.label;
    if (patch.targetTitles !== undefined) set.targetTitles = JSON.stringify(patch.targetTitles);
    if (patch.skills !== undefined) set.skills = JSON.stringify(patch.skills);
    if (patch.locations !== undefined) set.locations = JSON.stringify(patch.locations);
    if (patch.remoteOnly !== undefined) set.remoteOnly = patch.remoteOnly;
    if (patch.salaryMinUsd !== undefined) set.salaryMinUsd = patch.salaryMinUsd;
    if (patch.sources !== undefined) set.sources = JSON.stringify(patch.sources);
    if (patch.companyWhitelist !== undefined) {
      set.companyWhitelist = JSON.stringify(patch.companyWhitelist);
    }
    if (patch.companyBlacklist !== undefined) {
      set.companyBlacklist = JSON.stringify(patch.companyBlacklist);
    }
    if (patch.minTier !== undefined) set.minTier = patch.minTier;
    if (patch.dailySubmitLimit !== undefined) set.dailySubmitLimit = patch.dailySubmitLimit;

    await this.db.update(t).set(set).where(eq(t.id, id));
    return this.getById(id);
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.db.delete(t).where(eq(t.id, id)).returning({ id: t.id });
    return rows.length > 0;
  }
}
