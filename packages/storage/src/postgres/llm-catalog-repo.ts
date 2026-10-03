import { desc, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  toLlmCatalogModelRow,
  toStoredLlmCatalogModel,
  type NewLlmCatalogModel,
  type StoredLlmCatalogModel,
} from '../entities/index.js';
import type { ILlmCatalogRepository } from '../repositories/llm-catalog.js';
import { llmCatalogModels as t } from './schema.js';

/** llm_catalog_models 仓储的 Postgres 实现（迁移 024，内置模型目录）。 */
export class PgLlmCatalogRepository implements ILlmCatalogRepository {
  constructor(private readonly db: PostgresJsDatabase) {}

  async listAll(): Promise<StoredLlmCatalogModel[]> {
    const rows = await this.db.select().from(t).orderBy(desc(t.sortOrder));
    return rows.map(toStoredLlmCatalogModel);
  }

  async replaceAll(models: readonly NewLlmCatalogModel[]): Promise<void> {
    // 整体替换＝admin PUT 语义（design §4.2）；事务保证要么全换要么不动。
    await this.db.transaction(async (tx) => {
      await tx.delete(t);
      for (const model of models) {
        await tx.insert(t).values({
          id: model.id,
          provider: model.provider,
          model: model.model,
          enabled: model.enabled,
          isDefault: model.isDefault,
          sortOrder: model.sortOrder,
          modalities: JSON.stringify(model.modalities),
          createdAt: model.createdAt,
          updatedAt: model.updatedAt,
        });
      }
    });
  }

  async getById(id: string): Promise<StoredLlmCatalogModel | undefined> {
    const [row] = await this.db.select().from(t).where(eq(t.id, id)).limit(1);
    return row ? toStoredLlmCatalogModel(row) : undefined;
  }
}
