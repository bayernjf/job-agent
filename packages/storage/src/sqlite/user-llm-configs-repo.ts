import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  toStoredUserLlmConfig,
  type StoredUserLlmConfig,
} from '../entities/index.js';
import type { IUserLlmConfigsRepository } from '../repositories/user-llm-configs.js';
import { userLlmConfigs as t } from './schema.js';

/** user_llm_configs 仓储的 SQLite 实现（迁移 025，BYOK 模型配置）。 */
export class SqliteUserLlmConfigsRepository implements IUserLlmConfigsRepository {
  constructor(private readonly db: BetterSQLite3Database) {}

  async getByAccountId(accountId: string): Promise<StoredUserLlmConfig | undefined> {
    const [row] = this.db.select().from(t).where(eq(t.accountId, accountId)).limit(1).all();
    return row ? toStoredUserLlmConfig(row) : undefined;
  }

  async upsert(input: StoredUserLlmConfig): Promise<StoredUserLlmConfig> {
    this.db
      .insert(t)
      .values({
        accountId: input.accountId,
        provider: input.provider,
        baseUrl: input.baseUrl,
        model: input.model,
        apiKeyEncrypted: input.apiKeyEncrypted,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
      })
      .onConflictDoUpdate({
        target: t.accountId,
        set: {
          provider: input.provider,
          baseUrl: input.baseUrl,
          model: input.model,
          apiKeyEncrypted: input.apiKeyEncrypted,
          updatedAt: input.updatedAt,
        },
      })
      .run();
    return input;
  }

  async deleteByAccountId(accountId: string): Promise<void> {
    this.db.delete(t).where(eq(t.accountId, accountId)).run();
  }
}
