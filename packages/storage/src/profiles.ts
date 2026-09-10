import { and, desc, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { parseAbilityProfile, type AbilityProfile } from '@jobagent/shared';
import { profiles as profilesTable, type ProfileSelect } from './schema.js';

/**
 * profiles 仓储——所有 DB 访问的唯一入口（AGENTS.md「数据访问抽象层」）。
 * 对外只暴露 camelCase 领域类型，调用方不感知 Drizzle/方言。
 * 快照以 JSON 字符串存储（不可变），读取时经 shared 的 parseAbilityProfile 校验解析。
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

/** 快照读取一律经此函数：JSON 或契约解析失败返回 null，不向调用方抛错 */
function parseSnapshot(raw: string): AbilityProfile | null {
  try {
    return parseAbilityProfile(JSON.parse(raw));
  } catch {
    return null;
  }
}

function toStoredProfile(row: ProfileSelect): StoredProfile {
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

export class ProfilesRepository {
  constructor(private readonly db: BetterSQLite3Database) {}

  insert(profile: NewProfile): void {
    this.db
      .insert(profilesTable)
      .values({
        id: profile.id,
        analyzerVersion: profile.analyzerVersion,
        subjectPlatform: profile.subjectPlatform ?? 'github',
        subjectLogin: profile.subjectLogin,
        subjectClaimed: profile.subjectClaimed ?? false,
        dataWindowSince: profile.dataWindowSince,
        dataWindowUntil: profile.dataWindowUntil,
        analysisLayers: JSON.stringify(profile.analysisLayers ?? ['L0', 'L1']),
        status: profile.status ?? 'partial',
        snapshot: JSON.stringify(profile.snapshot),
      })
      .run();
  }

  getById(id: string): StoredProfile | undefined {
    const row = this.db.select().from(profilesTable).where(eq(profilesTable.id, id)).get();
    return row ? toStoredProfile(row) : undefined;
  }

  listBySubject(
    subjectPlatform: string,
    subjectLogin: string,
    limit = 20,
  ): StoredProfile[] {
    const rows = this.db
      .select()
      .from(profilesTable)
      .where(
        and(
          eq(profilesTable.subjectPlatform, subjectPlatform),
          eq(profilesTable.subjectLogin, subjectLogin),
        ),
      )
      .orderBy(desc(profilesTable.createdAt))
      .limit(limit)
      .all();
    return rows.map(toStoredProfile);
  }

  latestBySubject(subjectPlatform: string, subjectLogin: string): StoredProfile | undefined {
    return this.listBySubject(subjectPlatform, subjectLogin, 1)[0];
  }

  updateStatus(id: string, status: ProfileStatus): void {
    this.db
      .update(profilesTable)
      .set({ status, updatedAt: new Date().toISOString() })
      .where(eq(profilesTable.id, id))
      .run();
  }
}
