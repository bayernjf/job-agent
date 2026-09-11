/**
 * 报告页 SSR 数据库连接（单例，避免 dev 热更新重复创建连接）。
 * 只读取 profiles 表，不写入。仓储内部已完成 JSON 解析与 Zod 契约校验。
 * 经 createStorage 选择方言（DB_DRIVER），readonly 连接不自动迁移、不执行 PRAGMA。
 */

import type { AbilityProfile } from '@jobagent/shared';
import { createStorage, type StorageContext } from '@jobagent/storage';

const DB_PATH = process.env.DB_PATH ?? 'data/job-agent.db';

let storageSingleton: Promise<StorageContext> | null = null;

function getStorage(): Promise<StorageContext> {
  if (!storageSingleton) {
    // readonly：报告页只读不写；createStorage 在 readonly 下不跑迁移、不设 journal_mode，
    // 避免 "attempt to write a readonly database"
    storageSingleton = createStorage({ readonly: true, sqlitePath: DB_PATH });
  }
  return storageSingleton;
}

/** 按 profileId 读取画像快照；不存在或解析失败返回 null */
export async function loadProfile(profileId: string): Promise<AbilityProfile | null> {
  try {
    const storage = await getStorage();
    const record = await storage.profiles.getById(profileId);
    return record?.snapshot ?? null;
  } catch {
    return null;
  }
}
