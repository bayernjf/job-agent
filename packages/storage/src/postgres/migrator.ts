import type { Sql } from 'postgres';
import {
  listMigrationFiles,
  parseMigrationFile,
  type RollbackResult,
  type RunMigrationsResult,
} from '../migrations-fs.js';

/**
 * Postgres 异步迁移器。文件枚举/段解析复用 migrations-fs，
 * 只负责在 postgres-js 连接上按序执行（DDL 按分号拆成简单语句逐条 await）。
 */

/**
 * 迁移串行锁的会话级 advisory lock key（任意固定 bigint）。
 * api / worker 多实例（compose 同时起、水平扩容、滚动部署）首次启动会并发迁移，
 * 必须用咨询锁串行化，否则两个进程会同时插入 schema_migrations(001) 撞主键。
 */
const MIGRATION_ADVISORY_LOCK_KEY = 74624701;

export async function createPgSchemaMigrationsTable(sql: Sql): Promise<void> {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

/** 在给定连接上按序应用未应用的迁移，返回本次新应用的文件名列表 */
export async function runPgMigrations(
  sql: Sql,
  migrationsDir: string,
): Promise<RunMigrationsResult> {
  // 独占池中的一个连接：会话级 advisory lock、建锁表、版本重读、DDL 与解锁必须落在
  // 同一连接上，否则连接池把查询分派到不同连接会令锁失效。
  const c = await sql.reserve();
  try {
    // 会话级咨询锁：同一时刻只有一个实例执行迁移；内层 finally 显式释放。
    await c`SELECT pg_advisory_lock(${MIGRATION_ADVISORY_LOCK_KEY})`;
    try {
      // 锁表创建也必须在锁内：CREATE TABLE IF NOT EXISTS 不防并发系统目录冲突
      // （两事务在对方提交前都判定不存在会撞 pg_type 唯一索引），串行化后才安全。
      await createPgSchemaMigrationsTable(c);
      // 持锁后读取已应用版本。后到实例拿锁时，先到实例已提交全部迁移，此处读到完整
      // 版本集合，从而整轮跳过、不再重复 DDL/插入。
      const appliedRows = await c<Array<{ version: string }>>`SELECT version FROM schema_migrations`;
      const appliedVersions = new Set(appliedRows.map((r) => r.version));

      const files = listMigrationFiles(migrationsDir);
      const applied: string[] = [];

      for (const file of files) {
        const version = file.slice(0, 3);
        if (appliedVersions.has(version)) continue;
        const raw = await readFile(migrationsDir, file);
        const { up } = parseMigrationFile(raw);
        // T32：一个迁移文件 = 一条事务，且整个文件作为**一条 simple query** 发送。
        // 实测（一次性 postgres:16-alpine 容器）：多语句 simple query 在 Postgres 内
        // 就是一个隐式事务——任一条失败则前面已执行的 DDL 全部回滚；顺带解决按 ';'
        // 朴素拆句会切断 `DO $$ ... $$;` 块的问题（验证 014 时两条都撞到了）。
        // 版本记录并入同一事务：要么"结构已改且已记账"，要么什么都没发生。
        await c.unsafe('BEGIN');
        try {
          await c.unsafe(up);
          // ON CONFLICT 双保险：极端情况下两个实例都判定未应用时，后者不致崩溃。
          await c`INSERT INTO schema_migrations (version) VALUES (${version}) ON CONFLICT (version) DO NOTHING`;
          await c.unsafe('COMMIT');
        } catch (err) {
          await c.unsafe('ROLLBACK');
          throw err;
        }
        applied.push(file);
      }

      return { applied, total: files.length };
    } finally {
      await c`SELECT pg_advisory_unlock(${MIGRATION_ADVISORY_LOCK_KEY})`;
    }
  } finally {
    c.release();
  }
}

async function readFile(migrationsDir: string, file: string): Promise<string> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  return fs.readFile(path.join(migrationsDir, file), 'utf8');
}

/** 回滚最新一个迁移；无 down 段时拒绝（MIGRATION_CONVENTION 第 5 节） */
export async function rollbackPgMigration(
  sql: Sql,
  migrationsDir: string,
): Promise<RollbackResult> {
  await createPgSchemaMigrationsTable(sql);
  const rows =
    await sql<Array<{ version: string }>>`SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1`;
  const row = rows[0];
  if (!row) throw new Error('No applied migration to roll back.');

  const { version } = row;
  const files = listMigrationFiles(migrationsDir).filter((f) => f.startsWith(`${version}_`));
  if (files.length !== 1) {
    throw new Error(`Cannot resolve migration file for version ${version}.`);
  }

  const raw = await readFile(migrationsDir, files[0]!);
  const { down } = parseMigrationFile(raw);
  if (!down) {
    throw new Error(
      `Migration ${version} has no safe down script; refusing to roll back (MIGRATION_CONVENTION 第 5 节).`,
    );
  }

  // T32：回滚也走单事务。此前失败的 down 脚本会把库留在"前面的 DDL 已生效、版本号还在"
  // 的半破状态（验证 014 时实测：evidence 一度没有主键而 014 仍记 applied）。
  // 用 sql.begin 而不是手写 BEGIN：postgres.js 在非 reserved 连接上禁止事务控制语句
  // （`UNSAFE_TRANSACTION`，我在本轮实测撞到）。整文件作为一条 simple query 发送，
  // 因此也不再按 ';' 拆句，`DO $$ ... $$;` 这类合法写法现在可用。
  await sql.begin(async (tx) => {
    await tx.unsafe(down);
    await tx`DELETE FROM schema_migrations WHERE version = ${version}`;
  });
  return { version, file: files[0]! };
}
