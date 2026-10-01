import { parseAbilityProfile, type AbilityProfile } from '@jobagent/shared';

/**
 * profiles 实体：与方言无关的领域类型 + 纯映射逻辑（sqlite/postgres 两套仓储共享）。
 * 数据库字段 snake_case、行对象经 Drizzle 映射后已是下列 camelCase 结构，
 * 因此 RawProfileRow 同时兼容两方言的查询结果。
 */

export type ProfileStatus = 'partial' | 'complete' | 'error';

export const PROFILE_STATUSES: readonly ProfileStatus[] = ['partial', 'complete', 'error'];

export interface StoredProfile {
  id: string;
  analyzerVersion: string;
  subjectPlatform: string;
  subjectLogin: string;
  subjectClaimed: boolean;
  dataWindowSince: string;
  dataWindowUntil: string;
  analysisLayers: string[];
  status: ProfileStatus;
  snapshot: AbilityProfile | null;
  /**
   * S3 软挂起标记：UTC ISO8601——首个 pending 移除申请的提交时刻；null = 无未决申请。
   * 挂起期间画像不再被 by-subject 解析与人才库检索分发，报告页显示「已收到移除申请」。
   */
  removalRequestedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewProfile {
  id: string;
  analyzerVersion: string;
  subjectPlatform?: string;
  subjectLogin: string;
  subjectClaimed?: boolean;
  dataWindowSince: string;
  dataWindowUntil: string;
  analysisLayers?: string[];
  status?: ProfileStatus;
  snapshot: AbilityProfile;
  /** S3 软挂起标记：插入时可直接带值（默认 null）；详见 StoredProfile.removalRequestedAt */
  removalRequestedAt?: string | null;
}

/** Drizzle 查询返回的原始行（camelCase），两方言结构一致 */
export interface RawProfileRow {
  id: string;
  analyzerVersion: string;
  subjectPlatform: string;
  subjectLogin: string;
  subjectClaimed: boolean;
  dataWindowSince: string;
  dataWindowUntil: string;
  analysisLayers: string;
  status: string;
  snapshot: string;
  /** 017 之前写入的旧行没有这一列（Drizzle 返回 undefined），归一为 null */
  removalRequestedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 快照读取一律经此函数：JSON 或契约解析失败返回 null，不向调用方抛错 */
function parseSnapshot(raw: string): AbilityProfile | null {
  try {
    return parseAbilityProfile(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function toStoredProfile(row: RawProfileRow): StoredProfile {
  let layers: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.analysisLayers);
    if (Array.isArray(parsed)) layers = parsed.map(String);
  } catch {
    layers = [];
  }
  return {
    id: row.id,
    analyzerVersion: row.analyzerVersion,
    subjectPlatform: row.subjectPlatform,
    subjectLogin: row.subjectLogin,
    subjectClaimed: row.subjectClaimed,
    dataWindowSince: row.dataWindowSince,
    dataWindowUntil: row.dataWindowUntil,
    analysisLayers: layers,
    status: (PROFILE_STATUSES as readonly string[]).includes(row.status)
      ? (row.status as ProfileStatus)
      : 'error',
    snapshot: parseSnapshot(row.snapshot),
    removalRequestedAt: row.removalRequestedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
