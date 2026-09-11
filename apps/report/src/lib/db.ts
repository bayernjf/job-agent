/**
 * 报告页 SSR 数据库连接（单例，避免 dev 热更新重复创建连接）。
 * 只读取 profiles 表，不写入。仓储内部已完成 JSON 解析与 Zod 契约校验。
 */

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { ProfilesRepository } from '@jobagent/storage';
import type { AbilityProfile } from '@jobagent/shared';

const DB_PATH = process.env.DB_PATH ?? 'data/job-agent.db';

let repositorySingleton: ProfilesRepository | null = null;

function getRepository(): ProfilesRepository {
  if (!repositorySingleton) {
    // readonly：报告页只读不写；不在此设置 journal_mode（WAL 已由写入方持久化，
    // readonly 连接执行 PRAGMA journal_mode 会触发 "attempt to write a readonly database"）
    const sqlite = new Database(DB_PATH, { readonly: true, fileMustExist: false });
    const orm = drizzle(sqlite);
    repositorySingleton = new ProfilesRepository(orm);
  }
  return repositorySingleton;
}

/** 按 profileId 读取画像快照；不存在或解析失败返回 null */
export function loadProfile(profileId: string): AbilityProfile | null {
  try {
    const repo = getRepository();
    const record = repo.getById(profileId);
    return record?.snapshot ?? null;
  } catch {
    return null;
  }
}
