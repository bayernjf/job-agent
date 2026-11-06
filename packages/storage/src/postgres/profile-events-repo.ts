import { asc, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  toProfileEventRecord,
  type ProfileEventRecord,
} from '../entities/profile-event.js';
import type { IProfileEventsRepository } from '../repositories/profile-events.js';
import { profileEvents as t } from './schema.js';

/** profile_events 仓储的 Postgres 实现。只追加，不回改。 */
export class PgProfileEventsRepository implements IProfileEventsRepository {
  constructor(private readonly db: PostgresJsDatabase) {}

  async insert(row: ProfileEventRecord): Promise<void> {
    await this.db.insert(t).values(row);
  }

  async listByProfile(profileId: string): Promise<ProfileEventRecord[]> {
    const rows = await this.db
      .select()
      .from(t)
      .where(eq(t.profileId, profileId))
      .orderBy(asc(t.createdAt), asc(t.id));
    return rows.map(toProfileEventRecord);
  }
}
