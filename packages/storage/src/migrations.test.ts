import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  listMigrationFiles,
  rollbackLatestMigration,
  runMigrations,
} from './sqlite/migrator.js';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../db/migrations/sqlite',
);

function freshDb(): Database.Database {
  return new Database(':memory:');
}

describe('migrations', () => {
  it('loads all migrations on a clean db in order without errors', () => {
    const db = freshDb();
    const result = runMigrations(db, MIGRATIONS_DIR);
    expect(result.applied.length).toBeGreaterThan(0);
    expect(result.applied).toEqual(result.applied.toSorted());
    db.close();
  });

  it('keeps strictly consecutive numbering starting at 001', () => {
    const files = listMigrationFiles(MIGRATIONS_DIR);
    expect(files.length).toBeGreaterThan(0);
    files.forEach((file, i) => {
      expect(Number(file.slice(0, 3))).toBe(i + 1);
    });
  });

  it('creates the core tables with expected columns', () => {
    const db = freshDb();
    runMigrations(db, MIGRATIONS_DIR);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain('profiles');
    expect(tables.map((t) => t.name)).toContain('analysis_jobs');
    expect(tables.map((t) => t.name)).toContain('evidence');
    expect(tables.map((t) => t.name)).toContain('waitlist');
    expect(tables.map((t) => t.name)).toContain('job_postings');
    expect(tables.map((t) => t.name)).toContain('demo_sessions');
    expect(tables.map((t) => t.name)).toContain('demo_rate_events');
    expect(tables.map((t) => t.name)).toContain('schema_migrations');

    const postingColumns = db.prepare('PRAGMA table_info(job_postings)').all() as Array<{ name: string }>;
    const postingNames = postingColumns.map((c) => c.name);
    for (const expected of [
      'id',
      'job_id',
      'source',
      'source_url',
      'title',
      'company',
      'location',
      'remote',
      'salary_min',
      'salary_max',
      'salary_currency',
      'tags',
      'description',
      'posted_at',
      'normalized_key',
      'status',
      'first_seen_at',
      'last_seen_at',
      'fetched_at',
      'created_at',
      'updated_at',
    ]) {
      expect(postingNames).toContain(expected);
    }
    const postingIndexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='job_postings'")
      .all() as Array<{ name: string }>;
    expect(postingIndexes.map((i) => i.name)).toContain('idx_job_postings_source_url');
    expect(postingIndexes.map((i) => i.name)).toContain('idx_job_postings_status_posted');

    const profileColumns = db.prepare('PRAGMA table_info(profiles)').all() as Array<{ name: string }>;
    const profileNames = profileColumns.map((c) => c.name);
    for (const expected of [
      'id',
      'analyzer_version',
      'subject_platform',
      'subject_login',
      'subject_claimed',
      'data_window_since',
      'data_window_until',
      'analysis_layers',
      'status',
      'snapshot',
      'created_at',
      'updated_at',
    ]) {
      expect(profileNames).toContain(expected);
    }

    const jobColumns = db.prepare('PRAGMA table_info(analysis_jobs)').all() as Array<{ name: string }>;
    const jobNames = jobColumns.map((c) => c.name);
    for (const expected of [
      'id',
      'subject_platform',
      'subject_login',
      'status',
      'stage',
      'attempts',
      'profile_id',
      'error_message',
      'budget_used',
      'missing',
      'claimed_by',
      'created_at',
      'updated_at',
      'started_at',
      'finished_at',
      'requester_kind',
      'demo_session_id',
    ]) {
      expect(jobNames).toContain(expected);
    }

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='profiles'")
      .all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).toContain('idx_profiles_subject_created');

    const jobIndexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='analysis_jobs'")
      .all() as Array<{ name: string }>;
    expect(jobIndexes.map((i) => i.name)).toContain('idx_analysis_jobs_status_created');
    expect(jobIndexes.map((i) => i.name)).toContain('idx_analysis_jobs_subject_created');
    expect(jobIndexes.map((i) => i.name)).toContain('idx_analysis_jobs_requester_status');
    expect(jobIndexes.map((i) => i.name)).toContain('idx_analysis_jobs_demo_session');

    const demoSessionColumns = db.prepare('PRAGMA table_info(demo_sessions)').all() as Array<{ name: string }>;
    for (const expected of [
      'id',
      'created_at',
      'last_seen_at',
      'expires_at',
      'analyze_count',
      'match_count',
      'analyzed_logins',
      'ip_hash',
      'status',
    ]) {
      expect(demoSessionColumns.map((c) => c.name)).toContain(expected);
    }

    const demoRateColumns = db.prepare('PRAGMA table_info(demo_rate_events)').all() as Array<{ name: string }>;
    for (const expected of ['id', 'ip_hash', 'kind', 'created_at']) {
      expect(demoRateColumns.map((c) => c.name)).toContain(expected);
    }

    const demoRateIndexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='demo_rate_events'")
      .all() as Array<{ name: string }>;
    expect(demoRateIndexes.map((i) => i.name)).toContain('idx_demo_rate_events_ip_kind_created');

    const applicationColumns = db.prepare('PRAGMA table_info(applications)').all() as Array<{ name: string }>;
    for (const expected of [
      'id',
      'profile_id',
      'job_id',
      'source',
      'target_title',
      'target_company',
      'target_url',
      'status',
      'note',
      'origin',
      'applied_at',
      'created_at',
      'updated_at',
    ]) {
      expect(applicationColumns.map((c) => c.name)).toContain(expected);
    }
    const applicationIndexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='applications'")
      .all() as Array<{ name: string }>;
    expect(applicationIndexes.map((i) => i.name)).toContain('idx_applications_profile_status');
    expect(applicationIndexes.map((i) => i.name)).toContain('idx_applications_profile_applied');

    const accountColumns = db.prepare('PRAGMA table_info(accounts)').all() as Array<{ name: string }>;
    for (const expected of [
      'id',
      'platform',
      'provider_account_id',
      'login',
      'name',
      'email',
      'avatar_url',
      'claimed_profile_id',
      'created_at',
      'updated_at',
    ]) {
      expect(accountColumns.map((c) => c.name)).toContain(expected);
    }
    const accountIndexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='accounts'")
      .all() as Array<{ name: string }>;
    expect(accountIndexes.map((i) => i.name)).toContain('idx_accounts_provider');
    expect(accountIndexes.map((i) => i.name)).toContain('idx_accounts_platform_login');
    expect(accountIndexes.map((i) => i.name)).toContain('idx_accounts_claimed_profile');

    const authSessionColumns = db
      .prepare('PRAGMA table_info(auth_sessions)')
      .all() as Array<{ name: string }>;
    for (const expected of [
      'id',
      'account_id',
      'expires_at',
      'status',
      'created_at',
      'last_seen_at',
    ]) {
      expect(authSessionColumns.map((c) => c.name)).toContain(expected);
    }
    const authSessionIndexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='auth_sessions'")
      .all() as Array<{ name: string }>;
    expect(authSessionIndexes.map((i) => i.name)).toContain('idx_auth_sessions_account');
    expect(authSessionIndexes.map((i) => i.name)).toContain('idx_auth_sessions_expires');

    const interviewColumns = db
      .prepare('PRAGMA table_info(interviews)')
      .all() as Array<{ name: string }>;
    for (const expected of [
      'id',
      'profile_id',
      'application_id',
      'target_title',
      'target_company',
      'scheduled_start',
      'scheduled_end',
      'format',
      'round_label',
      'interviewer_name',
      'interviewer_email',
      'status',
      'outcome',
      'feedback_note',
      'rating',
      'created_by_account_id',
      'created_at',
      'updated_at',
    ]) {
      expect(interviewColumns.map((c) => c.name)).toContain(expected);
    }
    const interviewIndexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='interviews'")
      .all() as Array<{ name: string }>;
    expect(interviewIndexes.map((i) => i.name)).toContain('idx_interviews_owner_status');
    expect(interviewIndexes.map((i) => i.name)).toContain('idx_interviews_profile_start');
    expect(interviewIndexes.map((i) => i.name)).toContain('idx_interviews_application');

    db.close();
  });

  it('is idempotent on a second run', () => {
    const db = freshDb();
    const first = runMigrations(db, MIGRATIONS_DIR);
    const second = runMigrations(db, MIGRATIONS_DIR);
    expect(first.applied.length).toBeGreaterThan(0);
    expect(second.applied).toEqual([]);
    db.close();
  });

  it('rolls back migrations in reverse order with their down scripts', () => {
    const db = freshDb();
    runMigrations(db, MIGRATIONS_DIR);

    // 回滚 013（applications 只去掉归属列，表本身仍在）
    const colsBefore13 = db.prepare('PRAGMA table_info(applications)').all() as Array<{ name: string }>;
    expect(colsBefore13.map((c) => c.name)).toContain('created_by_account_id');
    const result13 = rollbackLatestMigration(db, MIGRATIONS_DIR);
    expect(result13.version).toBe('013');
    const colsAfter13 = db.prepare('PRAGMA table_info(applications)').all() as Array<{ name: string }>;
    expect(colsAfter13.map((c) => c.name)).not.toContain('created_by_account_id');
    let tablesAfter13 = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    expect(tablesAfter13.map((t) => t.name)).toContain('applications'); // 只丢列，不丢表

    // 回滚 012（interviews）
    const result12 = rollbackLatestMigration(db, MIGRATIONS_DIR);
    expect(result12.version).toBe('012');
    const ivTables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    expect(ivTables.map((t) => t.name)).not.toContain('interviews');
    expect(ivTables.map((t) => t.name)).toContain('auth_sessions'); // 011 还在

    // 回滚 011（auth_sessions）
    const result11 = rollbackLatestMigration(db, MIGRATIONS_DIR);
    expect(result11.version).toBe('011');
    let authTables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    expect(authTables.map((t) => t.name)).not.toContain('auth_sessions');
    expect(authTables.map((t) => t.name)).toContain('accounts'); // 010 还在

    // 回滚 010（accounts）
    const result10 = rollbackLatestMigration(db, MIGRATIONS_DIR);
    expect(result10.version).toBe('010');
    authTables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    expect(authTables.map((t) => t.name)).not.toContain('accounts');
    expect(authTables.map((t) => t.name)).toContain('applications'); // 009 还在

    // 第零步 0：回滚 009（applications）
    const result9 = rollbackLatestMigration(db, MIGRATIONS_DIR);
    expect(result9.version).toBe('009');
    let appTables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    expect(appTables.map((t) => t.name)).not.toContain('applications');
    // 008 的列仍在
    const jobColsAfter9 = db.prepare('PRAGMA table_info(analysis_jobs)').all() as Array<{ name: string }>;
    expect(jobColsAfter9.map((c) => c.name)).toContain('requester_kind');

    // 第零步 a：回滚 008（analysis_jobs 移除 requester 两列，表本身仍在）
    const result8 = rollbackLatestMigration(db, MIGRATIONS_DIR);
    expect(result8.version).toBe('008');
    const jobColsAfter8 = db.prepare('PRAGMA table_info(analysis_jobs)').all() as Array<{ name: string }>;
    expect(jobColsAfter8.map((c) => c.name)).not.toContain('requester_kind');
    expect(jobColsAfter8.map((c) => c.name)).not.toContain('demo_session_id');

    // 第零步 b：回滚 007（demo_rate_events）
    const result7 = rollbackLatestMigration(db, MIGRATIONS_DIR);
    expect(result7.version).toBe('007');
    let demoTables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    expect(demoTables.map((t) => t.name)).not.toContain('demo_rate_events');
    expect(demoTables.map((t) => t.name)).toContain('demo_sessions'); // 006 还在

    // 第零步 c：回滚 006（demo_sessions）
    const result6 = rollbackLatestMigration(db, MIGRATIONS_DIR);
    expect(result6.version).toBe('006');
    demoTables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    expect(demoTables.map((t) => t.name)).not.toContain('demo_sessions');
    expect(demoTables.map((t) => t.name)).toContain('job_postings'); // 005 还在

    // 第一步：回滚最新的 005（job_postings）
    const result5 = rollbackLatestMigration(db, MIGRATIONS_DIR);
    expect(result5.version).toBe('005');

    const preTables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    expect(preTables.map((t) => t.name)).not.toContain('job_postings');
    expect(preTables.map((t) => t.name)).toContain('waitlist'); // 004 还在

    // 第一步：回滚 004（waitlist）
    const result4 = rollbackLatestMigration(db, MIGRATIONS_DIR);
    expect(result4.version).toBe('004');

    let tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).not.toContain('waitlist');
    expect(tables.map((t) => t.name)).toContain('evidence'); // 003 还在
    expect(tables.map((t) => t.name)).toContain('analysis_jobs'); // 002 还在
    expect(tables.map((t) => t.name)).toContain('profiles'); // 001 还在

    let versions = db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: string }>;
    expect(versions.map((v) => v.version)).toEqual(['001', '002', '003']);

    // 第二步：回滚 003（evidence）
    const result3 = rollbackLatestMigration(db, MIGRATIONS_DIR);
    expect(result3.version).toBe('003');

    tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).not.toContain('evidence');
    expect(tables.map((t) => t.name)).not.toContain('waitlist');
    expect(tables.map((t) => t.name)).toContain('analysis_jobs'); // 002 还在
    expect(tables.map((t) => t.name)).toContain('profiles'); // 001 还在

    versions = db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: string }>;
    expect(versions.map((v) => v.version)).toEqual(['001', '002']);

    // 第三步：回滚 002（analysis_jobs）
    const result2 = rollbackLatestMigration(db, MIGRATIONS_DIR);
    expect(result2.version).toBe('002');

    tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).not.toContain('analysis_jobs');
    expect(tables.map((t) => t.name)).toContain('profiles'); // 001 还在

    versions = db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: string }>;
    expect(versions.map((v) => v.version)).toEqual(['001']);

    // 第四步：回滚 001（profiles）
    const result1 = rollbackLatestMigration(db, MIGRATIONS_DIR);
    expect(result1.version).toBe('001');

    tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).not.toContain('profiles');
    expect(tables.map((t) => t.name)).not.toContain('analysis_jobs');
    expect(tables.map((t) => t.name)).not.toContain('evidence');

    versions = db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: string }>;
    expect(versions).toEqual([]);
    db.close();
  });
});
