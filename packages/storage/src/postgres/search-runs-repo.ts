import { and, asc, desc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  toStoredSearchRun,
  type NewSearchRun,
  type SearchRunFinishPatch,
  type StoredSearchRun,
} from '../entities/index.js';
import type { ISearchRunsRepository } from '../repositories/search-runs.js';
import { searchRuns as t, type SearchRunInsert } from './schema.js';

/** search_runs 仓储的 Postgres 实现。 */
export class PgSearchRunsRepository implements ISearchRunsRepository {
  constructor(private readonly db: NodePgDatabase) {}

  async insert(run: NewSearchRun): Promise<void> {
    const values: SearchRunInsert = {
      runId: run.runId,
      accountId: run.accountId,
      presetId: run.presetId ?? null,
      query: run.query,
      conditions: JSON.stringify(run.conditions),
      status: run.status ?? 'queued',
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    };
    await this.db.insert(t).values(values);
  }

  async getById(id: string): Promise<StoredSearchRun | undefined> {
    const rows = await this.db.select().from(t).where(eq(t.runId, id)).limit(1);
    return rows[0] ? toStoredSearchRun(rows[0]) : undefined;
  }

  async listByAccount(accountId: string, limit = 20): Promise<StoredSearchRun[]> {
    const rows = await this.db
      .select()
      .from(t)
      .where(eq(t.accountId, accountId))
      .orderBy(desc(t.createdAt))
      .limit(limit);
    return rows.map(toStoredSearchRun);
  }

  async claimNextQueued(now: string): Promise<StoredSearchRun | undefined> {
    // 事务：先取最老 queued 行，再把它置 running；where status='queued' 防并发认领。
    return this.db.transaction(async (tx) => {
      const queued = await tx
        .select()
        .from(t)
        .where(eq(t.status, 'queued'))
        .orderBy(asc(t.createdAt))
        .limit(1);
      const target = queued[0];
      if (!target) return undefined;
      const claimed = await tx
        .update(t)
        .set({ status: 'running', updatedAt: now })
        .where(and(eq(t.runId, target.runId), eq(t.status, 'queued')))
        .returning();
      return claimed[0] ? toStoredSearchRun(claimed[0]) : undefined;
    });
  }

  async finish(
    id: string,
    patch: SearchRunFinishPatch,
    updatedAt: string,
  ): Promise<StoredSearchRun | undefined> {
    const rows = await this.db
      .update(t)
      .set({
        status: patch.status,
        queries: patch.queries !== undefined ? JSON.stringify(patch.queries) : undefined,
        resultsCount: patch.resultsCount,
        newCount: patch.newCount,
        matchedCount: patch.matchedCount,
        error: patch.error !== undefined ? patch.error : undefined,
        updatedAt,
      })
      .where(and(eq(t.runId, id), eq(t.status, 'running')))
      .returning();
    return rows[0] ? toStoredSearchRun(rows[0]) : undefined;
  }

  async delete(id: string): Promise<boolean> {
    const res = await this.db.delete(t).where(eq(t.runId, id));
    return res.rowCount > 0;
  }

  async deleteAllByAccount(accountId: string): Promise<number> {
    const res = await this.db.delete(t).where(eq(t.accountId, accountId));
    return res.rowCount;
  }
}
