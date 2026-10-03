import { describe, expect, it } from 'vitest';
import type { LlmCatalogModel } from '@jobagent/shared';
import {
  BUILTIN_CATALOG_DEFAULTS,
  CatalogModelError,
  mergeBuiltinCatalog,
  resolveBuiltinModel,
} from './catalog.js';
import { createCatalogCache } from './catalog-cache.js';

const TEXT = 'text' as const;

function row(partial: Partial<LlmCatalogModel>): LlmCatalogModel {
  return {
    id: 'm1',
    provider: 'agnes',
    model: 'agnes-2.5-flash',
    enabled: true,
    isDefault: true,
    sortOrder: 0,
    modalities: [TEXT],
    ...partial,
  };
}

describe('mergeBuiltinCatalog（白名单合并不变量）', () => {
  it('空表（初始状态）回退代码默认目录', () => {
    expect(mergeBuiltinCatalog(BUILTIN_CATALOG_DEFAULTS, [])).toEqual(
      [...BUILTIN_CATALOG_DEFAULTS],
    );
  });

  it('admin 数据只能覆盖白名单字段：enabled/isDefault/sortOrder/modalities', () => {
    const admin = [
      row({
        id: 'agnes-2.5-flash',
        // 结构上不存在 baseUrl/apiKey 字段；即便尝试给 id/provider/model 传假值也不生效
        provider: 'evil-provider',
        model: 'evil-model',
        enabled: false,
        isDefault: false,
        sortOrder: 9,
      }),
    ];
    const merged = mergeBuiltinCatalog(BUILTIN_CATALOG_DEFAULTS, admin)[0]!;
    expect(merged.provider).toBe('agnes'); // 不可覆盖
    expect(merged.model).toBe('agnes-2.5-flash'); // 不可覆盖
    expect(merged.enabled).toBe(false); // 白名单可覆盖
    expect(merged.isDefault).toBe(false);
    expect(merged.sortOrder).toBe(9);
  });

  it('表非空时为唯一事实源：默认目录中未列出的模型视为下架', () => {
    const merged = mergeBuiltinCatalog(BUILTIN_CATALOG_DEFAULTS, [
      row({ id: 'brand-new', provider: 'x', model: 'x-model' }),
    ]);
    expect(merged.map((m) => m.id)).toEqual(['brand-new']);
    // 默认的 agnes-2.5-flash 不在 admin 表 → 不复活
    expect(merged.some((m) => m.id === 'agnes-2.5-flash')).toBe(false);
  });

  it('新增模型（默认目录没有的 id）直接采用 admin 行', () => {
    const merged = mergeBuiltinCatalog(BUILTIN_CATALOG_DEFAULTS, [
      row({ id: 'extra', provider: 'openai', model: 'gpt-x', modalities: [TEXT] }),
    ]);
    expect(merged[0]!.provider).toBe('openai');
    expect(merged[0]!.model).toBe('gpt-x');
  });

  it('结果按 sortOrder 升序稳定排序', () => {
    const merged = mergeBuiltinCatalog([], [
      row({ id: 'b', sortOrder: 5 }),
      row({ id: 'a', sortOrder: 1 }),
      row({ id: 'c', sortOrder: 5 }),
    ]);
    expect(merged.map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('resolveBuiltinModel（停用即报错）', () => {
  it('默认取 isDefault && enabled 且含该模态的模型', () => {
    const model = resolveBuiltinModel(BUILTIN_CATALOG_DEFAULTS, TEXT);
    expect(model.id).toBe('agnes-2.5-flash');
  });

  it('指定 id 且 enabled → 返回该模型', () => {
    const catalog = mergeBuiltinCatalog([], [row({ id: 'custom', model: 'custom-x' })]);
    expect(resolveBuiltinModel(catalog, TEXT, { modelId: 'custom' }).model).toBe('custom-x');
  });

  it('指定 id 已下架（enabled=false）→ MODEL_RETIRED', () => {
    const catalog = mergeBuiltinCatalog([], [
      row({ id: 'retired', model: 'x', enabled: false }),
    ]);
    expect(() => resolveBuiltinModel(catalog, TEXT, { modelId: 'retired' })).toThrow(
      CatalogModelError,
    );
    try {
      resolveBuiltinModel(catalog, TEXT, { modelId: 'retired' });
    } catch (e) {
      expect((e as CatalogModelError).code).toBe('MODEL_RETIRED');
    }
  });

  it('指定 id 不存在 → PROVIDER_UNSUPPORTED', () => {
    expect(() => resolveBuiltinModel([], TEXT, { modelId: 'nope' })).toThrow(
      CatalogModelError,
    );
  });

  it('无任何启用模型 → PROVIDER_DISABLED', () => {
    const catalog = mergeBuiltinCatalog([], [
      row({ id: 'off', enabled: false }),
    ]);
    expect(() => resolveBuiltinModel(catalog, TEXT)).toThrow(CatalogModelError);
    try {
      resolveBuiltinModel(catalog, TEXT);
    } catch (e) {
      expect((e as CatalogModelError).code).toBe('PROVIDER_DISABLED');
    }
  });
});

describe('createCatalogCache（启动加载一次 + 写后显式刷新）', () => {
  it('初始为默认目录；refresh 后立即生效；reset 回默认', () => {
    const cache = createCatalogCache();
    expect(cache.get().map((m) => m.id)).toEqual(['agnes-2.5-flash']);

    const refreshed = cache.refresh([row({ id: 'new-model', model: 'new-x' })]);
    expect(refreshed.map((m) => m.id)).toEqual(['new-model']);
    // 缓存行已替换，无需重启
    expect(cache.get().map((m) => m.id)).toEqual(['new-model']);

    const reset = cache.reset();
    expect(reset.map((m) => m.id)).toEqual(['agnes-2.5-flash']);
    expect(cache.get().map((m) => m.id)).toEqual(['agnes-2.5-flash']);
  });
});
