import { sql } from 'drizzle-orm';
import { boolean, index, integer, pgTable, text } from 'drizzle-orm/pg-core';

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
  },
  (table) => [
    index('idx_analysis_jobs_status_created').on(table.status, table.createdAt),
    index('idx_analysis_jobs_subject_created').on(
      table.subjectPlatform,
      table.subjectLogin,
      table.createdAt,
    ),
  ],
);

export type AnalysisJobInsert = typeof analysisJobs.$inferInsert;
export type AnalysisJobSelect = typeof analysisJobs.$inferSelect;

/** evidence 表——证据项单独索引（PRD 第 8 章 EvidenceItem 契约）。 */
export const evidence = pgTable(
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
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
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
