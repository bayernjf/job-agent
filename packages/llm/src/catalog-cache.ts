/**
 * 内置目录进程内缓存（design §4.2：启动加载一次 + admin 写入后显式刷新）。
 *
 * 形态：仓储读出的 admin 行缓存在内存里，get() 每次现算
 * mergeBuiltinCatalog(defaults, storedRows)（纯函数、可测），因此
 * admin 写入 → refresh(rows) → 下一请求立即生效，无需重启。
 */
import type { LlmCatalogModel } from '@jobagent/shared';
import {
  BUILTIN_CATALOG_DEFAULTS,
  mergeBuiltinCatalog,
  type BuiltinCatalogDefaults,
} from './catalog.js';

export interface CatalogCache {
  /** 当前合并后目录（admin 行 + 白名单合并 + 空表回默认）。 */
  get(): readonly LlmCatalogModel[];
  /** admin 写入后显式刷新缓存；返回刷新后的目录。 */
  refresh(adminRows: readonly LlmCatalogModel[]): readonly LlmCatalogModel[];
  /** 回退默认目录（空表语义 / 测试重置）。 */
  reset(): readonly LlmCatalogModel[];
}

/** 构建目录缓存；defaults 可注入（测试用），缺省代码内默认目录。 */
export function createCatalogCache(
  defaults: BuiltinCatalogDefaults = BUILTIN_CATALOG_DEFAULTS,
): CatalogCache {
  let stored: readonly LlmCatalogModel[] = [];
  return {
    get: () => mergeBuiltinCatalog(defaults, stored),
    refresh: (rows) => {
      stored = [...rows];
      return mergeBuiltinCatalog(defaults, stored);
    },
    reset: () => {
      stored = [];
      return mergeBuiltinCatalog(defaults, stored);
    },
  };
}
