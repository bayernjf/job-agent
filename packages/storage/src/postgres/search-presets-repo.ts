import { desc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  toStoredSearchPreset,
  type NewSearchPreset,
  type StoredSearchPreset,
} from '../entities/index.js';
import type { ISearchPresetsRepository } from '../repositories/search-presets.js';
import { searchPresets as t, type SearchPresetInsert } from './schema.js';

/** search_presets 仓储的 Postgres 实现。 */
export class PgSearchPresetsRepository implements ISearchPresetsRepository {
  constructor(private readonly db: NodePgDatabase) {}

  async upsert(preset: NewSearchPreset): Promise<void> {
    const values: SearchPresetInsert = {
      presetId: preset.presetId,
      accountId: preset.accountId,
      title: preset.title ?? null,
      query: preset.query,
      conditions: JSON.stringify(preset.conditions),
      createdAt: preset.createdAt,
      updatedAt: preset.updatedAt,
    };
    await this.db
      .insert(t)
      .values(values)
      .onConflictDoUpdate({
        target: [t.accountId, t.query],
        set: {
          title: values.title,
          conditions: values.conditions,
          updatedAt: values.updatedAt,
        },
      });
  }

  async getById(id: string): Promise<StoredSearchPreset | undefined> {
    const rows = await this.db.select().from(t).where(eq(t.presetId, id)).limit(1);
    return rows[0] ? toStoredSearchPreset(rows[0]) : undefined;
  }

  async listByAccount(accountId: string, limit = 50): Promise<StoredSearchPreset[]> {
    const rows = await this.db
      .select()
      .from(t)
      .where(eq(t.accountId, accountId))
      .orderBy(desc(t.createdAt))
      .limit(limit);
    return rows.map(toStoredSearchPreset);
  }

  async delete(id: string): Promise<boolean> {
    const res = await this.db.delete(t).where(eq(t.presetId, id));
    return res.rowCount > 0;
  }
}
