import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './sqlite/migrator.js';
import { openSqlite } from './sqlite/connection.js';
import { SqliteProfileRemovalRequestsRepository } from './sqlite/profile-removal-requests-repo.js';
import type { NewProfileRemovalRequest } from './entities/index.js';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../db/migrations/sqlite',
);

function freshRepo(): { repo: SqliteProfileRemovalRequestsRepository; close: () => void } {
  const { client, db } = openSqlite(':memory:');
  runMigrations(client, MIGRATIONS_DIR);
  return { repo: new SqliteProfileRemovalRequestsRepository(db), close: () => client.close() };
}

function req(overrides: Partial<NewProfileRemovalRequest> & Pick<NewProfileRemovalRequest, 'id' | 'profileId'>): NewProfileRemovalRequest {
  return {
    createdAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('SqliteProfileRemovalRequestsRepository', () => {
  it('inserts with pending default and reads back by id', async () => {
    const { repo, close } = freshRepo();
    await repo.insert(req({ id: 'rem-1', profileId: 'prof-1' }));
    const stored = await repo.getById('rem-1');
    expect(stored).toBeDefined();
    expect(stored!.status).toBe('pending');
    expect(stored!.reason).toBeNull();
    expect(stored!.decidedAt).toBeNull();
    expect(stored!.profileId).toBe('prof-1');
    close();
  });

  it('latestPendingByProfile returns the newest pending when multiple exist', async () => {
    const { repo, close } = freshRepo();
    await repo.insert(req({ id: 'rem-a', profileId: 'prof-1', createdAt: '2026-10-01T00:00:00.000Z' }));
    await repo.insert(req({ id: 'rem-b', profileId: 'prof-1', createdAt: '2026-10-02T00:00:00.000Z' }));
    await repo.insert(req({ id: 'rem-c', profileId: 'prof-2' }));
    const latest = await repo.latestPendingByProfile('prof-1');
    expect(latest!.id).toBe('rem-b');
    close();
  });

  it('latestPendingByProfile ignores rejected rows', async () => {
    const { repo, close } = freshRepo();
    await repo.insert(req({ id: 'rem-old', profileId: 'prof-1' }));
    await repo.decide('rem-old', 'rejected', '2026-10-03T00:00:00.000Z');
    await repo.insert(req({ id: 'rem-new', profileId: 'prof-1' }));
    const latest = await repo.latestPendingByProfile('prof-1');
    expect(latest!.id).toBe('rem-new');
    close();
  });

  it('listByStatus is sorted newest-first and filtered by status', async () => {
    const { repo, close } = freshRepo();
    await repo.insert(req({ id: 'rem-1', profileId: 'prof-1', createdAt: '2026-10-01T00:00:00.000Z' }));
    await repo.insert(req({ id: 'rem-2', profileId: 'prof-1', createdAt: '2026-10-02T00:00:00.000Z' }));
    await repo.decide('rem-1', 'rejected', '2026-10-03T00:00:00.000Z');
    const pending = await repo.listByStatus('pending');
    expect(pending.map((r) => r.id)).toEqual(['rem-2']);
    const rejected = await repo.listByStatus('rejected');
    expect(rejected.map((r) => r.id)).toEqual(['rem-1']);
    close();
  });

  it('decide sets terminal status + decidedAt, and is idempotent once decided', async () => {
    const { repo, close } = freshRepo();
    await repo.insert(req({ id: 'rem-1', profileId: 'prof-1' }));
    const decided = await repo.decide('rem-1', 'approved', '2026-10-04T00:00:00.000Z');
    expect(decided!.status).toBe('approved');
    expect(decided!.decidedAt).toBe('2026-10-04T00:00:00.000Z');
    // 已结单不可被后续调用改写
    const again = await repo.decide('rem-1', 'rejected', '2026-10-05T00:00:00.000Z');
    expect(again!.status).toBe('approved');
    expect(again!.decidedAt).toBe('2026-10-04T00:00:00.000Z');
    close();
  });

  it('decide returns undefined for unknown id', async () => {
    const { repo, close } = freshRepo();
    expect(await repo.decide('nope', 'approved', '2026-10-04T00:00:00.000Z')).toBeUndefined();
    close();
  });
});
