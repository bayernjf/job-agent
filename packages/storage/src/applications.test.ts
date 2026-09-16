import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './sqlite/migrator.js';
import { openSqlite } from './sqlite/connection.js';
import { SqliteApplicationsRepository } from './sqlite/applications-repo.js';
import { APPLICATION_STATUSES, type NewApplication } from './entities/index.js';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../db/migrations/sqlite',
);

function freshRepo(): { repo: SqliteApplicationsRepository; close: () => void } {
  const { client, db } = openSqlite(':memory:');
  runMigrations(client, MIGRATIONS_DIR);
  return { repo: new SqliteApplicationsRepository(db), close: () => client.close() };
}

function app(overrides: Partial<NewApplication> & Pick<NewApplication, 'id' | 'profileId'>): NewApplication {
  return {
    targetTitle: 'Senior Engineer',
    targetCompany: 'Acme',
    appliedAt: '2026-09-16T00:00:00.000Z',
    ...overrides,
  };
}

describe('SqliteApplicationsRepository', () => {
  it('inserts with defaults and reads back by id', async () => {
    const { repo, close } = freshRepo();
    await repo.insert(app({ id: 'app-1', profileId: 'prof-1' }));
    const stored = await repo.getById('app-1');
    expect(stored).toBeDefined();
    expect(stored!.status).toBe('applied');
    expect(stored!.origin).toBe('manual');
    expect(stored!.jobId).toBeNull();
    expect(stored!.targetUrl).toBeNull();
    expect(stored!.note).toBeNull();
    close();
  });

  it('lists applications for a profile ordered by applied_at desc, scoped to the profile', async () => {
    const { repo, close } = freshRepo();
    await repo.insert(
      app({ id: 'app-1', profileId: 'prof-1', appliedAt: '2026-09-01T00:00:00.000Z' }),
    );
    await repo.insert(
      app({ id: 'app-2', profileId: 'prof-1', appliedAt: '2026-09-10T00:00:00.000Z', status: 'interview' }),
    );
    await repo.insert(
      app({ id: 'app-3', profileId: 'prof-2', appliedAt: '2026-09-12T00:00:00.000Z' }),
    );
    const mine = await repo.listByProfile('prof-1');
    expect(mine.map((a) => a.id)).toEqual(['app-2', 'app-1']);
    expect(await repo.listByProfile('prof-2')).toHaveLength(1);
    close();
  });

  it('patches status and note, bumps updated_at, and keeps unknown statuses from leaking', async () => {
    const { repo, close } = freshRepo();
    await repo.insert(app({ id: 'app-1', profileId: 'prof-1' }));
    const before = (await repo.getById('app-1'))!.updatedAt;
    const updated = await repo.update('app-1', { status: 'offer', note: '终面通过' });
    expect(updated!.status).toBe('offer');
    expect(updated!.note).toBe('终面通过');
    expect(updated!.updatedAt >= before).toBe(true);
    expect(await repo.update('missing', { status: 'rejected' })).toBeUndefined();
    close();
  });

  it('exposes the full funnel status enum', () => {
    expect(APPLICATION_STATUSES).toEqual([
      'saved',
      'applied',
      'viewed',
      'interview',
      'offer',
      'rejected',
      'withdrawn',
    ]);
  });
});
