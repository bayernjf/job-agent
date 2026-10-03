import { desc, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  toLlmCatalogModelRow,
  toStoredLlmCatalogModel,
  type NewLlmCatalogModel,
  type StoredLlmCatalogModel,
} from '../entities/index.js';
import type { ILlmCatalogRepository } from '../repositories/llm-catalog.js';
import { llmCatalogModels as t } from './schema.js';

/** llm_catalog_models 仓储的 SQLite 实现（迁移 024，内置模型目录）。 */
export class SqliteLlmCatalogRepository implements ILlmCatalogRepository {
  constructor(private readonly db: BetterSQLite3Database) {}

  async listAll(): Promise<StoredLlmCatalogModel[]> {
    const rows = this.db.select().from(t).orderBy(desc(t.sortOrder)).all();
    return rows.map(toStoredLlmCatalogModel);
  }

  async replaceAll(models: readonly NewLlmCatalogModel[]): Promise<void> {
    // 整体替换＝admin PUT 语义（design §4.2）；事务保证要么全换要么不动。
    // SQLite integer 列只接受 number：boolean 显式转 0/1（与 accounts.is_admin 同惯例）。
    this.db.transaction((tx) => {
      tx.delete(t).run();
      for (const model of models) {
        tx.insert(t)
          .values({
            id: model.id,
            provider: model.provider,
            model: model.model,
            enabled: model.enabled ? 1 : 0,
            isDefault: model.isDefault ? 1 : 0,
            sortOrder: model.sortOrder,
            modalities: JSON.stringify(model.modalities),
            createdAt: model.createdAt,
            updatedAt: model.updatedAt,
          })
          .run();
      }
    });
  }

  async getById(id: string): Promise<StoredLlmCatalogModel | undefined> {
    const [row] = this.db.select().from(t).where(eq(t.id, id)).limit(1).all();
    return row ? toStoredLlmCatalogModel(row) : undefined;
  }
}
