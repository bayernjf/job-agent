/**
 * model-hub 目录同步（W5-1）。
 *
 * 内置面不再由本地 admin 手工维护：本服务用 @model-hub/model-kit 拉取 hub
 * 投影，把**文本模型元数据**同步到 llm_catalog_models（本地缓存表，加
 * source='hub' / revision / assignment_id），并刷新进程内 catalogCache。
 *
 * 凭证纪律：hub 投影含 api_key，但**绝不落本地表**——它只留在 model-kit 的
 * 0600 缓存里，运行时由 hub 解析（见 llm-resolve）。这样本地表仍保持纯元数据，
 * 与既有「凭证不进目录」的白名单不变量一致。
 *
 * job-agent 只消费文本模型，非文本投影不进本地表。
 */
import {
  initModelKit,
  type ModelKit,
  type ResolvedModel,
} from '@model-hub/model-kit';
import { providerFromBaseUrl, type CatalogCache } from '@jobagent/llm';
import type { NewLlmCatalogModel } from '@jobagent/storage';
import type { LlmCatalogModel } from '@jobagent/shared';
import type { ApiRepos } from './routes/types.js';

export interface HubCatalogConfig {
  hubUrl: string;
  token: string;
  cachePath: string;
  fetchImpl?: typeof fetch;
}

export interface HubSyncResult {
  /** 同步所依据的 hub catalog revision。 */
  revision: number;
  /** 拉到的文本模型数。 */
  pulled: number;
  /** 写入本地表的行数。 */
  synced: number;
}

export interface HubCatalog {
  readonly kit: ModelKit;
  /** 拉取最新投影并同步到本地表 + 刷新缓存。 */
  sync(): Promise<HubSyncResult>;
  /** L3：验证 token 与清单可达。 */
  ping(): ReturnType<ModelKit['pingHub']>;
  /** L4：按 alias 解析并跑最小真实调用。 */
  test(
    alias: string,
    opts?: { deep?: boolean },
  ): ReturnType<ModelKit['testConnection']>;
}

/** 投影文本模型 → 本地目录行（纯元数据；凭证不进表）。 */
function projectToCatalog(models: readonly ResolvedModel[]): LlmCatalogModel[] {
  let defaultAssigned = false;
  return models.map((m, index) => {
    const isPrimary = m.role === 'primary';
    const isDefault = isPrimary && !defaultAssigned;
    if (isDefault) defaultAssigned = true;
    return {
      id: m.alias ?? m.assignmentId,
      provider: providerFromBaseUrl(m.baseUrl),
      model: m.model,
      enabled: true,
      isDefault,
      sortOrder: index,
      modalities: ['text'],
    } satisfies LlmCatalogModel;
  });
}

/** 投影文本模型 → 落库行（含 hub 投影字段）。 */
function projectToRows(
  models: readonly ResolvedModel[],
  catalog: readonly LlmCatalogModel[],
  revision: number,
  now: string,
): NewLlmCatalogModel[] {
  return models.map((m, index) => {
    // catalog is projectToCatalog(models), so indices line up by construction.
    const base = catalog[index];
    if (!base) throw new Error('catalog projection index mismatch');
    return {
      ...base,
      source: 'hub',
      revision,
      assignmentId: m.assignmentId,
      createdAt: now,
      updatedAt: now,
    };
  });
}

/**
 * 构建 hub 目录同步服务：初始化 model-kit（拉取 + 缓存兜底），但不立即写库
 * （首次写库由 sync() 触发，通常在启动后或 admin 手动同步时）。
 */
export async function createHubCatalog(
  config: HubCatalogConfig,
  repos: ApiRepos,
  catalogCache: CatalogCache,
): Promise<HubCatalog> {
  const kit = await initModelKit({
    hubUrl: config.hubUrl,
    token: config.token,
    cachePath: config.cachePath,
    ...(config.fetchImpl ? { fetch: config.fetchImpl } : {}),
  });

  const sync = async (): Promise<HubSyncResult> => {
    await kit.refresh();
    const textModels = kit.list('text');
    const catalog = projectToCatalog(textModels);
    const revision = kit.revision ?? 0;
    const now = new Date().toISOString();
    const rows = projectToRows(textModels, catalog, revision, now);
    await repos.llmCatalog.replaceAll(rows);
    catalogCache.refresh(catalog);
    return { revision, pulled: textModels.length, synced: rows.length };
  };

  return {
    kit,
    sync,
    ping: () => kit.pingHub(),
    test: (alias, opts) => kit.testConnection(alias, { deep: opts?.deep }),
  };
}
