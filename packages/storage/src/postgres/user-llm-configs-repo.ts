import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  toStoredUserLlmConfig,
  type StoredUserLlmConfig,
} from '../entities/index.js';
import type { IUserLlmConfigsRepository } from '../repositories/user-llm-configs.js';
import { userLlmConfigs as t } from './schema.js';

/** user_llm_configs 仓储的 Postgres 实现（迁移 025，BYOK 模型配置）。 */
export class PgUserLlmConfigsRepository implements IUserLlmConfigsRepository {
  constructor(private readonly db: PostgresJsDatabase) {}

  async getByAccountId(accountId: string): Promise<StoredUserLlmConfig | undefined> {
    const [row] = await this.db.select().from(t).where(eq(t.accountId, accountId)).limit(1);
    return row ? toStoredUserLlmConfig(row) : undefined;
  }

  async upsert(input: StoredUserLlmConfig): Promise<StoredUserLlmConfig> {
    const rows = await this.db
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
      .returning();
    return toStoredUserLlmConfig(rows[0]!);
  }

  async deleteByAccountId(accountId: string): Promise<void> {
    await this.db.delete(t).where(eq(t.accountId, accountId));
  }
}
