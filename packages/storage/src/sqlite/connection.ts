import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

/**
 * SQLite 连接工厂（仅持久化层内部使用）。
 * 仓储查询通过显式表对象进行，因此这里不向 drizzle 注入 schema 泛型，
 * 以保持与各仓储构造参数的裸 BetterSQLite3Database 类型一致。
 *
 * 可写连接开 WAL；readonly 连接不得执行 PRAGMA journal_mode（会报
 * attempt to write a readonly database），也不需要——journal_mode 持久化在库文件头里，
 * 写入方首次打开就已落定。
 */
export interface SqliteConnection {
  client: Database.Database;
  db: BetterSQLite3Database;
}

export function openSqlite(
  sqlitePath: string,
  opts: { readonly?: boolean } = {},
): SqliteConnection {
  // 父目录必须存在（better-sqlite3 不会替调用方建目录；CI 全新 checkout 时 data/ 等
  // gitignored 目录不存在，直接打开会 "unable to open database file"）。
  mkdirSync(dirname(sqlitePath), { recursive: true });

  const readonly = opts.readonly ?? false;
  if (readonly && !existsSync(sqlitePath)) {
    // readonly 连接在 SQLite 里不能创建库文件（只读打开不存在的文件必失败）。
    // 调用方可能是"先于任何写入方启动"的 SSR/工具进程（如 CI 里 report 先于 API
    // 建库就绪）——此时先以可写模式建一个空库文件再只读打开：不迁移、不写数据，
    // 只保证文件存在，让只读连接与写入方解耦启动顺序。
    const creator = new Database(sqlitePath, { readonly: false, fileMustExist: false });
    creator.close();
  }
  // busy_timeout 刻意沿用 better-sqlite3 的 5s 默认、不抬高：该驱动是同步的，等待
  // SQLITE_BUSY 期间整个 event loop 被阻塞，长 timeout 会把"偶发争用"变成"整进程卡住"。
  // 并发争用的正解是下面的 WAL，不是更久的等待。
  const client = new Database(sqlitePath, {
    readonly,
    fileMustExist: false,
  });
  if (!readonly) {
    // WAL：API 与 worker 是分开的进程共用同一个库文件。默认的 rollback journal 下
    // 写者独占、读者被挡，claimNext 那种"事务内先读后写"因此可能把 SQLITE_BUSY
    // 抛出到仓储之外变成 500（并连带记一条失败的 cron 心跳）。WAL 让读不阻塞写、
    // 写不阻塞读。:memory: 库会静默保持 memory 模式，不报错。
    client.pragma('journal_mode = WAL');
  }
  const db = drizzle(client);
  return { client, db };
}
