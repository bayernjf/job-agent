import type {
  IAnalysisJobsRepository,
  IEvidenceRepository,
  IProfilesRepository,
  IWaitlistRepository,
} from './repositories/index.js';
import type { RunMigrationsResult } from './sqlite/migrator.js';

export type StorageDriver = 'sqlite' | 'postgres';

export interface StorageConfig {
  /** 覆盖 DB_DRIVER；未传时取环境变量 DB_DRIVER，再缺省 'sqlite' */
  driver?: StorageDriver;
  /** SQLite 文件路径；未传取 DB_PATH，再缺省 data/job-agent.db */
  sqlitePath?: string;
  /** Postgres 连接串；driver=postgres 时必填（未传取 DATABASE_URL） */
  databaseUrl?: string;
  /** 只读连接（报告页 SSR 用）；只读时默认不自动迁移 */
  readonly?: boolean;
  /** 是否在工厂内自动应用未执行迁移，默认非只读连接为 true */
  autoMigrate?: boolean;
  /** 覆盖迁移目录（测试用） */
  migrationsDir?: string;
}

export interface StorageContext {
  driver: StorageDriver;
  profiles: IProfilesRepository;
  jobs: IAnalysisJobsRepository;
  evidence: IEvidenceRepository;
  waitlist: IWaitlistRepository;
  /** 按序应用未执行迁移，返回本次新应用列表 */
  migrate(): Promise<RunMigrationsResult>;
  /** 关闭底层连接/连接池 */
  close(): Promise<void>;
}
