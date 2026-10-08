import { desc, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  toStoredSearchPreset,
  type NewSearchPreset,
  type StoredSearchPreset,
} from '../entities/index.js';
import type { ISearchPresetsRepository } from '../repositories/search-presets.js';
import { searchPresets as t, type SearchPresetInsert } from './schema.js';

/** search_presets 仓储的 SQLite 实现（异步接口、同步驱动）。 */
export class SqliteSearchPresetsRepository implements ISearchPresetsRepository {
  constructor(private readonly db: BetterSQLite3Database) {}

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
    this.db
      .insert(t)
      .values(values)
      .onConflictDoUpdate({
        target: [t.accountId, t.query],
        set: {
          title: values.title,
          conditions: values.conditions,
          updatedAt: values.updatedAt,
        },
      })
      .run();
  }

  async getById(id: string): Promise<StoredSearchPreset | undefined> {
    const row = this.db.select().from(t).where(eq(t.presetId, id)).get();
    return row ? toStoredSearchPreset(row) : undefined;
  }

  async listByAccount(accountId: string, limit = 50): Promise<StoredSearchPreset[]> {
    const rows = this.db
      .select()
      .from(t)
      .where(eq(t.accountId, accountId))
      .orderBy(desc(t.createdAt))
      .limit(limit)
      .all();
    return rows.map(toStoredSearchPreset);
  }

  async delete(id: string): Promise<boolean> {
    const res = this.db.delete(t).where(eq(t.presetId, id)).run();
    return res.changes > 0;
  }
}
