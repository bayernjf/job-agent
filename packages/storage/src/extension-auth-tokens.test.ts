import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './sqlite/migrator.js';
import { openSqlite } from './sqlite/connection.js';
import { SqliteExtensionAuthCodesRepository } from './sqlite/extension-auth-codes-repo.js';
import { SqliteApiTokensRepository } from './sqlite/api-tokens-repo.js';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../db/migrations/sqlite',
);

const NOW = '2026-10-04T04:00:00.000Z';
const FUTURE = '2026-12-31T00:00:00.000Z';
const PAST = '2026-01-01T00:00:00.000Z';

function fresh() {
  const { client, db } = openSqlite(':memory:');
  runMigrations(client, MIGRATIONS_DIR);
  return {
    codes: new SqliteExtensionAuthCodesRepository(db),
    tokens: new SqliteApiTokensRepository(db),
    close: () => client.close(),
  };
}

describe('SqliteExtensionAuthCodesRepository', () => {
  it('creates and resolves an unconsumed unexpired code', async () => {
    const s = fresh();
    try {
      await s.codes.create({ id: 'ext-code-aaa', accountId: 'acc-1', expiresAt: FUTURE });
      const got = await s.codes.getActive('ext-code-aaa', NOW);
      expect(got?.accountId).toBe('acc-1');
      expect(got?.usedAt).toBeNull();
    } finally {
      s.close();
    }
  });

  it('returns undefined for unknown, expired, or consumed codes', async () => {
    const s = fresh();
    try {
      await s.codes.create({ id: 'ext-code-expired', accountId: 'acc-1', expiresAt: PAST });
      await s.codes.create({ id: 'ext-code-live', accountId: 'acc-1', expiresAt: FUTURE });
      await s.codes.consume('ext-code-live', NOW);

      expect(await s.codes.getActive('ext-code-nope', NOW)).toBeUndefined();
      expect(await s.codes.getActive('ext-code-expired', NOW)).toBeUndefined();
      expect(await s.codes.getActive('ext-code-live', NOW)).toBeUndefined();
    } finally {
      s.close();
    }
  });

  it('consumes a code atomically (single-use, no replay)', async () => {
    const s = fresh();
    try {
      await s.codes.create({ id: 'ext-code-single', accountId: 'acc-1', expiresAt: FUTURE });
      expect(await s.codes.consume('ext-code-single', NOW)).toBe(true);
      // 第二次消费失败（防重放）
      expect(await s.codes.consume('ext-code-single', NOW)).toBe(false);
      expect((await s.codes.getActive('ext-code-single', NOW)) ?? undefined).toBeUndefined();
    } finally {
      s.close();
    }
  });

  it('rejects consuming an expired code', async () => {
    const s = fresh();
    try {
      await s.codes.create({ id: 'ext-code-old', accountId: 'acc-1', expiresAt: PAST });
      expect(await s.codes.consume('ext-code-old', NOW)).toBe(false);
    } finally {
      s.close();
    }
  });

  it('purges consumed and expired codes beyond the retain window', async () => {
    const s = fresh();
    try {
      await s.codes.create({ id: 'ext-code-consumed', accountId: 'acc-1', expiresAt: FUTURE });
      await s.codes.consume('ext-code-consumed', PAST); // 消费于保留期之前
      await s.codes.create({ id: 'ext-code-stale', accountId: 'acc-1', expiresAt: PAST });
      await s.codes.create({ id: 'ext-code-fresh', accountId: 'acc-1', expiresAt: FUTURE });

      const removed = await s.codes.purgeExpired(NOW, 24 * 60 * 60 * 1000);
      expect(removed).toBe(2);
      expect(await s.codes.getActive('ext-code-fresh', NOW)).toBeDefined();
    } finally {
      s.close();
    }
  });
});

