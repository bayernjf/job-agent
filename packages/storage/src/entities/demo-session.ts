/**
 * demo_sessions / demo_rate_events 实体：演示模式临时会话与 IP 限流事件的
 * 领域类型与纯映射（双方言共享）。对应 docs/design-demo-mode-20260915.md §5.4。
 */
import type { SupportedPlatform } from '@jobagent/shared';
import { parseJson } from './analysis-job.js';

export type DemoSessionStatus = 'active' | 'exited';
export type DemoRateKind = 'session' | 'analyze' | 'match';

export const DEMO_SESSION_STATUSES: readonly DemoSessionStatus[] = ['active', 'exited'];
export const DEMO_RATE_KINDS: readonly DemoRateKind[] = ['session', 'analyze', 'match'];

/** 本会话触发过新分析的公开平台账号（审计/UI 用，非用户自身 PII） */
export interface AnalyzedLogin {
  platform: SupportedPlatform;
  login: string;
}

export interface NewDemoSession {
  id: string;
  expiresAt: string;
  ipHash: string | null;
}

export interface StoredDemoSession {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  analyzeCount: number;
  matchCount: number;
  analyzedLogins: AnalyzedLogin[];
  ipHash: string | null;
  status: DemoSessionStatus;
}

/** Drizzle 查询返回的原始行（camelCase；analyzed_logins 为 JSON 文本），两方言一致 */
export interface RawDemoSessionRow {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  analyzeCount: number;
  matchCount: number;
  analyzedLogins: string | null;
  ipHash: string | null;
  status: string;
}

/** 原子名额扣减结果：granted 时带已用/剩余；拒绝时带原因与当前已用 */
export type DemoSlotDenyReason = 'not_found' | 'expired' | 'exited' | 'quota_exceeded';
export type DemoSlotResult =
  | { granted: true; used: number; remaining: number }
  | { granted: false; reason: DemoSlotDenyReason; used: number };

export function toStoredDemoSession(row: RawDemoSessionRow): StoredDemoSession {
  return {
    id: row.id,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    expiresAt: row.expiresAt,
    analyzeCount: row.analyzeCount,
    matchCount: row.matchCount,
    analyzedLogins: parseJson<AnalyzedLogin[]>(row.analyzedLogins) ?? [],
    ipHash: row.ipHash,
    status: (DEMO_SESSION_STATUSES as readonly string[]).includes(row.status)
      ? (row.status as DemoSessionStatus)
      : 'active',
  };
}
