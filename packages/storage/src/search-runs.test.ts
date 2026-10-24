import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { SearchConditions } from '@jobagent/shared';
import { runMigrations } from './sqlite/migrator.js';
import { openSqlite } from './sqlite/connection.js';
import { SqliteSearchRunsRepository } from './sqlite/search-runs-repo.js';
import type { NewSearchRun } from './entities/index.js';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../db/migrations/sqlite',
);

function freshRepo(): { repo: SqliteSearchRunsRepository; db: Database.Database } {
  const { client, db } = openSqlite(':memory:');
  runMigrations(client, MIGRATIONS_DIR);
  return { repo: new SqliteSearchRunsRepository(db), db: client };
}

const COND: SearchConditions = {
  queries: ['Berlin backend engineer'],
  location: 'Berlin',
  remote: false,
  salaryMinUsd: null,
  keywords: [],
};

function newRun(runId: string, createdAt: string, updatedAt: string): NewSearchRun {
  return { runId, accountId: 'acc-1', query: 'q', conditions: COND, createdAt, updatedAt };
}

const TEN_MIN = 10 * 60 * 1000;

describe('SqliteSearchRunsRepository.reclaimStaleRunning', () => {
  it('fails a running run left behind past the threshold, and does not requeue it', async () => {
    const { repo } = freshRepo();
    await repo.insert(newRun('run_stale', '2026-10-24T00:00:00.000Z', '2026-10-24T00:00:00.000Z'));
    // A tick claimed it at 00:01 and was then cut off by the serverless platform.
    const claimed = await repo.claimNextQueued('2026-10-24T00:01:00.000Z');
    expect(claimed!.runId).toBe('run_stale');
    expect(claimed!.status).toBe('running');

    const moved = await repo.reclaimStaleRunning(TEN_MIN, '2026-10-24T00:20:00.000Z');

    expect(moved).toBe(1);
    const run = (await repo.getById('run_stale'))!;
    // Terminal on purpose: search_runs has no attempts column and each execution spends
    // real Tavily credits, so requeueing would replay a search that was already paid for.
    expect(run.status).toBe('failed');
    expect(run.error).toContain('not retried');
    expect(run.updatedAt).toBe('2026-10-24T00:20:00.000Z');
    // and it is no longer claimable
    expect(await repo.claimNextQueued('2026-10-24T00:21:00.000Z')).toBeUndefined();
  });

  it('leaves a running run inside the threshold alone', async () => {
    const { repo } = freshRepo();
    await repo.insert(newRun('run_live', '2026-10-24T00:00:00.000Z', '2026-10-24T00:00:00.000Z'));
    await repo.claimNextQueued('2026-10-24T00:15:00.000Z');

    const moved = await repo.reclaimStaleRunning(TEN_MIN, '2026-10-24T00:20:00.000Z');

    expect(moved).toBe(0);
    expect((await repo.getById('run_live'))!.status).toBe('running');
  });

  it('never touches the queue: a waiting run survives the sweep', async () => {
    const { repo } = freshRepo();
    await repo.insert(newRun('run_waiting', '2026-10-24T00:00:00.000Z', '2026-10-24T00:00:00.000Z'));

    // Long past any threshold, but still `queued` — reclaimStaleRunning matches on
    // status='running' only, so the pending (unspent) run must be left for a real tick.
    const moved = await repo.reclaimStaleRunning(TEN_MIN, '2026-10-24T09:00:00.000Z');

    expect(moved).toBe(0);
    expect((await repo.getById('run_waiting'))!.status).toBe('queued');
    expect((await repo.claimNextQueued('2026-10-24T09:01:00.000Z'))!.runId).toBe('run_waiting');
  });
});
