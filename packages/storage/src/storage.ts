import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSqlite } from './sqlite/connection.js';
import { runMigrations } from './sqlite/migrator.js';
import { SqliteProfilesRepository } from './sqlite/profiles-repo.js';
import { SqliteAnalysisJobsRepository } from './sqlite/analysis-jobs-repo.js';
import { SqliteEvidenceRepository } from './sqlite/evidence-repo.js';
import { SqliteWaitlistRepository } from './sqlite/waitlist-repo.js';
import { SqliteJobPostingsRepository } from './sqlite/job-postings-repo.js';
import { SqliteDemoSessionsRepository } from './sqlite/demo-sessions-repo.js';
import { SqliteApplicationsRepository } from './sqlite/applications-repo.js';
import { SqliteInterviewsRepository } from './sqlite/interviews-repo.js';
import { SqliteAccountsRepository } from './sqlite/accounts-repo.js';
import { SqliteAuthSessionsRepository } from './sqlite/auth-sessions-repo.js';
import { openPostgres } from './postgres/connection.js';
import { runPgMigrations } from './postgres/migrator.js';
import { PgProfilesRepository } from './postgres/profiles-repo.js';
import { PgAnalysisJobsRepository } from './postgres/analysis-jobs-repo.js';
import { PgEvidenceRepository } from './postgres/evidence-repo.js';
import { PgWaitlistRepository } from './postgres/waitlist-repo.js';
import { PgJobPostingsRepository } from './postgres/job-postings-repo.js';
import { PgDemoSessionsRepository } from './postgres/demo-sessions-repo.js';
import { PgApplicationsRepository } from './postgres/applications-repo.js';
import { PgInterviewsRepository } from './postgres/interviews-repo.js';
import { PgAccountsRepository } from './postgres/accounts-repo.js';
import { PgAuthSessionsRepository } from './postgres/auth-sessions-repo.js';
import type { StorageConfig, StorageContext, StorageDriver } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SQLITE_MIGRATIONS_DIR = path.resolve(__dirname, '../../../db/migrations/sqlite');
const POSTGRES_MIGRATIONS_DIR = path.resolve(__dirname, '../../../db/migrations/postgres');

/**
 * 持久化层唯一装配入口：按 driver 返回同一组仓储接口，业务代码不感知方言。
 * - sqlite（默认）：本地文件/内存库，零外部依赖。
 * - postgres：生产；必须提供 DATABASE_URL（或 config.databaseUrl）。
 */
/**
 * 解析 DB_AUTO_MIGRATE：未设置返回 undefined（沿用 autoMigrate 默认逻辑）；
 * 仅接受 'true'/'false'（小写、去空白），其他值 warn 并回退默认。
 * serverless 形态（Vercel + Supabase 事务池化）应显式设 'false'，DDL 只走 5432 迁移流程。
 */
export function envAutoMigrate(): boolean | undefined {
  const raw = process.env.DB_AUTO_MIGRATE?.trim().toLowerCase();
  if (raw === undefined || raw === '') return undefined;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  console.warn(`[storage] invalid DB_AUTO_MIGRATE=${JSON.stringify(raw)}, fallback to default`);
  return undefined;
}

export async function createStorage(config: StorageConfig = {}): Promise<StorageContext> {
  const driver: StorageDriver =
    config.driver ?? (process.env.DB_DRIVER as StorageDriver | undefined) ?? 'sqlite';

  const autoMigrate = config.autoMigrate ?? envAutoMigrate() ?? !config.readonly;

  if (driver === 'postgres') {
    const databaseUrl = config.databaseUrl ?? process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error('DB_DRIVER=postgres requires DATABASE_URL (or config.databaseUrl).');
    }
    const migrationsDir = config.migrationsDir ?? POSTGRES_MIGRATIONS_DIR;
    const { client, db } = openPostgres(databaseUrl);
    const context: StorageContext = {
      driver,
      profiles: new PgProfilesRepository(db),
      jobs: new PgAnalysisJobsRepository(db),
      evidence: new PgEvidenceRepository(db),
      waitlist: new PgWaitlistRepository(db),
      jobPostings: new PgJobPostingsRepository(db),
      demoSessions: new PgDemoSessionsRepository(db),
      applications: new PgApplicationsRepository(db),
      interviews: new PgInterviewsRepository(db),
      accounts: new PgAccountsRepository(db),
      authSessions: new PgAuthSessionsRepository(db),
      migrate: async () => runPgMigrations(client, migrationsDir),
      ping: async () => {
        await client.unsafe('SELECT 1');
      },
      close: async () => {
        await client.end({ timeout: 5 });
      },
    };
    if (autoMigrate) await context.migrate();
    return context;
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
    jobPostings: new SqliteJobPostingsRepository(db),
    demoSessions: new SqliteDemoSessionsRepository(db),
    applications: new SqliteApplicationsRepository(db),
    interviews: new SqliteInterviewsRepository(db),
    accounts: new SqliteAccountsRepository(db),
    authSessions: new SqliteAuthSessionsRepository(db),
    migrate: async () => runMigrations(client, migrationsDir),
    ping: async () => {
      client.prepare('SELECT 1 AS ok').get();
    },
    close: async () => {
      client.close();
    },
  };

  if (autoMigrate) await context.migrate();

  return context;
}
