import { and, desc, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  toStoredProfileRemovalRequest,
  type NewProfileRemovalRequest,
  type RemovalDecision,
  type RemovalRequestStatus,
  type StoredProfileRemovalRequest,
} from '../entities/index.js';
import type { IProfileRemovalRequestsRepository } from '../repositories/profile-removal-requests.js';
import { profileRemovalRequests as t } from './schema.js';

/** profile_removal_requests 仓储的 Postgres 实现（全异步）。 */
export class PgProfileRemovalRequestsRepository implements IProfileRemovalRequestsRepository {
  constructor(private readonly db: PostgresJsDatabase) {}

  async insert(request: NewProfileRemovalRequest): Promise<void> {
    await this.db.insert(t).values({
      id: request.id,
      profileId: request.profileId,
      status: request.status ?? 'pending',
      reason: request.reason ?? null,
      contact: request.contact ?? null,
      ipHash: request.ipHash ?? null,
      createdAt: request.createdAt,
    });
  }

  async getById(id: string): Promise<StoredProfileRemovalRequest | undefined> {
    const rows = await this.db.select().from(t).where(eq(t.id, id)).limit(1);
    return rows[0] ? toStoredProfileRemovalRequest(rows[0]!) : undefined;
  }

  async latestPendingByProfile(
    profileId: string,
  ): Promise<StoredProfileRemovalRequest | undefined> {
    const rows = await this.db
      .select()
      .from(t)
      .where(and(eq(t.profileId, profileId), eq(t.status, 'pending')))
      .orderBy(desc(t.createdAt))
      .limit(1);
    return rows[0] ? toStoredProfileRemovalRequest(rows[0]!) : undefined;
  }

  async listByStatus(
    status: RemovalRequestStatus,
    limit = 50,
  ): Promise<StoredProfileRemovalRequest[]> {
    const rows = await this.db
      .select()
      .from(t)
      .where(eq(t.status, status))
      .orderBy(desc(t.createdAt))
      .limit(limit);
    return rows.map(toStoredProfileRemovalRequest);
  }

  async decide(
    id: string,
    status: RemovalDecision,
    decidedAt: string,
  ): Promise<StoredProfileRemovalRequest | undefined> {
    const current = await this.getById(id);
    if (!current) return undefined;
    // 已结单不再改写：复核结论不可被后续调用静默覆盖
    if (current.decidedAt !== null) return current;
    await this.db.update(t).set({ status, decidedAt }).where(eq(t.id, id));
    return this.getById(id);
  }
}
