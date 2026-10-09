/**
 * search_presets 实体：用户保存的筛选条件预设（迁移 032，设计 §3）。
 *
 * 预设是"搜索配方"：把一次搜岗的自然语言指令（query）+ 结构化条件（conditions）
 * 保存下来，可随时用预设再搜、可删除。与 job_preferences 并存：前者是搜索配方
 * （一次性的），后者是求职任务偏好（长期监控）。conditions 的单一事实源在
 * `@jobagent/shared`（SearchConditionsSchema），本层只做 DB 文本 ↔ 领域值收敛。
 */
import { SearchConditionsSchema, type SearchConditions } from '@jobagent/shared';
import { parseJson } from './analysis-job.js';

export interface RawSearchPresetRow {
  presetId: string;
  accountId: string;
  title: string | null;
  query: string;
  conditions: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredSearchPreset {
  presetId: string;
  /** 归属账号（accounts.id）；预设是登录用户的私有数据 */
  accountId: string;
  /** 用户命名（可选；null = 用 query 截断展示） */
  title: string | null;
  /** 原始指令文本（自然语言，可追溯） */
  query: string;
  /** 解析后的结构化搜索条件 */
  conditions: SearchConditions;
  createdAt: string;
  updatedAt: string;
}

export interface NewSearchPreset {
  presetId: string;
  accountId: string;
  title?: string | null;
  query: string;
  conditions: SearchConditions;
  createdAt: string;
  updatedAt: string;
}

export function toStoredSearchPreset(row: RawSearchPresetRow): StoredSearchPreset {
  const parsed = SearchConditionsSchema.safeParse(parseJson(row.conditions));
  if (!parsed.success) {
    throw new Error(`search preset ${row.presetId}: invalid conditions JSON (${parsed.error.message})`);
  }
  return {
    presetId: row.presetId,
    accountId: row.accountId,
    title: row.title,
    query: row.query,
    conditions: parsed.data,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
