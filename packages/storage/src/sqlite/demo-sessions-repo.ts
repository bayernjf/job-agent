import { and, eq, gt, lt, or, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  toStoredDemoSession,
  type AnalyzedLogin,
  type DemoRateKind,
  type DemoSlotResult,
  type NewDemoSession,
  type StoredDemoSession,
} from '../entities/index.js';
import type { IDemoSessionsRepository } from '../repositories/demo-sessions.js';
import { demoRateEvents, demoSessions } from './schema.js';

/**
 * demo_sessions / demo_rate_events 仓储的 SQLite 实现（异步接口、同步驱动）。
 * acquireAnalyzeSlot 用单条条件 UPDATE 原子扣减（禁 select-then-update），
 * 靠 better-sqlite3 的串行执行天然规避并发超用。
 */
export class SqliteDemoSessionsRepository implements IDemoSessionsRepository {
  constructor(private readonly db: BetterSQLite3Database) {}

  async create(session: NewDemoSession): Promise<void> {
    this.db
      .insert(demoSessions)
      .values({
        id: session.id,
        expiresAt: session.expiresAt,
        ipHash: session.ipHash,
      })
      .run();
  }

  async getActive(id: string, now: string): Promise<StoredDemoSession | undefined> {
    const row = this.db
      .select()
      .from(demoSessions)
      .where(
        and(
          eq(demoSessions.id, id),
          eq(demoSessions.status, 'active'),
          gt(demoSessions.expiresAt, now),
        ),
      )
      .get();
    return row ? toStoredDemoSession(row) : undefined;
  }

  async acquireAnalyzeSlot(id: string, quota: number, now: string): Promise<DemoSlotResult> {
    const result = this.db
      .update(demoSessions)
      .set({
        analyzeCount: sql`${demoSessions.analyzeCount} + 1`,
        lastSeenAt: now,
      })
      .where(
        and(
          eq(demoSessions.id, id),
          eq(demoSessions.status, 'active'),
          gt(demoSessions.expiresAt, now),
          sql`${demoSessions.analyzeCount} < ${quota}`,
        ),
      )
      .run();

    if ((result.changes ?? 0) === 1) {
      const row = this.db.select().from(demoSessions).where(eq(demoSessions.id, id)).get();
      const used = row?.analyzeCount ?? 0;
      return { granted: true, used, remaining: Math.max(0, quota - used) };
    }

    // 影响 0 行：补查一次以区分拒绝原因（错误码精度需要）
    const row = this.db.select().from(demoSessions).where(eq(demoSessions.id, id)).get();
    if (!row) return { granted: false, reason: 'not_found', used: 0 };
    const stored = toStoredDemoSession(row);
    if (stored.status === 'exited') {
      return { granted: false, reason: 'exited', used: stored.analyzeCount };
    }
    if (!(stored.expiresAt > now)) {
      return { granted: false, reason: 'expired', used: stored.analyzeCount };
    }
    return { granted: false, reason: 'quota_exceeded', used: stored.analyzeCount };
  }

  async releaseAnalyzeSlot(id: string): Promise<void> {
    this.db
      .update(demoSessions)
      .set({ analyzeCount: sql`MAX(${demoSessions.analyzeCount} - 1, 0)` })
      .where(eq(demoSessions.id, id))
      .run();
  }

  async incrementMatch(id: string, now: string): Promise<void> {
    this.db
      .update(demoSessions)
      .set({ matchCount: sql`${demoSessions.matchCount} + 1`, lastSeenAt: now })
      .where(eq(demoSessions.id, id))
      .run();
  }

  async touch(id: string, now: string, login?: AnalyzedLogin): Promise<void> {
    if (!login) {
      this.db
        .update(demoSessions)
        .set({ lastSeenAt: now })
        .where(eq(demoSessions.id, id))
        .run();
      return;
    }
    const row = this.db.select().from(demoSessions).where(eq(demoSessions.id, id)).get();
    if (!row) return;
    const stored = toStoredDemoSession(row);
    // 去重后追加，仅保留最近 20 条
    const logins = stored.analyzedLogins.filter(
      (item) => !(item.platform === login.platform && item.login === login.login),
    );
    logins.push(login);
    const trimmed = logins.slice(-20);
    this.db
      .update(demoSessions)
      .set({ lastSeenAt: now, analyzedLogins: JSON.stringify(trimmed) })
      .where(eq(demoSessions.id, id))
      .run();
  }

  async exit(id: string, now: string): Promise<void> {
    this.db
      .update(demoSessions)
      .set({ status: 'exited', lastSeenAt: now })
      .where(eq(demoSessions.id, id))
      .run();
  }

  async countRateEvents(ipHash: string, kind: DemoRateKind, since: string): Promise<number> {
    const row = this.db
      .select({ count: sql<number>`count(*)` })
      .from(demoRateEvents)
      .where(
        and(
          eq(demoRateEvents.ipHash, ipHash),
          eq(demoRateEvents.kind, kind),
          gt(demoRateEvents.createdAt, since),
        ),
      )
      .get();
    return Number(row?.count ?? 0);
  }

  async insertRateEvent(ipHash: string, kind: DemoRateKind, now: string): Promise<void> {
    this.db
      .insert(demoRateEvents)
      .values({ id: randomUUID(), ipHash, kind, createdAt: now })
      .run();
  }

  async purgeExpired(now: string, retainMs: number): Promise<number> {
    const retainCutoff = new Date(new Date(now).getTime() - retainMs).toISOString();
    // 删除：已退出且超过保留期（以退出时刷新的 last_seen_at 为准），或已过期超过保留期
    const result = this.db
      .delete(demoSessions)
      .where(
        or(
          and(
            eq(demoSessions.status, 'exited'),
            lt(demoSessions.lastSeenAt, retainCutoff),
          ),
          lt(demoSessions.expiresAt, retainCutoff),
        ),
      )
      .run();
    return result.changes ?? 0;
  }

  async purgeRateEventsBefore(cutoff: string): Promise<number> {
    const result = this.db
      .delete(demoRateEvents)
      .where(lt(demoRateEvents.createdAt, cutoff))
      .run();
    return result.changes ?? 0;
  }
}
