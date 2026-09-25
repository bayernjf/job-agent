/**
 * 报告页 SSR 数据库连接（单例，避免 dev 热更新重复创建连接）。
 * 只读取 profiles 表，不写入。仓储内部已完成 JSON 解析与 Zod 契约校验。
 * 经 createStorage 选择方言（DB_DRIVER），readonly 连接不自动迁移、不执行 PRAGMA。
 */

import type { AbilityProfile, EvidenceItem } from '@jobagent/shared';
import {
  createStorage,
  toEvidenceItems,
  type StorageContext,
  type StoredProfile,
  type CandidateSummary,
  type CandidateSearchQuery,
  type CandidateSearchResult,
} from '@jobagent/storage';

const DB_PATH = process.env.DB_PATH ?? 'data/job-agent.db';

let storageSingleton: Promise<StorageContext> | null = null;

/** 报告页只读 storage 单例（SSR 页面/端点与认证解析共用，避免多连接）。 */
export function getStorage(): Promise<StorageContext> {
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
    const record = await loadProfileRecord(profileId);
    return record?.snapshot ?? null;
  } catch {
    return null;
  }
}

/**
 * 按 profileId 读取画像存储行（含 subjectPlatform 等列级元数据）。
 * 融合画像（platform=all）的 snapshot.subject.platform 恒为主源 'github'，
 * 只有存储行的 subjectPlatform 列能标识"双源融合"，供头部展示融合徽标。
 * 画像不存在返回 null；DB 查询异常（连接失败/表缺失）**上抛**——
 * T25 失败显式化：调用方须区分"画像不存在"(404/notfound) 与"暂时不可用"(503)，
 * 不再把数据库故障伪装成"这个画像不存在"。
 */
export async function loadProfileRecord(profileId: string): Promise<StoredProfile | null> {
  const storage = await getStorage();
  return (await storage.profiles.getById(profileId)) ?? null;
}

/**
 * 按 profileId 读取证据明细（含完整外链 URL）。
 * 画像快照里只存 evidenceId，核验视图/面试准备包需要可点击的原始链接，故单独加载。
 * 不存在或失败返回空数组（降级为不展示外链，不拖垮整页）。
 */
export async function loadEvidence(profileId: string): Promise<EvidenceItem[]> {
  try {
    const storage = await getStorage();
    const rows = await storage.evidence.listByProfile(profileId);
    return toEvidenceItems(rows);
  } catch {
    return [];
  }
}


/**
 * 人才库页首屏候选人（SSR 直连只读 storage，与报告页同源）。
 * 仅取默认第一页；岛屿上的过滤/分页交互改走 GET /candidates（同源 API）。
 * 任何失败降级为空结果，不阻塞页面渲染。
 */
export async function loadInitialCandidates(
  query: CandidateSearchQuery = {},
): Promise<CandidateSearchResult> {
  try {
    const storage = await getStorage();
    return await storage.profiles.searchCandidates(query);
  } catch {
    return { items: [] as CandidateSummary[], total: 0 };
  }
}
