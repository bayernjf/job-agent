import type { NewLlmCatalogModel, StoredLlmCatalogModel } from '../entities/index.js';

/**
 * llm_catalog_models 仓储契约（迁移 024，内置模型目录，design-llm-model-
 * provisioning-20261003 §4.2）。业务模块只依赖此异步接口，不感知方言。
 *
 * 白名单不变量：仓储只读写本表字段；baseUrl/apiKey 永远在 env，本仓储
 * 没有对应列可写。enabled=false 视为下架，读取层照常返回、由调用方决定
 * 是否放行（停用即报错，不静默降级）。
 */
export interface ILlmCatalogRepository {
  /** 全量目录（按 sort_order 升序；用于启动加载与 admin 展示）。 */
  listAll(): Promise<StoredLlmCatalogModel[]>;
  /**
   * 整体替换目录（admin PUT 语义）：事务内删除全部旧行并插入新行。
   * 传入行必须已含 createdAt/updatedAt（由调用方填充）。
   */
  replaceAll(models: readonly NewLlmCatalogModel[]): Promise<void>;
  /** 取单个模型（请求路由按默认/指定 id 查找用）。 */
  getById(id: string): Promise<StoredLlmCatalogModel | undefined>;
}
