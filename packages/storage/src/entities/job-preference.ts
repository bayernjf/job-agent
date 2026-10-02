/**
 * job_preferences 实体：求职偏好集（求职 Agent 阶段 1，迁移 018，设计 §3.1）。
 *
 * 一套偏好回答"找什么"（岗位类型/技能/地区/远程/薪资下限/公司黑白名单），可有多套，
 * 一个求职任务（job_runs）绑定恰好一套。`MatchScoreTier` 的单一事实源在
 * `@jobagent/shared`（本层只做 DB 文本 ↔ 领域值的收敛，未知档回退 'mid'）。
 * 与方言无关的领域类型 + 纯映射逻辑（sqlite/postgres 两套仓储共享）。
 */
import { MatchScoreTierSchema, type MatchScoreTier } from '@jobagent/shared';
import { parseJson } from './analysis-job.js';

/** 匹配分三档；取自 shared 的 Zod 枚举，避免第三处手抄常量漂移 */
const MATCH_SCORE_TIERS: readonly string[] = MatchScoreTierSchema.options;

/** 可局部更新的字段（id/accountId/createdAt/updatedAt 不可改） */
export interface JobPreferencePatch {
  label?: string;
  targetTitles?: string[];
  skills?: string[];
  locations?: string[];
  remoteOnly?: boolean;
  salaryMinUsd?: number | null;
  sources?: string[];
  companyWhitelist?: string[];
  companyBlacklist?: string[];
  minTier?: MatchScoreTier;
  dailySubmitLimit?: number;
}

export interface StoredJobPreference {
  id: string;
  /** 归属账号（accounts.id）；求职任务是登录用户的私有数据 */
  accountId: string;
  label: string;
  /** 目标岗位关键词（硬过滤，至少一个） */
  targetTitles: string[];
  /** 参与加权打分的技能；空 = 用画像 skillTags.name */
  skills: string[];
  /** 地区关键词（子串过滤）；空 = 不限 */
  locations: string[];
  remoteOnly: boolean;
  /** 年化美元下限；null = 不限 */
  salaryMinUsd: number | null;
  /** 限定岗位来源；空 = 全部来源 */
  sources: string[];
  companyWhitelist: string[];
  companyBlacklist: string[];
  /** 质量闸：低于该档不进待投清单 */
  minTier: MatchScoreTier;
  /** 每源每日投递上限 */
  dailySubmitLimit: number;
  createdAt: string;
  updatedAt: string;
}

/** 入库输入：id/accountId/label/targetTitles 必填，其余走列默认值 */
export interface NewJobPreference {
  /** 由调用方生成：`pref-<uuid>` */
  id: string;
  accountId: string;
  label: string;
  targetTitles: string[];
  skills?: string[];
  locations?: string[];
  remoteOnly?: boolean;
  salaryMinUsd?: number | null;
  sources?: string[];
  companyWhitelist?: string[];
  companyBlacklist?: string[];
  minTier?: MatchScoreTier;
  dailySubmitLimit?: number;
  /** 创建时刻（UTC ISO8601），由调用方给出 */
  createdAt: string;
  updatedAt: string;
}

/** Drizzle 查询返回的原始行（camelCase）；JSON 列为 TEXT，remoteOnly 两方言可能是 boolean 或 0/1 */
export interface RawJobPreferenceRow {
  id: string;
  accountId: string;
  label: string;
  targetTitles: string;
  skills: string;
  locations: string;
  remoteOnly: boolean | number;
  salaryMinUsd: number | null;
  sources: string;
  companyWhitelist: string;
  companyBlacklist: string;
  minTier: string;
  dailySubmitLimit: number;
  createdAt: string;
  updatedAt: string;
}

/** JSON 数组列 → string[]：解析失败或非数组一律退化为空数组（宁可"不限"也不炸读） */
function parseStringArray(raw: string): string[] {
  const parsed = parseJson<unknown>(raw);
  return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
}

/** Drizzle 行 → 领域对象（纯函数，双方言共用） */
export function toStoredJobPreference(row: RawJobPreferenceRow): StoredJobPreference {
  return {
    id: row.id,
    accountId: row.accountId,
    label: row.label,
    targetTitles: parseStringArray(row.targetTitles),
    skills: parseStringArray(row.skills),
    locations: parseStringArray(row.locations),
    // SQLite 的 integer(boolean) 与 Postgres 的 boolean 都可能到这里：两种形态都吃
    remoteOnly: row.remoteOnly === true || row.remoteOnly === 1,
    salaryMinUsd: row.salaryMinUsd ?? null,
    sources: parseStringArray(row.sources),
    companyWhitelist: parseStringArray(row.companyWhitelist),
    companyBlacklist: parseStringArray(row.companyBlacklist),
    minTier: MATCH_SCORE_TIERS.includes(row.minTier)
      ? (row.minTier as MatchScoreTier)
      : 'mid',
    dailySubmitLimit: row.dailySubmitLimit,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
