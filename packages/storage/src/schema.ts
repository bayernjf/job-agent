import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Drizzle 表定义——必须与 `db/migrations/001_create_profiles.sql` 保持一致
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
 * 必须与 db/migrations/002_create_analysis_jobs.sql 保持一致。
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
