import path from 'node:path';
import fs from 'node:fs';
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
import { SqliteClaimVerificationsRepository } from './sqlite/claim-verifications-repo.js';
import { SqliteAccountsRepository } from './sqlite/accounts-repo.js';
import { SqliteAuthSessionsRepository } from './sqlite/auth-sessions-repo.js';
import { SqliteProfileRemovalRequestsRepository } from './sqlite/profile-removal-requests-repo.js';
import { SqliteJobPreferencesRepository } from './sqlite/job-preferences-repo.js';
import { SqliteJobRunsRepository } from './sqlite/job-runs-repo.js';
import { SqliteJobRunEventsRepository } from './sqlite/job-run-events-repo.js';
import { SqliteSubmitIntentsRepository } from './sqlite/submit-intents-repo.js';
import { SqliteLlmCatalogRepository } from './sqlite/llm-catalog-repo.js';
import { SqliteExtensionAuthCodesRepository } from './sqlite/extension-auth-codes-repo.js';
import { SqliteApiTokensRepository } from './sqlite/api-tokens-repo.js';
import { SqliteCronHeartbeatRepository } from './sqlite/cron-heartbeat-repo.js';
import { SqliteUserLlmConfigsRepository } from './sqlite/user-llm-configs-repo.js';
import { sqliteVerifyRequiredColumns } from './sqlite/verify-required-columns.js';
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
import { PgClaimVerificationsRepository } from './postgres/claim-verifications-repo.js';
import { PgAccountsRepository } from './postgres/accounts-repo.js';
import { PgAuthSessionsRepository } from './postgres/auth-sessions-repo.js';
import { PgProfileRemovalRequestsRepository } from './postgres/profile-removal-requests-repo.js';
import { PgJobPreferencesRepository } from './postgres/job-preferences-repo.js';
import { PgJobRunsRepository } from './postgres/job-runs-repo.js';
import { PgJobRunEventsRepository } from './postgres/job-run-events-repo.js';
import { PgSubmitIntentsRepository } from './postgres/submit-intents-repo.js';
import { PgLlmCatalogRepository } from './postgres/llm-catalog-repo.js';
import { PgExtensionAuthCodesRepository } from './postgres/extension-auth-codes-repo.js';
import { PgApiTokensRepository } from './postgres/api-tokens-repo.js';
import { PgCronHeartbeatRepository } from './postgres/cron-heartbeat-repo.js';
import { PgUserLlmConfigsRepository } from './postgres/user-llm-configs-repo.js';
import { pgVerifyRequiredColumns } from './postgres/verify-required-columns.js';
import type { StorageConfig, StorageContext, StorageDriver } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SQLITE_MIGRATIONS_DIR = path.resolve(__dirname, '../../../db/migrations/sqlite');
const POSTGRES_MIGRATIONS_DIR = path.resolve(__dirname, '../../../db/migrations/postgres');

/**
 * 解析一个真实存在且含 .sql 的迁移目录。
 *
 * 默认路径按 monorepo 编译产物布局（packages/storage/dist → 仓库根/db/migrations）
 * 推算；但 standalone 单文件打包（形态 A/B，bundle 位置变化、db/ 不在相对路径上）
 * 会让该相对路径失效并在 readdir 时抛晦涩的 ENOENT。这里在首选路径未命中时，
 * 依次探测常见的打包深度、进程工作目录与 bundle 旁目录；显式 config.migrationsDir
 * 始终第一优先。全部未命中才抛出带尝试清单的明确错误。
 *
 * 仅在真正执行 migrate 时调用（延迟），因此只读 / DB_AUTO_MIGRATE=false 的场景
 * 即使缺少迁移目录也不会失败。
 */
export function resolveExistingMigrationsDir(preferredDir: string, dialect: 'sqlite' | 'postgres'): string {
  const rel = path.join('db', 'migrations', dialect);
  const candidates = [
    preferredDir,
    path.resolve(__dirname, '../../../', rel),
    path.resolve(__dirname, '../../', rel),
    path.resolve(__dirname, '../', rel),
    path.resolve(process.cwd(), rel),
    path.resolve(__dirname, rel),
  ];
  const seen = new Set<string>();
  for (const dir of candidates) {
    const normalized = path.normalize(dir);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    try {
      if (fs.existsSync(normalized) && fs.readdirSync(normalized).some((f) => f.endsWith('.sql'))) {
        return normalized;
      }
    } catch {
      // 无权限/非目录等：继续尝试下一个候选。
    }
  }
  throw new Error(
    `[storage] migrations directory not found for ${dialect}. Tried:\n  - ${[...seen].join('\n  - ')}\n` +
      'Pass config.migrationsDir explicitly, run from the repository root, or place db/migrations next to the bundled output.',
  );
}

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
      claimVerifications: new PgClaimVerificationsRepository(db),
      accounts: new PgAccountsRepository(db),
      authSessions: new PgAuthSessionsRepository(db),
      profileRemovalRequests: new PgProfileRemovalRequestsRepository(db),
      jobPreferences: new PgJobPreferencesRepository(db),
      jobRuns: new PgJobRunsRepository(db),
      jobRunEvents: new PgJobRunEventsRepository(db),
      submitIntents: new PgSubmitIntentsRepository(db),
      llmCatalog: new PgLlmCatalogRepository(db),
      userLlmConfigs: new PgUserLlmConfigsRepository(db),
      extensionAuthCodes: new PgExtensionAuthCodesRepository(db),
      apiTokens: new PgApiTokensRepository(db),
      cronHeartbeat: new PgCronHeartbeatRepository(db),
      migrate: async () => runPgMigrations(client, resolveExistingMigrationsDir(migrationsDir, 'postgres')),
      ping: async () => {
        await client.unsafe('SELECT 1');
      },
      verifyRequiredColumns: async (requirements) => {
        return pgVerifyRequiredColumns(client, requirements);
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
    claimVerifications: new SqliteClaimVerificationsRepository(db),
    accounts: new SqliteAccountsRepository(db),
    authSessions: new SqliteAuthSessionsRepository(db),
    profileRemovalRequests: new SqliteProfileRemovalRequestsRepository(db),
    jobPreferences: new SqliteJobPreferencesRepository(db),
    jobRuns: new SqliteJobRunsRepository(db),
    jobRunEvents: new SqliteJobRunEventsRepository(db),
    submitIntents: new SqliteSubmitIntentsRepository(db),
    llmCatalog: new SqliteLlmCatalogRepository(db),
    userLlmConfigs: new SqliteUserLlmConfigsRepository(db),
    extensionAuthCodes: new SqliteExtensionAuthCodesRepository(db),
    apiTokens: new SqliteApiTokensRepository(db),
    cronHeartbeat: new SqliteCronHeartbeatRepository(db),
    migrate: async () => runMigrations(client, resolveExistingMigrationsDir(migrationsDir, 'sqlite')),
    ping: async () => {
      client.prepare('SELECT 1 AS ok').get();
    },
    verifyRequiredColumns: async (requirements) => {
      return sqliteVerifyRequiredColumns(client, requirements);
    },
    close: async () => {
      client.close();
    },
  };

  if (autoMigrate) await context.migrate();

  return context;
}
