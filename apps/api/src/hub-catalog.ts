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
  type DriverFactory,
  type ModelKit,
  type ResolvedModel,
  type TestResult,
} from '@model-hub/model-kit';
import {
  LlmCoverLetterProvider,
  LlmResumePolishProvider,
  OpenAICompatibleClient,
  providerFromBaseUrl,
  type CatalogCache,
  type CoverLetterProvider,
  type LlmFetch,
  type MeteredResumePolishProvider,
} from '@jobagent/llm';
import { LlmResponseError } from '@jobagent/llm';
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

export interface ResolvedBuiltin {
  cover: CoverLetterProvider;
  polish: MeteredResumePolishProvider;
  /** 解析到的 hub 投影模型（含 assignmentId/定价，供用量上报）。 */
  model: ResolvedModel;
}

export interface HubCatalog {
  readonly kit: ModelKit;
  /** 拉取最新投影并同步到本地表 + 刷新缓存。 */
  sync(): Promise<HubSyncResult>;
  /**
   * 解析内置面 provider：取 hub 投影的主文本模型（凭证来自 kit 缓存），
   * 构造 cover/polish。无文本模型时返回 null（调用方按 none 处理）。
   */
  resolveBuiltin(): Promise<ResolvedBuiltin | null>;
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

/** 把 LlmClient 失败映射为 L4 结果错误码。 */
function mapClientError(err: unknown): TestResult['error'] {
  if (err instanceof LlmResponseError) {
    const status = err.detail?.status;
    if (status === 401) return { code: 'unauthorized' };
    if (status === 403) return { code: 'forbidden' };
    if (status === 404) return { code: 'model_not_found' };
    if (status === 429) return { code: 'rate_limited' };
    if (err.detail?.kind === 'timeout') return { code: 'network', hint: 'timed out' };
    return { code: 'server_error', detail: err.message };
  }
  return { code: 'network', detail: err instanceof Error ? err.message : String(err) };
}

/**
 * L4 driver factory：用 job-agent 自己的 LlmClient（OpenAICompatibleClient）
 * 跑最小 JSON 调用，验证模型能完成 job-agent 实际需要的 JSON 任务，而不是
 * 走 model-kit 的通用 probe。fetchImpl 透传（测试用假 fetch，生产用真实 fetch）。
 */
function createLlmDriverFactory(fetchImpl?: LlmFetch): DriverFactory {
  return (model: ResolvedModel) => ({
    probe: async () => {
      const start = Date.now();
      const client = new OpenAICompatibleClient({
        baseUrl: model.baseUrl,
        apiKey: model.apiKey,
        model: model.model,
        provider: providerFromBaseUrl(model.baseUrl),
        ...(fetchImpl ? { fetchImpl } : {}),
      });
      try {
        await client.generateJson({
          messages: [
            { role: 'system', content: 'Reply with a JSON object.' },
            { role: 'user', content: 'Return {"ok":true}' },
          ],
          temperature: 0,
        });
        return { ok: true, latency_ms: Date.now() - start, scope: 'L4' };
      } catch (err) {
        return {
          ok: false,
          latency_ms: Date.now() - start,
          scope: 'L4',
          error: mapClientError(err),
        };
      }
    },
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
  const driverFactory = createLlmDriverFactory(config.fetchImpl as LlmFetch | undefined);

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

  const resolveBuiltin = async (): Promise<ResolvedBuiltin | null> => {
    let primary: ResolvedModel;
    try {
      primary = kit.primary('text');
    } catch {
      return null;
    }
    const client = new OpenAICompatibleClient({
      baseUrl: primary.baseUrl,
      apiKey: primary.apiKey,
      model: primary.model,
      provider: providerFromBaseUrl(primary.baseUrl),
    });
    return {
      cover: new LlmCoverLetterProvider(client),
      polish: new LlmResumePolishProvider(client),
      model: primary,
    };
  };

  return {
    kit,
    sync,
    resolveBuiltin,
    ping: () => kit.pingHub(),
    test: (alias, opts) =>
      kit.testConnection(alias, { deep: opts?.deep, driverFactory }),
  };
}
