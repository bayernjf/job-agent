/**
 * 内置模型目录（decision #21-0，agent-world model-catalog 对齐）。
 *
 * 核心不变量：
 * 1. **白名单合并**：admin 数据（llm_catalog_models 表）只能覆盖
 *    enabled / isDefault / sortOrder / modalities 四个字段；
 *    baseUrl / apiKey 永远来自服务端 env（LLM_BASE_URL / LLM_API_KEY），
 *    本模块的结构上就没有凭证字段可被数据覆盖。
 * 2. **空表回退**：目录表为空（初始状态）→ 使用代码内默认目录；
 *    表非空 → 以表为唯一事实源（admin 删掉某模型即下架，不偷偷复活默认行）。
 * 3. **停用即报错**：enabled=false 的模型被请求时抛 CatalogModelError
 *    （MODEL_RETIRED / PROVIDER_DISABLED），不静默降级到别的模型。
 */
import type { LlmCatalogModel, LlmCatalogModality } from '@jobagent/shared';

/** 代码内默认内置目录（git 内）。表初始为空时回退到此目录。 */
export const BUILTIN_CATALOG_DEFAULTS: readonly LlmCatalogModel[] = [
  {
    id: 'agnes-2.5-flash',
    provider: 'agnes',
    model: 'agnes-2.5-flash',
    enabled: true,
    isDefault: true,
    sortOrder: 0,
    modalities: ['text'],
  },
];

/** 默认目录类型（可注入自定义目录做测试）。 */
export type BuiltinCatalogDefaults = readonly LlmCatalogModel[];

/** admin 数据允许覆盖的白名单键（凭证字段结构上不在此列，也进不了合并）。 */
const CATALOG_WHITELIST = ['enabled', 'isDefault', 'sortOrder', 'modalities'] as const;

type WhitelistedCatalogPatch = Pick<
  LlmCatalogModel,
  (typeof CATALOG_WHITELIST)[number]
>;

/** 白名单合并：`{...defaults, ...pick(adminRow, whitelist)}`（agent-world 不变量）。 */
function pickWhitelisted(row: LlmCatalogModel): WhitelistedCatalogPatch {
  return {
    enabled: row.enabled,
    isDefault: row.isDefault,
    sortOrder: row.sortOrder,
    modalities:
      row.modalities.length > 0 ? row.modalities : (['text'] as LlmCatalogModality[]),
  };
}

/**
 * 合并默认目录与 admin 目录（纯函数，无 I/O）。
 * - adminRows 为空 → 返回默认目录（初始状态 / 全部删除即回默认）。
 * - adminRows 非空 → 以表为唯一事实源：默认目录里的同名模型按白名单被覆盖，
 *   表新增的模型直接采用，默认目录中表未列出的模型视为下架（不复活）。
 */
export function mergeBuiltinCatalog(
  defaults: readonly LlmCatalogModel[],
  adminRows: readonly LlmCatalogModel[],
): LlmCatalogModel[] {
  if (adminRows.length === 0) return [...defaults];
  const byId = new Map(defaults.map((m) => [m.id, m]));
  return adminRows
    .map((row) => {
      const base = byId.get(row.id);
      if (!base) {
        // 新增模型：白名单天然成立（结构上无凭证字段），直接采用
        return {
          ...row,
          modalities:
            row.modalities.length > 0 ? row.modalities : (['text'] as LlmCatalogModality[]),
        };
      }
      return { ...base, ...pickWhitelisted(row) };
    })
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
}

/** 目录解析错误：下架/停用模型被请求（design §4.2：停用即报错，不静默降级）。 */
export class CatalogModelError extends Error {
  constructor(
    message: string,
    readonly code: 'MODEL_RETIRED' | 'PROVIDER_DISABLED' | 'PROVIDER_UNSUPPORTED',
  ) {
    super(message);
    this.name = 'CatalogModelError';
  }
}

/**
 * 解析请求实际使用的内置模型（纯函数）。
 * - modelId 省略 → 该模态唯一默认（isDefault && enabled && 含该模态）；
 *   无可用默认抛 PROVIDER_DISABLED。
 * - modelId 指定 → 返回该模型；不存在抛 PROVIDER_UNSUPPORTED；存在但
 *   enabled=false 抛 MODEL_RETIRED（下架即报错）。
 */
export function resolveBuiltinModel(
  catalog: readonly LlmCatalogModel[],
  modality: LlmCatalogModality,
  opts: { modelId?: string } = {},
): LlmCatalogModel {
  const { modelId } = opts;
  if (modelId) {
    const model = catalog.find((m) => m.id === modelId);
    if (!model) {
      throw new CatalogModelError(
        `built-in model ${JSON.stringify(modelId)} is not in the catalog`,
        'PROVIDER_UNSUPPORTED',
      );
    }
    if (!model.enabled) {
      throw new CatalogModelError(
        `built-in model ${JSON.stringify(modelId)} is retired (disabled in catalog)`,
        'MODEL_RETIRED',
      );
    }
    return model;
  }
  const fallback = catalog.find((m) => m.enabled && m.modalities.includes(modality));
  const def = catalog.find(
    (m) => m.isDefault && m.enabled && m.modalities.includes(modality),
  );
  const chosen = def ?? fallback;
  if (!chosen) {
    throw new CatalogModelError(
      `no enabled built-in model available for modality ${modality}`,
      'PROVIDER_DISABLED',
    );
  }
  return chosen;
}
