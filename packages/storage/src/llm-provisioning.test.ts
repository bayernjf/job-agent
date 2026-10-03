import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './sqlite/migrator.js';
import { openSqlite } from './sqlite/connection.js';
import { SqliteLlmCatalogRepository } from './sqlite/llm-catalog-repo.js';
import { SqliteUserLlmConfigsRepository } from './sqlite/user-llm-configs-repo.js';
import { SqliteAccountsRepository } from './sqlite/accounts-repo.js';
import type { ProviderIdentity } from './entities/index.js';
import type { LlmCatalogModality, StoredUserLlmConfig } from '@jobagent/shared';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../db/migrations/sqlite',
);

const TEXT: LlmCatalogModality = 'text';

function fresh() {
  const { client, db } = openSqlite(':memory:');
  runMigrations(client, MIGRATIONS_DIR);
  return {
    catalog: new SqliteLlmCatalogRepository(db),
    configs: new SqliteUserLlmConfigsRepository(db),
    accounts: new SqliteAccountsRepository(db),
    close: () => client.close(),
  };
}

function githubIdentity(login: string, providerAccountId: string): ProviderIdentity {
  return {
    platform: 'github',
    providerAccountId,
    login,
    name: `Name ${login}`,
    email: `${login}@example.com`,
    avatarUrl: `https://avatars.githubusercontent.com/u/${providerAccountId}`,
  };
}

describe('llm_catalog_models 仓储（迁移 024）', () => {
  it('replaceAll 整体替换：旧行删除、新行按 sort_order 倒序返回', async () => {
    const { catalog, close } = fresh();
    try {
      const now = '2026-10-03T00:00:00.000Z';
      await catalog.replaceAll([
        { id: 'm1', provider: 'agnes', model: 'agnes-2.5-flash', enabled: true, isDefault: true, sortOrder: 0, modalities: [TEXT], createdAt: now, updatedAt: now },
        { id: 'm2', provider: 'agnes', model: 'agnes-2.5-pro', enabled: true, isDefault: false, sortOrder: 1, modalities: [TEXT], createdAt: now, updatedAt: now },
      ]);
      let all = await catalog.listAll();
      expect(all.map((m) => m.id)).toEqual(['m2', 'm1']);

      // 整体替换：m1 应消失，m3 进入
      await catalog.replaceAll([
        { id: 'm3', provider: 'other', model: 'gpt-x', enabled: true, isDefault: true, sortOrder: 0, modalities: [TEXT], createdAt: now, updatedAt: now },
      ]);
      all = await catalog.listAll();
      expect(all.map((m) => m.id)).toEqual(['m3']);
      expect(all[0]!.provider).toBe('other');
    } finally {
      close();
    }
  });

  it('modalities JSON 解析 + 空表返回空数组', async () => {
    const { catalog, close } = fresh();
    try {
      expect(await catalog.listAll()).toEqual([]);
      const now = '2026-10-03T00:00:00.000Z';
      await catalog.replaceAll([
        { id: 'm1', provider: 'agnes', model: 'agnes-2.5-flash', enabled: true, isDefault: true, sortOrder: 0, modalities: [TEXT], createdAt: now, updatedAt: now },
      ]);
      const [row] = await catalog.listAll();
      expect(row!.modalities).toEqual([TEXT]);
      expect((await catalog.getById('m1'))!.enabled).toBe(true);
      expect(await catalog.getById('nope')).toBeUndefined();
    } finally {
      close();
    }
  });

  it('replaceAll 是事务：中途失败旧目录不动（校验重复主键触发）', async () => {
    const { catalog, close } = fresh();
    try {
      const now = '2026-10-03T00:00:00.000Z';
      await catalog.replaceAll([
        { id: 'keep', provider: 'agnes', model: 'agnes-2.5-flash', enabled: true, isDefault: true, sortOrder: 0, modalities: [TEXT], createdAt: now, updatedAt: now },
      ]);
      await expect(
        catalog.replaceAll([
          { id: 'dup-a', provider: 'a', model: 'a', enabled: true, isDefault: true, sortOrder: 0, modalities: [TEXT], createdAt: now, updatedAt: now },
          { id: 'dup-a', provider: 'b', model: 'b', enabled: false, isDefault: false, sortOrder: 1, modalities: [TEXT], createdAt: now, updatedAt: now },
        ]),
      ).rejects.toThrow();
      const all = await catalog.listAll();
      expect(all.map((m) => m.id)).toEqual(['keep']);
    } finally {
      close();
    }
  });
});

describe('user_llm_configs 仓储（迁移 025）', () => {
  it('upsert 一账号一行 + delete 清除', async () => {
    const { configs, close } = fresh();
    try {
      const now = '2026-10-03T00:00:00.000Z';
      const cfg: StoredUserLlmConfig = {
        accountId: 'acc-1',
        provider: 'custom',
        baseUrl: 'https://apihub.agnes-ai.com/v1',
        model: 'agnes-2.5-flash',
        apiKeyEncrypted: 'ciphertext-v1',
        createdAt: now,
        updatedAt: now,
      };
      await configs.upsert(cfg);
      expect((await configs.getByAccountId('acc-1'))!.apiKeyEncrypted).toBe('ciphertext-v1');

      // 同账号二次 upsert = 覆盖（不新增行）
      await configs.upsert({ ...cfg, apiKeyEncrypted: 'ciphertext-v2', updatedAt: now });
      const rows = (await configs.getByAccountId('acc-1'))!;
      expect(rows.apiKeyEncrypted).toBe('ciphertext-v2');

      await configs.deleteByAccountId('acc-1');
      expect(await configs.getByAccountId('acc-1')).toBeUndefined();
    } finally {
      close();
    }
  });
});

describe('accounts.is_admin（迁移 023）', () => {
  it('新账号默认非 admin；setAdmin 置位/撤销幂等', async () => {
    const { accounts, close } = fresh();
    try {
      const acc = await accounts.upsertFromProvider({
        id: 'acc-1',
        identity: githubIdentity('bayernjf', '1001'),
      });
      expect(acc.isAdmin).toBe(false);

      const promoted = await accounts.setAdmin('acc-1', true);
      expect(promoted!.isAdmin).toBe(true);
      // 幂等重复置位
      expect((await accounts.setAdmin('acc-1', true))!.isAdmin).toBe(true);

      const demoted = await accounts.setAdmin('acc-1', false);
      expect(demoted!.isAdmin).toBe(false);

      // 账号不存在返回 undefined
      expect(await accounts.setAdmin('nope', true)).toBeUndefined();
    } finally {
      close();
    }
  });
});
