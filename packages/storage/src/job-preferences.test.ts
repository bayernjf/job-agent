import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './sqlite/migrator.js';
import { openSqlite } from './sqlite/connection.js';
import { SqliteJobPreferencesRepository } from './sqlite/job-preferences-repo.js';
import {
  toStoredJobPreference,
  type NewJobPreference,
  type RawJobPreferenceRow,
} from './entities/index.js';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../db/migrations/sqlite',
);

function freshRepo(): { repo: SqliteJobPreferencesRepository; close: () => void } {
  const { client, db } = openSqlite(':memory:');
  runMigrations(client, MIGRATIONS_DIR);
  return { repo: new SqliteJobPreferencesRepository(db), close: () => client.close() };
}

function pref(
  overrides: Partial<NewJobPreference> & Pick<NewJobPreference, 'id' | 'accountId'>,
): NewJobPreference {
  return {
    label: 'Remote full-stack',
    targetTitles: ['backend'],
    createdAt: '2026-10-03T00:00:00.000Z',
    updatedAt: '2026-10-03T00:00:00.000Z',
    ...overrides,
  };
}

function rawRow(overrides: Partial<RawJobPreferenceRow>): RawJobPreferenceRow {
  return {
    id: 'pref-raw',
    accountId: 'acc-1',
    label: 'raw',
    targetTitles: '["backend"]',
    skills: '[]',
    locations: '[]',
    remoteOnly: 0,
    salaryMinUsd: null,
    sources: '[]',
    companyWhitelist: '[]',
    companyBlacklist: '[]',
    minTier: 'mid',
    dailySubmitLimit: 20,
    createdAt: '2026-10-03T00:00:00.000Z',
    updatedAt: '2026-10-03T00:00:00.000Z',
    ...overrides,
  };
}

