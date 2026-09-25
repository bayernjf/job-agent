import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * Drizzle 表定义——必须与 `db/migrations/sqlite/001_create_profiles.sql` 保持一致
 * （MIGRATION_CONVENTION 第 6 节：持久化模块内的表定义与编号迁移一一对应）。
 *
 * MVP 方言为 SQLite（本地/实验）；Postgres 适配见 docs/deferred-items.md。
 * 数据库字段 snake_case，TS 字段 camelCase，转换只发生在本数据访问层。
 */

export const profiles = sqliteTable(
  'profiles',
  {
    id: text('id').primaryKey(),
    analyzerVersion: text('analyzer_version').notNull(),
    subjectPlatform: text('subject_platform').notNull().default('github'),
    subjectLogin: text('subject_login').notNull(),
    subjectClaimed: integer('subject_claimed', { mode: 'boolean' }).notNull().default(false),
    dataWindowSince: text('data_window_since').notNull(),
    dataWindowUntil: text('data_window_until').notNull(),
    analysisLayers: text('analysis_layers').notNull().default('["L0","L1"]'),
    status: text('status').notNull().default('partial'),
    snapshot: text('snapshot').notNull(),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(CURRENT_TIMESTAMP)`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(CURRENT_TIMESTAMP)`),
  },
  (table) => [
    index('idx_profiles_subject_created').on(
      table.subjectPlatform,
      table.subjectLogin,
      table.createdAt,
    ),
  ],
);

export type ProfileInsert = typeof profiles.$inferInsert;
export type ProfileSelect = typeof profiles.$inferSelect;

/**
 * analysis_jobs 表——异步分析任务队列（技术选型 6.6）。
 * MVP 用单 Worker 轮询/认领，不引入 Redis。
 * 状态机：queued -> running -> succeeded | failed。
 * 必须与 db/migrations/sqlite/002_create_analysis_jobs.sql 保持一致。
 */
export const analysisJobs = sqliteTable(
  'analysis_jobs',
  {
    id: text('id').primaryKey(),
    subjectPlatform: text('subject_platform').notNull().default('github'),
    subjectLogin: text('subject_login').notNull(),
    status: text('status').notNull().default('queued'),
    stage: text('stage'),
    attempts: integer('attempts').notNull().default(0),
    profileId: text('profile_id'),
    errorMessage: text('error_message'),
    budgetUsed: text('budget_used'),
    missing: text('missing'),
    claimedBy: text('claimed_by'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(CURRENT_TIMESTAMP)`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(CURRENT_TIMESTAMP)`),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
    requesterKind: text('requester_kind').notNull().default('public'),
    demoSessionId: text('demo_session_id'),
  },
  (table) => [
    index('idx_analysis_jobs_status_created').on(table.status, table.createdAt),
    index('idx_analysis_jobs_subject_created').on(
      table.subjectPlatform,
      table.subjectLogin,
      table.createdAt,
    ),
    index('idx_analysis_jobs_requester_status').on(table.requesterKind, table.status),
    index('idx_analysis_jobs_demo_session').on(table.demoSessionId),
  ],
);

export type AnalysisJobInsert = typeof analysisJobs.$inferInsert;
export type AnalysisJobSelect = typeof analysisJobs.$inferSelect;


/**
 * evidence 表——单独证据项索引（PRD 第 8 章 EvidenceItem 契约）。
 * 证据项同时存储在 profiles.snapshot JSON 中；本表提供单独索引用于
 * 按证据查询、跨画像关联、审计追溯。
 * 必须与 db/migrations/sqlite/003_create_evidence.sql 保持一致。
 */
