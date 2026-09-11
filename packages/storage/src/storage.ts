import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSqlite } from './sqlite/connection.js';
import { runMigrations } from './sqlite/migrator.js';
import { SqliteProfilesRepository } from './sqlite/profiles-repo.js';
import { SqliteAnalysisJobsRepository } from './sqlite/analysis-jobs-repo.js';
import { SqliteEvidenceRepository } from './sqlite/evidence-repo.js';
import { SqliteWaitlistRepository } from './sqlite/waitlist-repo.js';
import type { StorageConfig, StorageContext, StorageDriver } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SQLITE_MIGRATIONS_DIR = path.resolve(__dirname, '../../../db/migrations/sqlite');

/**
 * 持久化层唯一装配入口：按 driver 返回同一组仓储接口，业务代码不感知方言。
 * - sqlite（默认）：本地文件/内存库，零外部依赖。
 * - postgres：见 postgres/ 实现（W3-6 后续提交接入）。
 */
export async function createStorage(config: StorageConfig = {}): Promise<StorageContext> {
  const driver: StorageDriver =
    config.driver ?? (process.env.DB_DRIVER as StorageDriver | undefined) ?? 'sqlite';

  if (driver === 'postgres') {
    throw new Error(
      'DB_DRIVER=postgres is not wired yet; the postgres dialect lands in the W3-6 follow-up commit.',
    );
  }

  const sqlitePath = config.sqlitePath ?? process.env.DB_PATH ?? 'data/job-agent.db';
  const migrationsDir = config.migrationsDir ?? SQLITE_MIGRATIONS_DIR;
  const { client, db } = openSqlite(sqlitePath, { readonly: config.readonly });

  const context: StorageContext = {
    driver,
    profiles: new SqliteProfilesRepository(db),
    jobs: new SqliteAnalysisJobsRepository(db),
    evidence: new SqliteEvidenceRepository(db),
    waitlist: new SqliteWaitlistRepository(db),
    migrate: async () => runMigrations(client, migrationsDir),
    close: async () => {
      client.close();
    },
  };

  const autoMigrate = config.autoMigrate ?? !config.readonly;
  if (autoMigrate) await context.migrate();

  return context;
}
