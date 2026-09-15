import { and, eq, gt, lt, or, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
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
 * demo_sessions / demo_rate_events 仓储的 Postgres 实现。
 * acquireAnalyzeSlot 用单条条件 UPDATE ... RETURNING 原子扣减，一条语句拿到扣后值，
 * 无需两次往返（对照 SQLite 实现语义一致）。
 */
export class PgDemoSessionsRepository implements IDemoSessionsRepository {
  constructor(private readonly db: PostgresJsDatabase) {}

  async create(session: NewDemoSession): Promise<void> {
    await this.db.insert(demoSessions).values({
      id: session.id,
      expiresAt: session.expiresAt,
      ipHash: session.ipHash,
    });
  }

  async getActive(id: string, now: string): Promise<StoredDemoSession | undefined> {
    const rows = await this.db
      .select()
      .from(demoSessions)
      .where(
        and(
          eq(demoSessions.id, id),
          eq(demoSessions.status, 'active'),
          gt(demoSessions.expiresAt, now),
        ),
      )
      .limit(1);
    return rows[0] ? toStoredDemoSession(rows[0]) : undefined;
  }

  async acquireAnalyzeSlot(id: string, quota: number, now: string): Promise<DemoSlotResult> {
    const rows = await this.db
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
      .returning({
        analyzeCount: demoSessions.analyzeCount,
        status: demoSessions.status,
        expiresAt: demoSessions.expiresAt,
      });

    if (rows.length === 1) {
      const used = rows[0]!.analyzeCount;
      return { granted: true, used, remaining: Math.max(0, quota - used) };
    }

    // 影响 0 行：补查一次以区分拒绝原因
    const existing = await this.db
      .select()
      .from(demoSessions)
      .where(eq(demoSessions.id, id))
      .limit(1);
    if (existing.length === 0) return { granted: false, reason: 'not_found', used: 0 };
    const stored = toStoredDemoSession(existing[0]!);
    if (stored.status === 'exited') {
      return { granted: false, reason: 'exited', used: stored.analyzeCount };
    }
    if (!(stored.expiresAt > now)) {
      return { granted: false, reason: 'expired', used: stored.analyzeCount };
    }
    return { granted: false, reason: 'quota_exceeded', used: stored.analyzeCount };
  }

  async releaseAnalyzeSlot(id: string): Promise<void> {
    await this.db
      .update(demoSessions)
      .set({ analyzeCount: sql`GREATEST(${demoSessions.analyzeCount} - 1, 0)` })
      .where(eq(demoSessions.id, id));
  }

  async incrementMatch(id: string, now: string): Promise<void> {
    await this.db
      .update(demoSessions)
      .set({ matchCount: sql`${demoSessions.matchCount} + 1`, lastSeenAt: now })
      .where(eq(demoSessions.id, id));
  }

  async touch(id: string, now: string, login?: AnalyzedLogin): Promise<void> {
    if (!login) {
      await this.db.update(demoSessions).set({ lastSeenAt: now }).where(eq(demoSessions.id, id));
      return;
    }
    const existing = await this.db
      .select()
      .from(demoSessions)
      .where(eq(demoSessions.id, id))
      .limit(1);
    if (existing.length === 0) return;
    const stored = toStoredDemoSession(existing[0]!);
    const logins = stored.analyzedLogins.filter(
      (item) => !(item.platform === login.platform && item.login === login.login),
    );
    logins.push(login);
    const trimmed = logins.slice(-20);
    await this.db
      .update(demoSessions)
      .set({ lastSeenAt: now, analyzedLogins: JSON.stringify(trimmed) })
      .where(eq(demoSessions.id, id));
  }

  async exit(id: string, now: string): Promise<void> {
    await this.db
      .update(demoSessions)
      .set({ status: 'exited', lastSeenAt: now })
      .where(eq(demoSessions.id, id));
  }

  async countRateEvents(ipHash: string, kind: DemoRateKind, since: string): Promise<number> {
    const rows = await this.db
      .select({ count: sql<string>`count(*)` })
      .from(demoRateEvents)
      .where(
        and(
          eq(demoRateEvents.ipHash, ipHash),
          eq(demoRateEvents.kind, kind),
          gt(demoRateEvents.createdAt, since),
        ),
      );
    return Number(rows[0]?.count ?? 0);
  }

  async insertRateEvent(ipHash: string, kind: DemoRateKind, now: string): Promise<void> {
    await this.db.insert(demoRateEvents).values({
      id: randomUUID(),
      ipHash,
      kind,
      createdAt: now,
    });
  }

  async purgeExpired(now: string, retainMs: number): Promise<number> {
    const retainCutoff = new Date(new Date(now).getTime() - retainMs).toISOString();
    const rows = await this.db
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
      .returning({ id: demoSessions.id });
    return rows.length;
  }

  async purgeRateEventsBefore(cutoff: string): Promise<number> {
    const rows = await this.db
      .delete(demoRateEvents)
      .where(lt(demoRateEvents.createdAt, cutoff))
      .returning({ id: demoRateEvents.id });
    return rows.length;
  }
}
