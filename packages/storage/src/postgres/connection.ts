import postgres from 'postgres';
import type { Sql } from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';

/**
 * Postgres 连接工厂（仅持久化层内部使用，驱动 postgres-js，技术选型 §6.5 指定）。
 * 仓储通过显式表对象查询，因此不向 drizzle 注入 schema 泛型，保持构造参数裸类型一致。
 */
export interface PgConnection {
  /** postgres-js 标签模板客户端（迁移器、事务也用它） */
  client: Sql;
  db: PostgresJsDatabase;
}

export function openPostgres(databaseUrl: string, options?: { max?: number }): PgConnection {
  const client = postgres(databaseUrl, { max: options?.max ?? 10 });
  const db = drizzle(client);
  return { client, db };
}
