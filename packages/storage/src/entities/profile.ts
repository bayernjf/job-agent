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
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
