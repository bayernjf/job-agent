import { asc, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  toProfileEventRecord,
  type ProfileEventRecord,
} from '../entities/profile-event.js';
import type { IProfileEventsRepository } from '../repositories/profile-events.js';
import { profileEvents as t } from './schema.js';

/** profile_events 仓储的 SQLite 实现（异步接口、同步驱动）。只追加，不回改。 */
export class SqliteProfileEventsRepository implements IProfileEventsRepository {
  constructor(private readonly db: BetterSQLite3Database) {}

  async insert(row: ProfileEventRecord): Promise<void> {
    this.db.insert(t).values(row).run();
  }

  async listByProfile(profileId: string): Promise<ProfileEventRecord[]> {
    const rows = this.db
      .select()
      .from(t)
      .where(eq(t.profileId, profileId))
      .orderBy(asc(t.createdAt), asc(t.id))
      .all();
    return rows.map(toProfileEventRecord);
  }
}
