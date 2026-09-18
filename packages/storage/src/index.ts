/**
 * @jobagent/storage 公共入口。
 *
 * 业务模块（apps/api、apps/worker、apps/report）只允许从这里导入：
 * - createStorage 工厂与 StorageContext/仓储接口（不感知 SQLite/Postgres 方言）；
 * - 实体领域类型与状态枚举；
 * - 迁移函数（CLI/脚本/测试使用）。
 *
 * 方言实现（sqlite/、postgres/）与 Drizzle 表对象不对外导出，避免业务绕过抽象层。
 */

// 装配工厂与配置类型
export { createStorage } from './storage.js';
export type { StorageConfig, StorageContext, StorageDriver } from './types.js';

// 仓储接口（业务侧依赖类型，不依赖具体实现）
export type { IProfilesRepository } from './repositories/profiles.js';
export type { IAnalysisJobsRepository } from './repositories/analysis-jobs.js';
export type { IEvidenceRepository } from './repositories/evidence.js';
export type { IWaitlistRepository } from './repositories/waitlist.js';
export type {
  IJobPostingsRepository,
  JobPostingQuery,
  UpsertCounts,
} from './repositories/job-posting.js';
export type { IDemoSessionsRepository } from './repositories/demo-sessions.js';
export type { IApplicationsRepository } from './repositories/applications.js';
export type { IAccountsRepository } from './repositories/accounts.js';
export type { IAuthSessionsRepository } from './repositories/auth-sessions.js';

// 实体领域类型
export type {
  ProfileStatus,
  StoredProfile,
  NewProfile,
} from './entities/profile.js';
export type {
  JobStatus,
  JobStage,
  StoredAnalysisJob,
  NewAnalysisJob,
} from './entities/analysis-job.js';
export type { StoredEvidence, NewEvidence } from './entities/evidence.js';
export type {
  WaitlistStatus,
  WaitlistSource,
  StoredWaitlist,
  NewWaitlist,
} from './entities/waitlist.js';
export type {
  JobPostingStatus,
  NewJobPosting,
  StoredJobPosting,
} from './entities/job-posting.js';
export type {
  DemoSessionStatus,
  DemoRateKind,
  AnalyzedLogin,
  NewDemoSession,
  StoredDemoSession,
  DemoSlotDenyReason,
  DemoSlotResult,
} from './entities/demo-session.js';
export type {
  ApplicationStatus,
  ApplicationOrigin,
  StoredApplication,
  NewApplication,
  ApplicationPatch,
} from './entities/application.js';
export type {
  StoredAccount,
  ProviderIdentity,
  NewAccount,
} from './entities/account.js';
export type {
  AuthSessionStatus,
  StoredAuthSession,
  NewAuthSession,
} from './entities/auth-session.js';
export type {
  CandidateSkill,
  CandidateSummary,
  CandidateSortBy,
  CandidateSearchQuery,
  CandidateSearchResult,
} from './entities/candidate.js';

// 状态枚举与纯映射（测试/工具可用）
export {
  PROFILE_STATUSES,
  JOB_STATUSES,
  JOB_STAGES,
  WAITLIST_STATUSES,
  toStoredProfile,
  toStoredJob,
  toStoredEvidence,
  toEvidenceItem,
  toEvidenceItems,
  toStoredWaitlist,
  JOB_POSTING_STATUSES,
  makeJobPostingId,
  jobPostingSignature,
  toStoredJobPosting,
  DEMO_SESSION_STATUSES,
  DEMO_RATE_KINDS,
  toStoredDemoSession,
  parseJson,
  APPLICATION_STATUSES,
  APPLICATION_ORIGINS,
  toStoredApplication,
  toCandidateSummary,
  searchCandidates,
} from './entities/index.js';

// 迁移（CLI/脚本/测试）
export {
  parseMigrationFile,
  createSchemaMigrationsTable,
  listMigrationFiles,
  runMigrations,
  rollbackLatestMigration,
} from './sqlite/migrator.js';
export type {
  ParsedMigration,
  RunMigrationsResult,
  RollbackResult,
} from './sqlite/migrator.js';
