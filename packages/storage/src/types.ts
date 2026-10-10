import type {
  IAccountsRepository,
  IAnalysisJobsRepository,
  IApplicationsRepository,
  IAuthSessionsRepository,
  IDemoSessionsRepository,
  IEvidenceRepository,
  IInterviewsRepository,
  IClaimVerificationsRepository,
  IJobPostingsRepository,
  IJobPreferencesRepository,
  IJobRunEventsRepository,
  IJobRunsRepository,
  ILlmCatalogRepository,
  IProfilesRepository,
  IProfileRemovalRequestsRepository,
  ISubmitIntentsRepository,
  IUserLlmConfigsRepository,
  IWaitlistRepository,
  IExtensionAuthCodesRepository,
  IApiTokensRepository,
  ICronHeartbeatRepository,
  ISearchPresetsRepository,
  ISearchRunsRepository,
  INotificationSubscriptionsRepository,
} from './repositories/index.js';
import type { RunMigrationsResult } from './migrations-fs.js';

/**
 * 迁移漂移守卫的列要求：代码实际引用的关键列（表 + 列名）。
 * 完整清单以 apps/api/src/routes/system.ts 的 REQUIRED_COLUMNS 为权威。
 */
export interface ColumnRequirement {
  table: string;
  column: string;
}

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
  /** 简历声明逐条核验结论（决策 #23，迁移 029；只读画像、绝不回写） */
  claimVerifications: IClaimVerificationsRepository;
  /** OAuth 登录账号（决策 #1-A/#6-A，迁移 010） */
  accounts: IAccountsRepository;
  /** 登录用户不透明会话（迁移 011） */
  authSessions: IAuthSessionsRepository;
  /** 画像移除申请单（审计 S3，迁移 016；按主体撤回的人工复核通道） */
  profileRemovalRequests: IProfileRemovalRequestsRepository;
  /** 求职偏好集（求职 Agent 阶段 1，迁移 018） */
  jobPreferences: IJobPreferencesRepository;
  /** 求职任务状态机实例（求职 Agent 阶段 1，迁移 019） */
  jobRuns: IJobRunsRepository;
  /** 求职任务状态迁移审计流（求职 Agent 阶段 1，迁移 020） */
  jobRunEvents: IJobRunEventsRepository;
  /** 人机闸投递票据（求职 Agent 阶段 1，迁移 021） */
  submitIntents: ISubmitIntentsRepository;
  /** 内置模型目录（LLM 供给 P0，迁移 024；admin 面维护，凭证 env only） */
  llmCatalog: ILlmCatalogRepository;
  /** BYOK 模型配置（LLM 供给 P0，迁移 025；一账号一行，apiKey 加密列） */
  userLlmConfigs: IUserLlmConfigsRepository;
  /** 一次性授权码（扩展登录态，迁移 026；工作台签发、扩展单次消费） */
  extensionAuthCodes: IExtensionAuthCodesRepository;
  /** 扩展长期 Bearer 凭证（扩展登录态，迁移 027；只存 SHA-256 哈希） */
  apiTokens: IApiTokensRepository;
  /** cron 消费通道存活信号（迁移 031；API cron 端点写、/health?deep=1 读） */
  cronHeartbeat: ICronHeartbeatRepository;
  /** 用户保存的筛选条件预设（指令式搜岗，迁移 032） */
  searchPresets: ISearchPresetsRepository;
  /** 指令式全网搜岗任务（指令式搜岗，迁移 032） */
  searchRuns: ISearchRunsRepository;
  /** 触达通道订阅（决策 #25，迁移 034；行的存在性即 opt-in） */
  notificationSubscriptions: INotificationSubscriptionsRepository;
  /** 按序应用未执行迁移，返回本次新应用列表 */
  migrate(): Promise<RunMigrationsResult>;
  /**
   * 深健康检查：对底层数据库执行一次轻量往返（SELECT 1）。
   * 连接可用时 resolve；不可达/查询失败时 reject（错误信息供 /health?deep=1 返回 503）。
   * 方言差异只允许出现在持久化层内部，业务模块只调用本方法、不写裸 SQL。
   */
  ping(): Promise<void>;
  /**
   * 迁移漂移守卫（deferred「迁移漂移守卫」，2026-10-07 实施）：
   * 直接查实际 schema（SQLite PRAGMA table_info / Postgres information_schema.columns）
   * 核对代码所需的关键列是否存在，返回缺失的 "table.column" 列表（空数组 = 全齐）。
   * 刻意**不**读 schema_migrations 账本：手工重放的迁移没有账本记录，读账本会误报；
   * 且 023 的 ADD COLUMN 无 IF NOT EXISTS，不能按账本重放判断。
   */
  verifyRequiredColumns(requirements: ColumnRequirement[]): Promise<string[]>;
  /** 关闭底层连接/连接池 */
  close(): Promise<void>;
}
