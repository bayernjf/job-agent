#!/usr/bin/env node
/**
 * 迁移 CLI（本地开发工具），支持 SQLite 与 Postgres 双方言。
 *
 * 用法：
 *   SQLite（默认）：
 *     tsx src/cli.ts up|down|status [dbPath] [migrationsDir]
 *     tsx src/cli.ts up --db <path>        # 等价于位置参数，便于脚本里显式表态
 *   Postgres（连接串取 DATABASE_URL）：
 *     tsx src/cli.ts up|down|status --driver postgres
 *     或 DB_DRIVER=postgres tsx src/cli.ts up
 *
 * SQLite 目标库优先级：`--db`/位置参数 > `DB_PATH` > 仓库根 `data/job-agent.db`，
 * 与 createStorage() 读 `DB_PATH` 的行为一致；每次执行都会先打印选中的路径与来源。
 *
 * 默认目录：sqlite → db/migrations/sqlite；postgres → db/migrations/postgres。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import {
  createSchemaMigrationsTable,
  listMigrationFiles,
  rollbackLatestMigration,
  runMigrations,
} from './sqlite/migrator.js';
import { openPostgres } from './postgres/connection.js';
import { rollbackPgMigration, runPgMigrations } from './postgres/migrator.js';
import { resolveSqliteDbPath } from './cli-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SQLITE_DEFAULT_DB = path.resolve(__dirname, '../../../data/job-agent.db');
const SQLITE_DIR = path.resolve(__dirname, '../../../db/migrations/sqlite');
const POSTGRES_DIR = path.resolve(__dirname, '../../../db/migrations/postgres');

// 解析 --driver 与 --db，其余作为位置参数
const rawArgs = process.argv.slice(2);
let driver = process.env.DB_DRIVER ?? 'sqlite';
let dbFlag: string | undefined;
const positional: string[] = [];
for (let i = 0; i < rawArgs.length; i += 1) {
  const arg = rawArgs[i]!;
  if (arg.startsWith('--driver=')) driver = arg.slice('--driver='.length);
  else if (arg === '--driver') driver = rawArgs[(i += 1)]!;
  else if (arg.startsWith('--db=')) dbFlag = arg.slice('--db='.length);
  else if (arg === '--db') dbFlag = rawArgs[(i += 1)]!;
  else positional.push(arg);
}

const command = positional[0] ?? 'status';
const explicitPath = dbFlag ?? positional[1];

async function runSqlite(): Promise<void> {
  const resolved = resolveSqliteDbPath({ argument: explicitPath, defaultPath: SQLITE_DEFAULT_DB });
  const dbPath = resolved.path;
  const migrationsDir = positional[2] ?? SQLITE_DIR;
  console.log(`[migrate] sqlite ${dbPath} (from ${resolved.source})`);
  const db = new Database(dbPath);
  try {
    if (command === 'up') {
      const result = runMigrations(db, migrationsDir);
      if (result.applied.length === 0) {
        console.log('No pending migrations. Total:', result.total);
      } else {
        console.log(`Applied ${result.applied.length} migration(s):`);
        for (const file of result.applied) console.log(`  - ${file}`);
      }
    } else if (command === 'down') {
      try {
        const result = rollbackLatestMigration(db, migrationsDir);
        console.log(`Rolled back ${result.version} (${result.file})`);
      } catch (error) {
        console.log((error as Error).message);
      }
    } else if (command === 'status') {
      createSchemaMigrationsTable(db);
      const files = listMigrationFiles(migrationsDir);
      const applied = new Set(
        (db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: string }>).map(
          (r) => r.version,
        ),
      );
      console.log('Migration status (', dbPath, '):');
      for (const file of files) {
        const mark = applied.has(file.slice(0, 3)) ? '[applied]' : '[pending]';
        console.log(`  ${mark} ${file}`);
      }
    } else {
      console.error(`Unknown command: ${command}. Use up | down | status.`);
      process.exitCode = 1;
    }
  } finally {
    db.close();
  }
}

async function runPostgres(): Promise<void> {
  // --db / 位置参数只对 SQLite 有意义；postgres 模式下静默忽略会让操作者以为
  // 自己在操作另一个库，故直接拒绝。
  if (explicitPath !== undefined) {
    throw new Error('The migration CLI takes no database path for postgres; set DATABASE_URL instead.');
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DB_DRIVER=postgres requires DATABASE_URL for the migration CLI.');
  const { client } = openPostgres(url);
  try {
    if (command === 'up') {
      const result = await runPgMigrations(client, POSTGRES_DIR);
      if (result.applied.length === 0) {
        console.log('No pending migrations. Total:', result.total);
      } else {
        console.log(`Applied ${result.applied.length} migration(s):`);
        for (const file of result.applied) console.log(`  - ${file}`);
      }
    } else if (command === 'down') {
      try {
        const result = await rollbackPgMigration(client, POSTGRES_DIR);
        console.log(`Rolled back ${result.version} (${result.file})`);
      } catch (error) {
        console.log((error as Error).message);
      }
    } else if (command === 'status') {
      const files = listMigrationFiles(POSTGRES_DIR);
      const rows = await client<Array<{ version: string }>>`SELECT version FROM schema_migrations`;
      const applied = new Set(rows.map((r) => r.version));
      console.log('Migration status (postgres):');
      for (const file of files) {
        const mark = applied.has(file.slice(0, 3)) ? '[applied]' : '[pending]';
        console.log(`  ${mark} ${file}`);
      }
    } else {
      console.error(`Unknown command: ${command}. Use up | down | status.`);
      process.exitCode = 1;
    }
  } finally {
    await client.end({ timeout: 5 });
  }
}

(driver === 'postgres' ? runPostgres() : runSqlite()).catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
