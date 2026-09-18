import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './sqlite/migrator.js';
import { openSqlite } from './sqlite/connection.js';
import { SqliteDemoSessionsRepository } from './sqlite/demo-sessions-repo.js';
import type { NewDemoSession } from './entities/index.js';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../db/migrations/sqlite',
);

function freshRepo(): SqliteDemoSessionsRepository {
  const { client, db } = openSqlite(':memory:');
  runMigrations(client, MIGRATIONS_DIR);
  return new SqliteDemoSessionsRepository(db);
}

const T0 = '2026-09-15T00:00:00.000Z';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
function iso(base: string, deltaMs: number): string {
  return new Date(new Date(base).getTime() + deltaMs).toISOString();
}

function makeSession(id: string, now: string, ttlMs = 7 * DAY): NewDemoSession {
  return { id, expiresAt: iso(now, ttlMs), ipHash: 'hash-a' };
}

describe('SqliteDemoSessionsRepository', () => {
  it('creates and returns an active session, hides unknown/exited/expired', async () => {
    const repo = freshRepo();
    await repo.create(makeSession('s1', T0));

    const active = await repo.getActive('s1', T0);
    expect(active).toBeDefined();
    expect(active!.analyzeCount).toBe(0);
    expect(active!.matchCount).toBe(0);
    expect(active!.analyzedLogins).toEqual([]);
    expect(active!.status).toBe('active');

    expect(await repo.getActive('missing', T0)).toBeUndefined();

    // 已退出
    await repo.exit('s1', T0);
    expect(await repo.getActive('s1', T0)).toBeUndefined();

    // 已过期
    await repo.create(makeSession('s2', T0));
    expect(await repo.getActive('s2', iso(T0, 8 * DAY))).toBeUndefined();
  });

  it('grants exactly quota slots then denies with quota_exceeded', async () => {
    const repo = freshRepo();
    await repo.create(makeSession('s1', T0));
    const quota = 3;

    const r1 = await repo.acquireAnalyzeSlot('s1', quota, T0);
    expect(r1).toEqual({ granted: true, used: 1, remaining: 2 });
    const r2 = await repo.acquireAnalyzeSlot('s1', quota, T0);
    expect(r2).toEqual({ granted: true, used: 2, remaining: 1 });
    const r3 = await repo.acquireAnalyzeSlot('s1', quota, T0);
    expect(r3).toEqual({ granted: true, used: 3, remaining: 0 });

    // 连续再请求两次都拒绝，且计数不再增长（不超用）
    for (let i = 0; i < 2; i++) {
      const denied = await repo.acquireAnalyzeSlot('s1', quota, T0);
      expect(denied.granted).toBe(false);
      if (!denied.granted) {
        expect(denied.reason).toBe('quota_exceeded');
        expect(denied.used).toBe(3);
      }
    }
    const stored = await repo.getActive('s1', T0);
    expect(stored!.analyzeCount).toBe(3);
  });

  it('charges a weighted cost for fused jobs and never partially deducts', async () => {
    const repo = freshRepo();
    await repo.create(makeSession('s1', T0));
    const quota = 3;

    // 一次 platform=all 融合作业按 cost 2 扣减：used 2、remaining 1
    const first = await repo.acquireAnalyzeSlot('s1', quota, T0, 2);
    expect(first).toEqual({ granted: true, used: 2, remaining: 1 });

    // 剩余 1 不足 cost 2：整单拒绝（quota_exceeded），不部分扣减，used 仍为 2
    const denied = await repo.acquireAnalyzeSlot('s1', quota, T0, 2);
    expect(denied.granted).toBe(false);
    if (!denied.granted) {
      expect(denied.reason).toBe('quota_exceeded');
      expect(denied.used).toBe(2);
    }
    expect((await repo.getActive('s1', T0))!.analyzeCount).toBe(2);

    // 单源作业 cost 1 仍可放行：used 3、remaining 0
    const single = await repo.acquireAnalyzeSlot('s1', quota, T0, 1);
    expect(single).toEqual({ granted: true, used: 3, remaining: 0 });

    // 补偿按原 cost 回退（先退融合的 2、再退单源的 1），超额补偿不会变成负数
    await repo.releaseAnalyzeSlot('s1', 2);
    expect((await repo.getActive('s1', T0))!.analyzeCount).toBe(1);
    await repo.releaseAnalyzeSlot('s1', 1);
    expect((await repo.getActive('s1', T0))!.analyzeCount).toBe(0);
    await repo.releaseAnalyzeSlot('s1', 2);
    expect((await repo.getActive('s1', T0))!.analyzeCount).toBe(0);
  });

  it('reports precise deny reasons for unknown, exited and expired', async () => {
    const repo = freshRepo();
    const missing = await repo.acquireAnalyzeSlot('nope', 3, T0);
    expect(missing).toEqual({ granted: false, reason: 'not_found', used: 0 });

    await repo.create(makeSession('s_exited', T0));
    await repo.exit('s_exited', T0);
    const exited = await repo.acquireAnalyzeSlot('s_exited', 3, T0);
    expect(exited.granted).toBe(false);
    if (!exited.granted) expect(exited.reason).toBe('exited');

    await repo.create(makeSession('s_old', T0, HOUR));
    const expired = await repo.acquireAnalyzeSlot('s_old', 3, iso(T0, 2 * HOUR));
    expect(expired.granted).toBe(false);
    if (!expired.granted) expect(expired.reason).toBe('expired');
  });

  it('releaseAnalyzeSlot compensates and never drops below zero', async () => {
    const repo = freshRepo();
    await repo.create(makeSession('s1', T0));
    await repo.acquireAnalyzeSlot('s1', 1, T0);
    expect((await repo.acquireAnalyzeSlot('s1', 1, T0)).granted).toBe(false);

    await repo.releaseAnalyzeSlot('s1');
    const again = await repo.acquireAnalyzeSlot('s1', 1, T0);
    expect(again.granted).toBe(true);

    // 多次补偿不会变成负数
    await repo.releaseAnalyzeSlot('s1');
    await repo.releaseAnalyzeSlot('s1');
    const stored = await repo.getActive('s1', T0);
    expect(stored!.analyzeCount).toBe(0);
  });

  it('increments match count and appends/dedupes analyzed logins via touch', async () => {
    const repo = freshRepo();
    await repo.create(makeSession('s1', T0));
    await repo.incrementMatch('s1', T0);
    await repo.incrementMatch('s1', T0);
    expect((await repo.getActive('s1', T0))!.matchCount).toBe(2);

    await repo.touch('s1', T0, { platform: 'github', login: 'alice' });
    await repo.touch('s1', T0, { platform: 'gitee', login: 'bob' });
    // 同平台同名去重，不重复追加
    await repo.touch('s1', T0, { platform: 'github', login: 'alice' });
    const stored = await repo.getActive('s1', T0);
    expect(stored!.analyzedLogins).toEqual([
      { platform: 'gitee', login: 'bob' },
      { platform: 'github', login: 'alice' },
    ]);
  });

  it('keeps only the latest 20 analyzed logins', async () => {
    const repo = freshRepo();
    await repo.create(makeSession('s1', T0));
    for (let i = 0; i < 25; i++) {
      await repo.touch('s1', T0, { platform: 'github', login: `u${i}` });
    }
    const stored = await repo.getActive('s1', T0);
    expect(stored!.analyzedLogins).toHaveLength(20);
    expect(stored!.analyzedLogins[0]!.login).toBe('u5');
    expect(stored!.analyzedLogins[19]!.login).toBe('u24');
  });

  it('counts and inserts IP rate events within a sliding window', async () => {
    const repo = freshRepo();
    const t1 = iso(T0, 10 * 60 * 1000);
    await repo.insertRateEvent('hash-a', 'session', t1);
    await repo.insertRateEvent('hash-a', 'session', t1);
    await repo.insertRateEvent('hash-a', 'analyze', t1);
    await repo.insertRateEvent('hash-b', 'session', t1);

    expect(await repo.countRateEvents('hash-a', 'session', T0)).toBe(2);
    expect(await repo.countRateEvents('hash-a', 'analyze', T0)).toBe(1);
    expect(await repo.countRateEvents('hash-b', 'session', T0)).toBe(1);
    // since 晚于全部事件 → 窗口内为 0
    expect(await repo.countRateEvents('hash-a', 'session', iso(t1, 1000))).toBe(0);
  });

  it('purges rate events before a cutoff', async () => {
    const repo = freshRepo();
    await repo.insertRateEvent('h', 'session', iso(T0, HOUR));
    await repo.insertRateEvent('h', 'session', iso(T0, 3 * HOUR));
    const removed = await repo.purgeRateEventsBefore(iso(T0, 2 * HOUR));
    expect(removed).toBe(1);
    expect(await repo.countRateEvents('h', 'session', T0)).toBe(1);
  });

  it('purges only exited/expired sessions beyond the retain window', async () => {
    const repo = freshRepo();
    const now = iso(T0, 30 * DAY);

    // 活跃且未过期：保留
    await repo.create({ id: 'active', expiresAt: iso(now, DAY), ipHash: null });
    // 过期 10 天（超过 24h 保留）：删除
    await repo.create({ id: 'expired_old', expiresAt: iso(now, -10 * DAY), ipHash: null });
    // 刚过期 1 小时（未超保留）：保留
    await repo.create({ id: 'expired_recent', expiresAt: iso(now, -HOUR), ipHash: null });
    // 10 天前退出：删除（last_seen_at 取退出时刻）
    await repo.create({ id: 'exited_old', expiresAt: iso(now, DAY), ipHash: null });
    await repo.exit('exited_old', iso(now, -10 * DAY));

    const removed = await repo.purgeExpired(now, DAY);
    expect(removed).toBe(2);
    expect(await repo.getActive('active', now)).toBeDefined();
    expect(await repo.getActive('expired_recent', now)).toBeUndefined(); // 过期但仍在库
    const ids = ['active', 'expired_old', 'expired_recent', 'exited_old'].map(async (id) => {
      const row = await repo.getActive(id, now);
      return [id, row !== undefined] as const;
    });
    const settled = await Promise.all(ids);
    const surviving = settled.filter(([, alive]) => alive).map(([id]) => id);
    expect(surviving).toEqual(['active']);
  });
});
