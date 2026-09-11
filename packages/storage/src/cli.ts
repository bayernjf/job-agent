#!/usr/bin/env node
/**
 * 迁移 CLI（本地开发工具）。
 *
 * 用法：
 *   tsx src/cli.ts up   [dbPath] [migrationsDir]
 *   tsx src/cli.ts down [dbPath] [migrationsDir]
 *   tsx src/cli.ts status [dbPath] [migrationsDir]
 *
 * 默认：data/job-agent.db + db/migrations/sqlite。
 * Postgres 迁移在 W3-6 后续提交经 DB_DRIVER=postgres + DATABASE_URL 接入。
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB_PATH = path.resolve(__dirname, '../../../data/job-agent.db');
const DEFAULT_MIGRATIONS_DIR = path.resolve(__dirname, '../../../db/migrations/sqlite');

const command = process.argv[2] ?? 'status';
const dbPath = process.argv[3] ?? DEFAULT_DB_PATH;
const migrationsDir = process.argv[4] ?? DEFAULT_MIGRATIONS_DIR;

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
