import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

/**
 * SQLite 连接工厂（仅持久化层内部使用）。
 * 仓储查询通过显式表对象进行，因此这里不向 drizzle 注入 schema 泛型，
 * 以保持与各仓储构造参数的裸 BetterSQLite3Database 类型一致。
 * readonly 连接不得执行 PRAGMA journal_mode（会报 attempt to write a readonly database）。
 */
export interface SqliteConnection {
  client: Database.Database;
  db: BetterSQLite3Database;
}

export function openSqlite(
  sqlitePath: string,
  opts: { readonly?: boolean } = {},
): SqliteConnection {
  const client = new Database(sqlitePath, {
    readonly: opts.readonly ?? false,
    fileMustExist: false,
  });
  const db = drizzle(client);
  return { client, db };
}