export const evidence = sqliteTable(
  'evidence',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id').notNull(),
    sourcePlatform: text('source_platform').notNull().default('github'),
    sourceType: text('source_type').notNull(),
    url: text('url').notNull(),
    occurredAt: text('occurred_at'),
    layer: text('layer').notNull(),
    claim: text('claim').notNull(),
    rawRef: text('raw_ref').notNull(),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(CURRENT_TIMESTAMP)`),
  },
  (table) => [
    index('idx_evidence_profile_id').on(table.profileId),
    index('idx_evidence_source').on(table.sourcePlatform, table.sourceType),
  ],
);

export type EvidenceInsert = typeof evidence.$inferInsert;
export type EvidenceSelect = typeof evidence.$inferSelect;


/**
 * waitlist 表——落地页留资（PRD F7）。
 * 存储早期用户注册信息，email 唯一去重。
 * 必须与 db/migrations/sqlite/004_create_waitlist.sql 保持一致。
 */
export const waitlist = sqliteTable(
  'waitlist',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull().unique(),
    name: text('name'),
    githubUsername: text('github_username'),
    source: text('source').notNull().default('landing_page'),
    status: text('status').notNull().default('pending'),
    notes: text('notes'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(CURRENT_TIMESTAMP)`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(CURRENT_TIMESTAMP)`),
  },
  (table) => [
    index('idx_waitlist_email').on(table.email),
    index('idx_waitlist_status_created').on(table.status, table.createdAt),
  ],
);

export type WaitlistInsert = typeof waitlist.$inferInsert;
export type WaitlistSelect = typeof waitlist.$inferSelect;


/**
 * job_postings 表——P2 职位聚合（决策 #16 / design-job-ingestion-20260913）。
 * 同源去重唯一键 (source, source_url)；tags 以 JSON 文本存储；
 * 薪资统一年化美元整数；first/last_seen 支撑岗位下线判定。
 * 必须与 db/migrations/sqlite/005_create_job_postings.sql 保持一致。
 */
export const jobPostings = sqliteTable(
  'job_postings',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id').notNull(),
    source: text('source').notNull(),
    sourceUrl: text('source_url').notNull(),
    title: text('title').notNull(),
    company: text('company').notNull(),
    location: text('location'),
    remote: integer('remote', { mode: 'boolean' }).notNull().default(false),
    salaryMin: integer('salary_min'),
    salaryMax: integer('salary_max'),
    salaryCurrency: text('salary_currency'),
    tags: text('tags').notNull().default('[]'),
    description: text('description'),
    postedAt: text('posted_at').notNull(),
    fetchedAt: text('fetched_at').notNull(),
    applyUrl: text('apply_url'),
    companyLogoUrl: text('company_logo_url'),
    companyUrl: text('company_url'),
    normalizedKey: text('normalized_key'),
    status: text('status').notNull().default('active'),
    firstSeenAt: text('first_seen_at').notNull(),
    lastSeenAt: text('last_seen_at').notNull(),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(CURRENT_TIMESTAMP)`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(CURRENT_TIMESTAMP)`),
  },
  (table) => [
    index('idx_job_postings_status_posted').on(table.status, table.postedAt),
    index('idx_job_postings_source').on(table.source),
    index('idx_job_postings_company').on(table.company),
    index('idx_job_postings_normalized').on(table.normalizedKey),
  ],
);

export type JobPostingInsert = typeof jobPostings.$inferInsert;
export type JobPostingSelect = typeof jobPostings.$inferSelect;


/**
 * demo_sessions 表——免注册演示会话（design-demo-mode-20260915，迁移 006）。
 * id 即 Cookie 值；不存明文 IP，只存加盐 SHA-256；TTL 到期视为匿名并由 cleanup 清理。
 */
export const demoSessions = sqliteTable(
  'demo_sessions',
  {
    id: text('id').primaryKey(),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(CURRENT_TIMESTAMP)`),
    lastSeenAt: text('last_seen_at')
      .notNull()
      .default(sql`(CURRENT_TIMESTAMP)`),
    expiresAt: text('expires_at').notNull(),
    analyzeCount: integer('analyze_count').notNull().default(0),
    matchCount: integer('match_count').notNull().default(0),
    analyzedLogins: text('analyzed_logins').notNull().default('[]'),
    ipHash: text('ip_hash'),
    status: text('status').notNull().default('active'),
  },
  (table) => [
    index('idx_demo_sessions_expires').on(table.expiresAt),
    index('idx_demo_sessions_ip_created').on(table.ipHash, table.createdAt),
  ],
);

export type DemoSessionInsert = typeof demoSessions.$inferInsert;
export type DemoSessionSelect = typeof demoSessions.$inferSelect;

/**
 * demo_rate_events 表——IP 滑动窗口限流的追加式计数（迁移 007，MVP 不引 Redis）。
 * cleanup 删除 24h 前的行。
 */