describe('SqliteJobPreferencesRepository', () => {
  it('inserts with column defaults and reads back by id', async () => {
    const { repo, close } = freshRepo();
    await repo.insert(pref({ id: 'pref-1', accountId: 'acc-1' }));

    const stored = await repo.getById('pref-1');
    expect(stored).toBeDefined();
    expect(stored!.label).toBe('Remote full-stack');
    expect(stored!.targetTitles).toEqual(['backend']);
    expect(stored!.skills).toEqual([]);
    expect(stored!.locations).toEqual([]);
    expect(stored!.remoteOnly).toBe(false);
    expect(stored!.salaryMinUsd).toBeNull();
    expect(stored!.sources).toEqual([]);
    expect(stored!.companyWhitelist).toEqual([]);
    expect(stored!.companyBlacklist).toEqual([]);
    expect(stored!.minTier).toBe('mid');
    expect(stored!.dailySubmitLimit).toBe(20);
    expect(stored!.createdAt).toBe('2026-10-03T00:00:00.000Z');
    close();
  });

  it('round-trips every JSON array plus remoteOnly and salary', async () => {
    const { repo, close } = freshRepo();
    await repo.insert(
      pref({
        id: 'pref-1',
        accountId: 'acc-1',
        targetTitles: ['backend', 'platform'],
        skills: ['go', 'postgres'],
        locations: ['Remote', 'EU'],
        remoteOnly: true,
        salaryMinUsd: 180000,
        sources: ['remoteok', 'greenhouse'],
        companyWhitelist: ['Acme'],
        companyBlacklist: ['BadCorp'],
        minTier: 'high',
        dailySubmitLimit: 5,
      }),
    );

    const stored = (await repo.getById('pref-1'))!;
    expect(stored.targetTitles).toEqual(['backend', 'platform']);
    expect(stored.skills).toEqual(['go', 'postgres']);
    expect(stored.locations).toEqual(['Remote', 'EU']);
    expect(stored.remoteOnly).toBe(true);
    expect(stored.salaryMinUsd).toBe(180000);
    expect(stored.sources).toEqual(['remoteok', 'greenhouse']);
    expect(stored.companyWhitelist).toEqual(['Acme']);
    expect(stored.companyBlacklist).toEqual(['BadCorp']);
    expect(stored.minTier).toBe('high');
    expect(stored.dailySubmitLimit).toBe(5);
    close();
  });

  it('update writes only the provided fields (null clears salaryMinUsd)', async () => {
    const { repo, close } = freshRepo();
    await repo.insert(
      pref({
        id: 'pref-1',
        accountId: 'acc-1',
        skills: ['go'],
        locations: ['EU'],
        remoteOnly: true,
        salaryMinUsd: 100000,
        minTier: 'high',
      }),
    );

    const updated = await repo.update(
      'pref-1',
      { skills: ['go', 'k8s'], salaryMinUsd: null },
      '2026-10-04T00:00:00.000Z',
    );
    expect(updated!.skills).toEqual(['go', 'k8s']);
    expect(updated!.salaryMinUsd).toBeNull();
    expect(updated!.updatedAt).toBe('2026-10-04T00:00:00.000Z');
    // 未提供的字段保持原值
    expect(updated!.locations).toEqual(['EU']);
    expect(updated!.remoteOnly).toBe(true);
    expect(updated!.minTier).toBe('high');
    expect(updated!.label).toBe('Remote full-stack');
    // JSON 列确实被 stringify 后再解析回来（不是内存里同一个数组）
    expect(updated!.targetTitles).toEqual(['backend']);
    close();
  });

  it('update returns undefined for an unknown id and inserts nothing', async () => {
    const { repo, close } = freshRepo();
    expect(
      await repo.update('pref-missing', { label: 'nope' }, '2026-10-04T00:00:00.000Z'),
    ).toBeUndefined();
    expect(await repo.getById('pref-missing')).toBeUndefined();
    expect(await repo.listByAccount('acc-1')).toEqual([]);
    close();
  });

  it('listByAccount is newest-first, account-scoped and honours limit', async () => {
    const { repo, close } = freshRepo();
    await repo.insert(
      pref({ id: 'pref-old', accountId: 'acc-1', createdAt: '2026-10-01T00:00:00.000Z' }),
    );
    await repo.insert(
      pref({ id: 'pref-mid', accountId: 'acc-1', createdAt: '2026-10-02T00:00:00.000Z' }),
    );
    await repo.insert(
      pref({ id: 'pref-new', accountId: 'acc-1', createdAt: '2026-10-03T00:00:00.000Z' }),
    );
    await repo.insert(
      pref({ id: 'pref-other', accountId: 'acc-2', createdAt: '2026-10-04T00:00:00.000Z' }),
    );

    const all = await repo.listByAccount('acc-1');
    expect(all.map((p) => p.id)).toEqual(['pref-new', 'pref-mid', 'pref-old']);
    const limited = await repo.listByAccount('acc-1', 2);
    expect(limited.map((p) => p.id)).toEqual(['pref-new', 'pref-mid']);
    // 另一个账号的行绝不越界出现
    expect(all.some((p) => p.accountId !== 'acc-1')).toBe(false);
    close();
  });

  it('delete reports whether a row was actually removed', async () => {
    const { repo, close } = freshRepo();
    await repo.insert(pref({ id: 'pref-1', accountId: 'acc-1' }));
    expect(await repo.delete('pref-1')).toBe(true);
    expect(await repo.getById('pref-1')).toBeUndefined();
    expect(await repo.delete('pref-1')).toBe(false);
    close();
  });

  it('normalizes 0/1 remoteOnly, unknown tier and malformed JSON in the mapper', () => {
    const asOne = toStoredJobPreference(rawRow({ remoteOnly: 1, minTier: 'high' }));
    expect(asOne.remoteOnly).toBe(true);
    expect(asOne.minTier).toBe('high');

    const asZero = toStoredJobPreference(rawRow({ remoteOnly: 0 }));
    expect(asZero.remoteOnly).toBe(false);

    const unknownTier = toStoredJobPreference(rawRow({ minTier: 'legendary' }));
    expect(unknownTier.minTier).toBe('mid');

    const brokenJson = toStoredJobPreference(
      rawRow({ targetTitles: 'not json', skills: '{"a":1}', locations: '["EU",7]' }),
    );
    expect(brokenJson.targetTitles).toEqual([]);
    expect(brokenJson.skills).toEqual([]);
    expect(brokenJson.locations).toEqual(['EU']);
  });
});
