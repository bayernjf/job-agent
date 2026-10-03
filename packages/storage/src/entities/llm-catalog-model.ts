/**
 * llm_catalog_models 实体（迁移 024，内置模型目录，design-llm-model-provisioning
 * 20261003 §4.2）。与方言无关的领域类型 + 纯映射逻辑（sqlite/postgres 两套仓储共享）。
 *
 * 白名单不变量（对齐 agent-world model-catalog）：admin 数据合并只允许覆盖本实体
 * 的字段；baseUrl / apiKey 永远来自 env（LLM_BASE_URL / LLM_API_KEY），结构上
 * 不可被目录覆盖。enabled=0 视为下架：请求如实报错，不静默降级。
 */
import type { LlmCatalogModality } from '@jobagent/shared';

export interface StoredLlmCatalogModel {
  id: string;
  provider: string;
  model: string;
  enabled: boolean;
  isDefault: boolean;
  sortOrder: number;
  modalities: LlmCatalogModality[];
  createdAt: string;
  updatedAt: string;
}

/** 新建目录行：id 由 admin 面提供，时间戳由仓储填充 */
export interface NewLlmCatalogModel {
  id: string;
  provider: string;
  model: string;
  enabled: boolean;
  isDefault: boolean;
  sortOrder: number;
  modalities: LlmCatalogModality[];
  createdAt: string;
  updatedAt: string;
}

/** Drizzle 查询返回的原始行（camelCase），两方言结构一致 */
export interface RawLlmCatalogModelRow {
  id: string;
  provider: string;
  model: string;
  /** 方言差异：sqlite 返回 0/1（number），pg 返回 boolean；映射时用 Boolean() 归一 */
  enabled: boolean | number;
  isDefault: boolean | number;
  sortOrder: number;
  modalities: string;
  createdAt: string;
  updatedAt: string;
}

/** 行 → 领域实体（modalities JSON 解析失败按空数组兜底并标注——由调用方决定是否放行） */
export function toStoredLlmCatalogModel(row: RawLlmCatalogModelRow): StoredLlmCatalogModel {
  let modalities: LlmCatalogModality[] = [];
  try {
    const parsed: unknown = JSON.parse(row.modalities);
    if (Array.isArray(parsed)) modalities = parsed as LlmCatalogModality[];
  } catch {
    modalities = [];
  }
  return {
    id: row.id,
    provider: row.provider,
    model: row.model,
    enabled: Boolean(row.enabled),
    isDefault: Boolean(row.isDefault),
    sortOrder: row.sortOrder,
    modalities,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** 领域实体 → 落库行（modalities 序列化为 TEXT JSON） */
export function toLlmCatalogModelRow(model: StoredLlmCatalogModel): RawLlmCatalogModelRow {
  return {
    id: model.id,
    provider: model.provider,
    model: model.model,
    enabled: model.enabled,
    isDefault: model.isDefault,
    sortOrder: model.sortOrder,
    modalities: JSON.stringify(model.modalities),
    createdAt: model.createdAt,
    updatedAt: model.updatedAt,
  };
}