describe('SqliteApiTokensRepository', () => {
  it('creates and resolves an active token by digest', async () => {
    const s = fresh();
    try {
      await s.tokens.create({
        id: 'tkn-aaa',
        accountId: 'acc-1',
        tokenHash: 'hash-aaa',
        name: 'browser extension',
        expiresAt: FUTURE,
      });
      const got = await s.tokens.getActiveByHash('hash-aaa', NOW);
      expect(got?.accountId).toBe('acc-1');
      expect(got?.revokedAt).toBeNull();
    } finally {
      s.close();
    }
  });

  it('does not resolve unknown, expired, or revoked tokens', async () => {
    const s = fresh();
    try {
      await s.tokens.create({
        id: 'tkn-bbb',
        accountId: 'acc-1',
        tokenHash: 'hash-bbb',
        name: 'browser extension',
        expiresAt: PAST,
      });
      await s.tokens.create({
        id: 'tkn-ccc',
        accountId: 'acc-1',
        tokenHash: 'hash-ccc',
        name: 'browser extension',
        expiresAt: FUTURE,
      });
      await s.tokens.revoke('tkn-ccc', NOW);

      expect(await s.tokens.getActiveByHash('hash-nope', NOW)).toBeUndefined();
      expect(await s.tokens.getActiveByHash('hash-bbb', NOW)).toBeUndefined();
      expect(await s.tokens.getActiveByHash('hash-ccc', NOW)).toBeUndefined();
    } finally {
      s.close();
    }
  });

  it('slides expiry and last-seen on touch', async () => {
    const s = fresh();
    try {
      await s.tokens.create({
        id: 'tkn-slide',
        accountId: 'acc-1',
        tokenHash: 'hash-slide',
        name: 'browser extension',
        expiresAt: NOW,
      });
      await s.tokens.touchAndSlide('tkn-slide', NOW, 90 * 24 * 60 * 60 * 1000);
      const got = await s.tokens.getActiveByHash('hash-slide', NOW);
      // 滑动后 expiresAt 应晚于原值（等于 NOW+90d）
      expect(got?.expiresAt).toBe('2027-01-02T04:00:00.000Z');
    } finally {
      s.close();
    }
  });

  it('lists active tokens per account (revoked/expired excluded)', async () => {
    const s = fresh();
    try {
      await s.tokens.create({
        id: 'tkn-l1',
        accountId: 'acc-1',
        tokenHash: 'hash-l1',
        name: 'browser extension',
        expiresAt: FUTURE,
      });
      await s.tokens.create({
        id: 'tkn-l2',
        accountId: 'acc-1',
        tokenHash: 'hash-l2',
        name: 'browser extension',
        expiresAt: FUTURE,
      });
      await s.tokens.create({
        id: 'tkn-l3',
        accountId: 'acc-2',
        tokenHash: 'hash-l3',
        name: 'browser extension',
        expiresAt: FUTURE,
      });
      await s.tokens.revoke('tkn-l2', NOW);

      const list = await s.tokens.listActiveByAccount('acc-1', NOW);
      expect(list.map((t) => t.id).sort()).toEqual(['tkn-l1']);
    } finally {
      s.close();
    }
  });

  it('purges revoked and expired tokens beyond the retain window', async () => {
    const s = fresh();
    try {
      await s.tokens.create({
        id: 'tkn-p1',
        accountId: 'acc-1',
        tokenHash: 'hash-p1',
        name: 'browser extension',
        expiresAt: FUTURE,
      });
      await s.tokens.revoke('tkn-p1', PAST);
      await s.tokens.create({
        id: 'tkn-p2',
        accountId: 'acc-1',
        tokenHash: 'hash-p2',
        name: 'browser extension',
        expiresAt: PAST,
      });
      await s.tokens.create({
        id: 'tkn-p3',
        accountId: 'acc-1',
        tokenHash: 'hash-p3',
        name: 'browser extension',
        expiresAt: FUTURE,
      });

      const removed = await s.tokens.purgeExpired(NOW, 24 * 60 * 60 * 1000);
      expect(removed).toBe(2);
      expect(await s.tokens.getActiveByHash('hash-p3', NOW)).toBeDefined();
    } finally {
      s.close();
    }
  });
});
