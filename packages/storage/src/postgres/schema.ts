import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  real,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Postgres Drizzle 表定义——必须与 `db/migrations/postgres/NNN_*.sql` 保持一致，
 * 且 JS 字段名（camelCase）/ 列名（snake_case）与 sqlite/schema.ts 逐一对齐，
 * 这样 entities 的 Raw*Row 行类型可被两方言共用（设计文档 D2/D4）。
 *
 * MVP 刻意对齐 SQLite 的列类型：字符串/JSON/时间戳一律 TEXT、布尔 BOOLEAN、整数 INTEGER，
 * 不引入 JSONB / TIMESTAMPTZ / UUID（缓做见设计文档 §9）。
 */

export const profiles = pgTable(
  'profiles',
  {
    id: text('id').primaryKey(),
    analyzerVersion: text('analyzer_version').notNull(),
    subjectPlatform: text('subject_platform').notNull().default('github'),
    subjectLogin: text('subject_login').notNull(),
    subjectClaimed: boolean('subject_claimed').notNull().default(false),
    dataWindowSince: text('data_window_since').notNull(),
    dataWindowUntil: text('data_window_until').notNull(),
    analysisLayers: text('analysis_layers').notNull().default('["L0","L1"]'),
    status: text('status').notNull().default('partial'),
    snapshot: text('snapshot').notNull(),
    /** S3 软挂起标记：UTC ISO8601 首个 pending 移除申请的提交时刻；NULL = 无未决申请 */
    removalRequestedAt: text('removal_requested_at'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
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

/** analysis_jobs 表——异步分析任务队列；状态机 queued -> running -> succeeded | failed。 */
export const analysisJobs = pgTable(
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
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
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

/** evidence 表——证据项单独索引（PRD 第 8 章 EvidenceItem 契约）。 */
export const evidence = pgTable(
  'evidence',
  {
    // 与 sqlite/schema.ts 同步：014 起主键为 (profile_id, id)。
    id: text('id').notNull(),
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
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    primaryKey({ columns: [table.profileId, table.id], name: 'evidence_pkey' }),
    index('idx_evidence_profile_id').on(table.profileId),
    index('idx_evidence_source').on(table.sourcePlatform, table.sourceType),
  ],
);

export type EvidenceInsert = typeof evidence.$inferInsert;
export type EvidenceSelect = typeof evidence.$inferSelect;

/** waitlist 表——落地页留资（PRD F7），email 唯一去重。 */
export const waitlist = pgTable(
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
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index('idx_waitlist_email').on(table.email),
    index('idx_waitlist_status_created').on(table.status, table.createdAt),
  ],
);

export type WaitlistInsert = typeof waitlist.$inferInsert;
export type WaitlistSelect = typeof waitlist.$inferSelect;

/** job_postings 表——P2 职位聚合；JS key/物理列名与 sqlite/schema.ts 逐一对齐。 */
export const jobPostings = pgTable(
  'job_postings',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id').notNull(),
    source: text('source').notNull(),
    sourceUrl: text('source_url').notNull(),
    title: text('title').notNull(),
    company: text('company').notNull(),
    location: text('location'),
    remote: boolean('remote').notNull().default(false),
    salaryMin: integer('salary_min'),
    salaryMax: integer('salary_max'),
    salaryCurrency: text('salary_currency'),
    tags: text('tags').notNull().default('[]'),
    description: text('description'),
    postedAt: text('posted_at').notNull(),
    fetchedAt: text('fetched_at').notNull(),
    applyUrl: text('apply_url'),
    searchRunId: text('search_run_id'),
    companyLogoUrl: text('company_logo_url'),
    companyUrl: text('company_url'),
    normalizedKey: text('normalized_key'),
    status: text('status').notNull().default('active'),
    firstSeenAt: text('first_seen_at').notNull(),
    lastSeenAt: text('last_seen_at').notNull(),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
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

/** demo_sessions 表——免注册演示会话（迁移 006），列集合与 sqlite/schema.ts 对齐。 */
export const demoSessions = pgTable(
  'demo_sessions',
  {
    id: text('id').primaryKey(),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    lastSeenAt: text('last_seen_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
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

/** demo_rate_events 表——IP 滑动窗口追加式计数（迁移 007）。 */
export const demoRateEvents = pgTable(
  'demo_rate_events',
  {
    id: text('id').primaryKey(),
    ipHash: text('ip_hash').notNull(),
    kind: text('kind').notNull(),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
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

/** applications 表——求职者画像侧投递记录（迁移 009）；列集合与 sqlite/schema.ts 对齐。 */
export const applications = pgTable(
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
    /** 022：产出本行的投递票据（submit_intents.id）；手动/报告/扩展写入为 NULL */
    submitIntentId: text('submit_intent_id'),
    /** 028 D1：结果回写 no_response|interview|offer|rejected；NULL=未回写 */
    outcomeFeedback: text('outcome_feedback'),
    outcomeFeedbackAt: text('outcome_feedback_at'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index('idx_applications_profile_status').on(table.profileId, table.status),
    index('idx_applications_profile_applied').on(table.profileId, table.appliedAt),
    index('idx_applications_outcome').on(table.outcomeFeedback),
  ],
);

export type ApplicationInsert = typeof applications.$inferInsert;
export type ApplicationSelect = typeof applications.$inferSelect;

/** accounts 表——OAuth 登录账号（迁移 010，决策 #1-A/#6-A）；列集合与 sqlite 对齐。 */
export const accounts = pgTable(
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
    recruiterDeclaredAt: text('recruiter_declared_at'),
    isAdmin: boolean('is_admin').notNull().default(false),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex('idx_accounts_provider').on(table.platform, table.providerAccountId),
    index('idx_accounts_platform_login').on(table.platform, table.login),
    index('idx_accounts_claimed_profile').on(table.claimedProfileId),
  ],
);

export type AccountInsert = typeof accounts.$inferInsert;
export type AccountSelect = typeof accounts.$inferSelect;

/** auth_sessions 表——登录用户不透明服务端会话（迁移 011）；列集合与 sqlite 对齐。 */
export const authSessions = pgTable(
  'auth_sessions',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    expiresAt: text('expires_at').notNull(),
    status: text('status').notNull().default('active'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    lastSeenAt: text('last_seen_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index('idx_auth_sessions_account').on(table.accountId),
    index('idx_auth_sessions_expires').on(table.expiresAt),
  ],
);

export type AuthSessionInsert = typeof authSessions.$inferInsert;
export type AuthSessionSelect = typeof authSessions.$inferSelect;

/**
 * interviews 表——招聘方侧面试计划（handoff item45，迁移 012）；列集合与 sqlite/schema.ts 对齐。
 */
export const interviews = pgTable(
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
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
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

/** profile_removal_requests 表——画像移除申请单（迁移 016，审计 S3）；列集合与 sqlite 对齐。 */
export const profileRemovalRequests = pgTable(
  'profile_removal_requests',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id').notNull(),
    status: text('status').notNull().default('pending'),
    reason: text('reason'),
    contact: text('contact'),
    ipHash: text('ip_hash'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    decidedAt: text('decided_at'),
  },
  (table) => [
    index('idx_prr_profile_status').on(table.profileId, table.status),
    index('idx_prr_status_created').on(table.status, table.createdAt),
  ],
);

export type ProfileRemovalRequestInsert = typeof profileRemovalRequests.$inferInsert;
export type ProfileRemovalRequestSelect = typeof profileRemovalRequests.$inferSelect;

/**
 * job_preferences 表——求职偏好集（迁移 018，求职 Agent 阶段 1，设计 §3.1）；
 * JS key / 物理列名与 sqlite/schema.ts 逐一对齐（boolean 列是唯一类型族差异）。
 */
export const jobPreferences = pgTable(
  'job_preferences',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    label: text('label').notNull(),
    targetTitles: text('target_titles').notNull(),
    skills: text('skills').notNull().default('[]'),
    locations: text('locations').notNull().default('[]'),
    remoteOnly: boolean('remote_only').notNull().default(false),
    salaryMinUsd: integer('salary_min_usd'),
    sources: text('sources').notNull().default('[]'),
    companyWhitelist: text('company_whitelist').notNull().default('[]'),
    companyBlacklist: text('company_blacklist').notNull().default('[]'),
    minTier: text('min_tier').notNull().default('mid'),
    dailySubmitLimit: integer('daily_submit_limit').notNull().default(20),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index('idx_jp_account').on(table.accountId, table.createdAt)],
);

export type JobPreferenceInsert = typeof jobPreferences.$inferInsert;
export type JobPreferenceSelect = typeof jobPreferences.$inferSelect;

/** job_runs 表——求职任务状态机实例（迁移 019，设计 §5.2）；列集合与 sqlite 对齐。 */
export const jobRuns = pgTable(
  'job_runs',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    profileId: text('profile_id').notNull(),
    preferenceId: text('preference_id').notNull(),
    status: text('status').notNull().default('created'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    lastScanAt: text('last_scan_at'),
    lastViewedAt: text('last_viewed_at'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index('idx_jr_status').on(table.status, table.lastScanAt),
    index('idx_jr_account').on(table.accountId, table.createdAt),
  ],
);

export type JobRunInsert = typeof jobRuns.$inferInsert;
export type JobRunSelect = typeof jobRuns.$inferSelect;

/** job_run_events 表——状态迁移审计日志（迁移 020，设计 §5.2）；列集合与 sqlite 对齐。 */
export const jobRunEvents = pgTable(
  'job_run_events',
  {
    id: text('id').primaryKey(),
    runId: text('run_id').notNull(),
    event: text('event').notNull(),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    actor: text('actor').notNull(),
    payload: text('payload').notNull().default('{}'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index('idx_jre_run').on(table.runId, table.createdAt)],
);

export type JobRunEventInsert = typeof jobRunEvents.$inferInsert;
export type JobRunEventSelect = typeof jobRunEvents.$inferSelect;

/** submit_intents 表——人机闸投递票据（迁移 021，设计 §4.3）；列集合与 sqlite 对齐。 */
export const submitIntents = pgTable(
  'submit_intents',
  {
    id: text('id').primaryKey(),
    runId: text('run_id').notNull(),
    accountId: text('account_id').notNull(),
    profileId: text('profile_id').notNull(),
    jobId: text('job_id').notNull(),
    jobSource: text('job_source').notNull(),
    jobSnapshot: text('job_snapshot').notNull(),
    matchScore: integer('match_score').notNull(),
    matchTier: text('match_tier').notNull(),
    matchReport: text('match_report').notNull(),
    status: text('status').notNull().default('pending'),
    rejectReason: text('reject_reason'),
    approvedAt: text('approved_at'),
    rejectedAt: text('rejected_at'),
    submittedAt: text('submitted_at'),
    applicationId: text('application_id'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index('idx_si_run').on(table.runId, table.createdAt),
    index('idx_si_account_status').on(table.accountId, table.status),
    index('idx_si_source').on(table.accountId, table.jobSource, table.status),
  ],
);

export type SubmitIntentInsert = typeof submitIntents.$inferInsert;
export type SubmitIntentSelect = typeof submitIntents.$inferSelect;

/**
 * llm_catalog_models 表——内置模型目录（迁移 024，design-llm-model-provisioning
 * §4.2）。列集与索引名必须与 SQLite 完全一致（migrations-parity test）。
 */
export const llmCatalogModels = pgTable(
  'llm_catalog_models',
  {
    id: text('id').primaryKey(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    isDefault: boolean('is_default').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    modalities: text('modalities').notNull().default('["text"]'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index('idx_catalog_default').on(table.isDefault, table.enabled)],
);

export type LlmCatalogModelInsert = typeof llmCatalogModels.$inferInsert;
export type LlmCatalogModelSelect = typeof llmCatalogModels.$inferSelect;

/**
 * user_llm_configs 表——BYOK 模型配置（迁移 025，design §4.3）。
 * api_key_encrypted 只存 AES-256-GCM 密文（决策 #21-1）；一账号一行（#21-6）。
 */
export const userLlmConfigs = pgTable(
  'user_llm_configs',
  {
    accountId: text('account_id').primaryKey(),
    provider: text('provider').notNull().default('custom'),
    baseUrl: text('base_url').notNull(),
    model: text('model').notNull(),
    apiKeyEncrypted: text('api_key_encrypted').notNull(),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
);

export type UserLlmConfigInsert = typeof userLlmConfigs.$inferInsert;
export type UserLlmConfigSelect = typeof userLlmConfigs.$inferSelect;

/**
 * extension_auth_codes 表——一次性授权码（迁移 026，design-扩展登录态 §5）。
 * Postgres 方言；列集与 SQLite 迁移一一对应（migrations-parity test）。
 */
export const extensionAuthCodes = pgTable(
  'extension_auth_codes',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    expiresAt: text('expires_at').notNull(),
    usedAt: text('used_at'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index('idx_extension_auth_codes_account').on(table.accountId),
    index('idx_extension_auth_codes_expires').on(table.expiresAt),
  ],
);

export type ExtensionAuthCodeInsert = typeof extensionAuthCodes.$inferInsert;
export type ExtensionAuthCodeSelect = typeof extensionAuthCodes.$inferSelect;

/**
 * api_tokens 表——扩展长期 Bearer 凭证（迁移 027，design-扩展登录态 §5）。
 * Postgres 方言；只存 SHA-256 hex 摘要，明文仅签发响应返回一次。
 */
export const apiTokens = pgTable(
  'api_tokens',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    name: text('name').notNull().default('browser extension'),
    expiresAt: text('expires_at').notNull(),
    lastSeenAt: text('last_seen_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    revokedAt: text('revoked_at'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index('idx_api_tokens_hash').on(table.tokenHash),
    index('idx_api_tokens_account').on(table.accountId),
    index('idx_api_tokens_expires').on(table.expiresAt),
  ],
);

export type ApiTokenInsert = typeof apiTokens.$inferInsert;
export type ApiTokenSelect = typeof apiTokens.$inferSelect;

/**
 * claim_verifications（迁移 029，决策 #23）：一条"简历声明"的核验结论。
 * 与 profiles 无外键、无级联——这一层只读画像、绝不回写，故刻意不建立引用约束。
 */
export const claimVerifications = pgTable(
  'claim_verifications',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id'),
    subjectPlatform: text('subject_platform').notNull(),
    subjectLogin: text('subject_login').notNull(),
    claimText: text('claim_text').notNull(),
    claimSource: text('claim_source').notNull().default('manual'),
    claimRef: text('claim_ref'),
    verdict: text('verdict').notNull(),
    matchedEvidenceRefs: text('matched_evidence_refs').notNull(),
    confidence: real('confidence'),
    verifierAccountId: text('verifier_account_id'),
    ruleVersion: text('rule_version').notNull(),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index('idx_cv_profile').on(table.profileId, table.createdAt),
    index('idx_cv_subject').on(table.subjectPlatform, table.subjectLogin),
  ],
);

export type ClaimVerificationInsert = typeof claimVerifications.$inferInsert;
export type ClaimVerificationSelect = typeof claimVerifications.$inferSelect;

/**
 * cron_heartbeat（迁移 031）：cron 消费通道的存活信号。
 * 与 SQLite 方言列集合一致（migrations-parity test）。
 */
export const cronHeartbeat = pgTable('cron_heartbeat', {
  consumer: text('consumer').primaryKey(),
  lastSuccessAt: text('last_success_at'),
  lastResult: text('last_result'),
  lastError: text('last_error'),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export type CronHeartbeatInsert = typeof cronHeartbeat.$inferInsert;
export type CronHeartbeatSelect = typeof cronHeartbeat.$inferSelect;

/**
 * search_presets 表——用户保存的筛选条件预设（迁移 032，设计 §3）。
 * 列集合与 sqlite 对齐；conditions 存 JSON 文本；(account_id, query) 唯一。
 */
export const searchPresets = pgTable(
  'search_presets',
  {
    presetId: text('preset_id').primaryKey(),
    accountId: text('account_id').notNull(),
    title: text('title'),
    query: text('query').notNull(),
    conditions: text('conditions').notNull(),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex('idx_search_presets_account_query').on(table.accountId, table.query),
    index('idx_search_presets_account').on(table.accountId),
  ],
);

export type SearchPresetInsert = typeof searchPresets.$inferInsert;
export type SearchPresetSelect = typeof searchPresets.$inferSelect;

/** search_runs 表——一次指令式全网搜岗任务（迁移 032，设计 §3）。 */
export const searchRuns = pgTable(
  'search_runs',
  {
    runId: text('run_id').primaryKey(),
    accountId: text('account_id').notNull(),
    presetId: text('preset_id'),
    query: text('query').notNull(),
    conditions: text('conditions').notNull(),
    status: text('status').notNull().default('queued'),
    queries: text('queries').notNull().default('[]'),
    resultsCount: integer('results_count').notNull().default(0),
    newCount: integer('new_count').notNull().default(0),
    matchedCount: integer('matched_count').notNull().default(0),
    error: text('error'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index('idx_search_runs_account').on(table.accountId),
    index('idx_search_runs_status').on(table.status, table.createdAt),
  ],
);

export type SearchRunInsert = typeof searchRuns.$inferInsert;
export type SearchRunSelect = typeof searchRuns.$inferSelect;
