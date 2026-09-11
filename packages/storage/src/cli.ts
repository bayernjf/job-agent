import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { runMigrations, rollbackLatestMigration } from './migrator.js';

/**
 * storage CLI：migrate up / down / status。
 * 用法：node dist/cli.js migrate <up|down|status> [--db <path>]
 * 默认数据库文件：<repo>/data/job-agent.db（data/ 已 gitignore）。
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB_PATH = path.resolve(__dirname, '../../../data/job-agent.db');
const MIGRATIONS_DIR = path.resolve(__dirname, '../../../db/migrations');

function openDb(dbPath: string): Database.Database {
  return new Database(dbPath);
}

function printStatus(db: Database.Database): void {
  const rows = db
    .prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all() as Array<{ version: string }>;
  const files = runMigrations(db, MIGRATIONS_DIR);
  // runMigrations 已把未应用的全部应用；这里只需报告 applied 列表
  if (files.applied.length > 0) {
    console.log(`Applied ${files.applied.length} migration(s): ${files.applied.join(', ')}`);
  }
  const all = rows.map((r) => r.version);
  console.log(`Applied versions: ${all.length > 0 ? all.join(', ') : '(none)'}`);
  console.log(`Total migration files: ${files.total}`);
}

function main(argv: string[]): void {
  const [command, sub, ...rest] = argv;
  if (command !== 'migrate' || !['up', 'down', 'status'].includes(sub ?? '')) {
    console.error('Usage: node dist/cli.js migrate <up|down|status> [--db <path>]');
    process.exit(2);
  }

  const dbIndex = rest.indexOf('--db');
  const dbPath = dbIndex >= 0 && rest[dbIndex + 1] ? rest[dbIndex + 1]! : DEFAULT_DB_PATH;
  const db = openDb(dbPath);

  try {
    if (sub === 'up') {
      const result = runMigrations(db, MIGRATIONS_DIR);
      console.log(
        result.applied.length > 0
          ? `Applied: ${result.applied.join(', ')}`
          : 'Nothing to apply (up to date).',
      );
    } else if (sub === 'down') {
      const result = rollbackLatestMigration(db, MIGRATIONS_DIR);
      console.log(`Rolled back ${result.version} (${result.file}).`);
    } else {
      printStatus(db);
    }
  } finally {
    db.close();
  }
}

main(process.argv.slice(2));
