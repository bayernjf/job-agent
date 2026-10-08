import { and, asc, desc, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  toStoredSearchRun,
  type NewSearchRun,
  type SearchRunFinishPatch,
  type StoredSearchRun,
} from '../entities/index.js';
import type { ISearchRunsRepository } from '../repositories/search-runs.js';
import { searchRuns as t, type SearchRunInsert } from './schema.js';

/** search_runs 仓储的 SQLite 实现（异步接口、同步驱动）。 */
export class SqliteSearchRunsRepository implements ISearchRunsRepository {
  constructor(private readonly db: BetterSQLite3Database) {}

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
    this.db.insert(t).values(values).run();
  }

  async getById(id: string): Promise<StoredSearchRun | undefined> {
    const row = this.db.select().from(t).where(eq(t.runId, id)).get();
    return row ? toStoredSearchRun(row) : undefined;
  }

  async listByAccount(accountId: string, limit = 20): Promise<StoredSearchRun[]> {
    const rows = this.db
      .select()
      .from(t)
      .where(eq(t.accountId, accountId))
      .orderBy(desc(t.createdAt))
      .limit(limit)
      .all();
    return rows.map(toStoredSearchRun);
  }

  async claimNextQueued(now: string): Promise<StoredSearchRun | undefined> {
    // 事务：先取出最老 queued 行，再把它置 running；where status='queued' 防两个
    // tick 并发认领同一行（后一个 UPDATE 命中 0 行则返回 undefined）。
    return this.db.transaction((tx) => {
      const queued = tx
        .select()
        .from(t)
        .where(eq(t.status, 'queued'))
        .orderBy(asc(t.createdAt))
        .limit(1)
        .all();
      const target = queued[0];
      if (!target) return undefined;
      const claimed = tx
        .update(t)
        .set({ status: 'running', updatedAt: now })
        .where(and(eq(t.runId, target.runId), eq(t.status, 'queued')))
        .returning()
        .get();
      return claimed ? toStoredSearchRun(claimed) : undefined;
    });
  }

  async finish(
    id: string,
    patch: SearchRunFinishPatch,
    updatedAt: string,
  ): Promise<StoredSearchRun | undefined> {
    const row = this.db
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
      .returning()
      .get();
    return row ? toStoredSearchRun(row) : undefined;
  }
}
