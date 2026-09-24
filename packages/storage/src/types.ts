import type {
  IAccountsRepository,
  IAnalysisJobsRepository,
  IApplicationsRepository,
  IAuthSessionsRepository,
  IDemoSessionsRepository,
  IEvidenceRepository,
  IInterviewsRepository,
  IJobPostingsRepository,
  IProfilesRepository,
  IWaitlistRepository,
} from './repositories/index.js';
import type { RunMigrationsResult } from './migrations-fs.js';

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
  jobPostings: IJobPostingsRepository;
  demoSessions: IDemoSessionsRepository;
  applications: IApplicationsRepository;
  /** 招聘方面试计划（handoff item45，迁移 012，行级归属创建账号） */
  interviews: IInterviewsRepository;
  /** OAuth 登录账号（决策 #1-A/#6-A，迁移 010） */
  accounts: IAccountsRepository;
  /** 登录用户不透明会话（迁移 011） */
  authSessions: IAuthSessionsRepository;
  /** 按序应用未执行迁移，返回本次新应用列表 */
  migrate(): Promise<RunMigrationsResult>;
  /**
   * 深健康检查：对底层数据库执行一次轻量往返（SELECT 1）。
   * 连接可用时 resolve；不可达/查询失败时 reject（错误信息供 /health?deep=1 返回 503）。
   * 方言差异只允许出现在持久化层内部，业务模块只调用本方法、不写裸 SQL。
   */
  ping(): Promise<void>;
  /** 关闭底层连接/连接池 */
  close(): Promise<void>;
}