export const demoRateEvents = sqliteTable(
  'demo_rate_events',
  {
    id: text('id').primaryKey(),
    ipHash: text('ip_hash').notNull(),
    kind: text('kind').notNull(),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(CURRENT_TIMESTAMP)`),
  },
  (table) => [
    index('idx_demo_rate_events_ip_kind_created').on(
      table.ipHash,
      table.kind,
      table.createdAt,
    ),
  ],
);

export type DemoRateEventInsert = typeof demoRateEvents.$inferInsert;
export type DemoRateEventSelect = typeof demoRateEvents.$inferSelect;

/**
 * applications 表——求职者画像侧投递记录（痛点解决方案批次 2，迁移 009）。
 * 当前无账号体系，以 profile_id 关联画像；target_* 冗余存储，岗位下架后记录仍可读。
 */
export const applications = sqliteTable(
  'applications',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id').notNull(),
    jobId: text('job_id'),
    source: text('source'),
    targetTitle: text('target_title').notNull(),
    targetCompany: text('target_company').notNull(),
    targetUrl: text('target_url'),
    status: text('status').notNull().default('applied'),
    note: text('note'),
    origin: text('origin').notNull().default('manual'),
    appliedAt: text('applied_at').notNull(),
    createdByAccountId: text('created_by_account_id'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(CURRENT_TIMESTAMP)`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(CURRENT_TIMESTAMP)`),
  },
  (table) => [
    index('idx_applications_profile_status').on(table.profileId, table.status),
    index('idx_applications_profile_applied').on(table.profileId, table.appliedAt),
  ],
);

export type ApplicationInsert = typeof applications.$inferInsert;
export type ApplicationSelect = typeof applications.$inferSelect;

/**
 * accounts 表——OAuth 登录账号（迁移 010，决策 #1-A/#6-A）。
 * 一个平台身份 (platform, provider_account_id) 唯一；claimed_profile_id 记录本人认领画像。
 */
export const accounts = sqliteTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    platform: text('platform').notNull().default('github'),
    providerAccountId: text('provider_account_id').notNull(),
    login: text('login').notNull(),
    name: text('name'),
    email: text('email'),
    avatarUrl: text('avatar_url'),
    claimedProfileId: text('claimed_profile_id'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(CURRENT_TIMESTAMP)`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(CURRENT_TIMESTAMP)`),
  },
  (table) => [
    uniqueIndex('idx_accounts_provider').on(table.platform, table.providerAccountId),
    index('idx_accounts_platform_login').on(table.platform, table.login),
    index('idx_accounts_claimed_profile').on(table.claimedProfileId),
  ],
);

export type AccountInsert = typeof accounts.$inferInsert;
export type AccountSelect = typeof accounts.$inferSelect;

/**
 * auth_sessions 表——登录用户的不透明服务端会话（迁移 011）。
 * id 即 HttpOnly Cookie 值（ses-<32 随机字节>）；归属 accounts，支持登出/撤销/过期。
 */
export const authSessions = sqliteTable(
  'auth_sessions',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    expiresAt: text('expires_at').notNull(),
    status: text('status').notNull().default('active'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(CURRENT_TIMESTAMP)`),
    lastSeenAt: text('last_seen_at')
      .notNull()
      .default(sql`(CURRENT_TIMESTAMP)`),
  },
  (table) => [
    index('idx_auth_sessions_account').on(table.accountId),
    index('idx_auth_sessions_expires').on(table.expiresAt),
  ],
);

export type AuthSessionInsert = typeof authSessions.$inferInsert;
export type AuthSessionSelect = typeof authSessions.$inferSelect;

/**
 * interviews 表——招聘方侧面试计划（handoff item45，迁移 012）。
 * 行级归属 created_by_account_id（个人效率工具，不引入 recruiter 角色/组织）；
 * application_id 可空（可直接从候选人画像创建）；target_* 冗余，无投递记录也可读。
 */
export const interviews = sqliteTable(
  'interviews',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id').notNull(),
    applicationId: text('application_id'),
    targetTitle: text('target_title').notNull(),
    targetCompany: text('target_company'),
    scheduledStart: text('scheduled_start').notNull(),
    scheduledEnd: text('scheduled_end').notNull(),
    format: text('format').notNull(),
    roundLabel: text('round_label').notNull(),
    interviewerName: text('interviewer_name'),
    interviewerEmail: text('interviewer_email'),
    status: text('status').notNull().default('scheduled'),
    outcome: text('outcome'),
    feedbackNote: text('feedback_note'),
    rating: integer('rating'),
    createdByAccountId: text('created_by_account_id').notNull(),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(CURRENT_TIMESTAMP)`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(CURRENT_TIMESTAMP)`),
  },
  (table) => [
    index('idx_interviews_owner_status').on(
      table.createdByAccountId,
      table.status,
      table.scheduledStart,
    ),
    index('idx_interviews_profile_start').on(table.profileId, table.scheduledStart),
    index('idx_interviews_application').on(table.applicationId),
  ],
);

export type InterviewInsert = typeof interviews.$inferInsert;
export type InterviewSelect = typeof interviews.$inferSelect;
