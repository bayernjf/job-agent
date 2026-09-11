/**
 * waitlist 实体：落地页留资的领域类型与纯映射（双方言共享）。
 * 状态机：pending -> contacted -> converted | archived。
 */

export type WaitlistStatus = 'pending' | 'contacted' | 'converted' | 'archived';
export type WaitlistSource = 'landing_page' | 'api' | 'referral';

export const WAITLIST_STATUSES: readonly WaitlistStatus[] = [
  'pending',
  'contacted',
  'converted',
  'archived',
];

export interface StoredWaitlist {
  id: string;
  email: string;
  name: string | null;
  githubUsername: string | null;
  source: string;
  status: WaitlistStatus;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewWaitlist {
  id: string;
  email: string;
  name?: string;
  githubUsername?: string;
  source?: WaitlistSource;
  status?: WaitlistStatus;
  notes?: string;
}

/** Drizzle 查询返回的原始行（camelCase），两方言结构一致 */
export interface RawWaitlistRow {
  id: string;
  email: string;
  name: string | null;
  githubUsername: string | null;
  source: string;
  status: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toStoredWaitlist(row: RawWaitlistRow): StoredWaitlist {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    githubUsername: row.githubUsername,
    source: row.source,
    status: (WAITLIST_STATUSES as readonly string[]).includes(row.status)
      ? (row.status as WaitlistStatus)
      : 'pending',
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
