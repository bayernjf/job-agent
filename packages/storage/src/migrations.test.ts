import fs from 'node:fs';
import os from 'node:os';
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

    // 016/017（S3 按主体撤回）：申请单表 + profiles 挂起标记
    expect(tables.map((t) => t.name)).toContain('profile_removal_requests');
    const removalColumns = db
      .prepare('PRAGMA table_info(profile_removal_requests)')
      .all() as Array<{ name: string }>;
    for (const expected of [
      'id',
      'profile_id',
      'status',
      'reason',
      'contact',
      'ip_hash',
      'created_at',
      'decided_at',
    ]) {
      expect(removalColumns.map((c) => c.name)).toContain(expected);
    }
    const removalIndexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='profile_removal_requests'",
      )
      .all() as Array<{ name: string }>;
    expect(removalIndexes.map((i) => i.name)).toContain('idx_prr_profile_status');
    expect(removalIndexes.map((i) => i.name)).toContain('idx_prr_status_created');
    const profileRemovalCols = db.prepare('PRAGMA table_info(profiles)').all() as Array<{ name: string }>;
    expect(profileRemovalCols.map((c) => c.name)).toContain('removal_requested_at');

    // 018–021（求职 Agent 阶段 1 求职工作台）：偏好集 / 任务 / 事件流 / 投递票据
    expect(tables.map((t) => t.name)).toContain('job_preferences');
    const preferenceColumns = db
      .prepare('PRAGMA table_info(job_preferences)')
      .all() as Array<{ name: string }>;
    for (const expected of [
      'id',
      'account_id',
      'label',
      'target_titles',
      'skills',
      'locations',
      'remote_only',
      'salary_min_usd',
      'sources',
      'company_whitelist',
      'company_blacklist',
      'min_tier',
      'daily_submit_limit',
      'created_at',
      'updated_at',
    ]) {
      expect(preferenceColumns.map((c) => c.name)).toContain(expected);
    }
    const preferenceIndexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='job_preferences'")
      .all() as Array<{ name: string }>;
    expect(preferenceIndexes.map((i) => i.name)).toContain('idx_jp_account');

    expect(tables.map((t) => t.name)).toContain('job_runs');
    const runColumns = db.prepare('PRAGMA table_info(job_runs)').all() as Array<{ name: string }>;
    for (const expected of [
      'id',
      'account_id',
      'profile_id',
      'preference_id',
      'status',
      'attempts',
      'last_error',
      'last_scan_at',
      'created_at',
      'updated_at',
    ]) {
      expect(runColumns.map((c) => c.name)).toContain(expected);
    }
    const runIndexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='job_runs'")
      .all() as Array<{ name: string }>;
    expect(runIndexes.map((i) => i.name)).toContain('idx_jr_status');
    expect(runIndexes.map((i) => i.name)).toContain('idx_jr_account');

    expect(tables.map((t) => t.name)).toContain('job_run_events');
    const runEventColumns = db
      .prepare('PRAGMA table_info(job_run_events)')
      .all() as Array<{ name: string }>;
    for (const expected of [
      'id',
      'run_id',
      'event',
      'from_status',
      'to_status',
      'actor',
      'payload',
      'created_at',
    ]) {
      expect(runEventColumns.map((c) => c.name)).toContain(expected);
    }
    const runEventIndexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='job_run_events'")
      .all() as Array<{ name: string }>;
    expect(runEventIndexes.map((i) => i.name)).toContain('idx_jre_run');

    expect(tables.map((t) => t.name)).toContain('submit_intents');
    const submitIntentColumns = db
      .prepare('PRAGMA table_info(submit_intents)')
      .all() as Array<{ name: string }>;
    for (const expected of [
      'id',
      'run_id',
      'account_id',
      'profile_id',
      'job_id',
      'job_source',
      'job_snapshot',
      'match_score',
      'match_tier',
      'match_report',
      'status',
      'reject_reason',
      'approved_at',
      'rejected_at',
      'submitted_at',
      'application_id',
      'created_at',
      'updated_at',
    ]) {
      expect(submitIntentColumns.map((c) => c.name)).toContain(expected);
    }
    const submitIntentIndexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='submit_intents'")
      .all() as Array<{ name: string }>;
    expect(submitIntentIndexes.map((i) => i.name)).toContain('idx_si_run');
    expect(submitIntentIndexes.map((i) => i.name)).toContain('idx_si_account_status');
    expect(submitIntentIndexes.map((i) => i.name)).toContain('idx_si_source');

    // 022：applications 回填票据外键列（origin 仍是自由文本，009 未加 CHECK）
    const applicationIntentCols = db
      .prepare('PRAGMA table_info(applications)')
      .all() as Array<{ name: string }>;
    expect(applicationIntentCols.map((c) => c.name)).toContain('submit_intent_id');

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

  it('T32: a failing migration file leaves no partial schema and records no version', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ja-migrations-'));
    fs.writeFileSync(
      path.join(dir, '001_partial_failure.sql'),
      [
        '-- Migration 001: create probe table',
        '-- File: 001_partial_failure.sql',
        '-- Date: 2026-09-26 01:20',
        'CREATE TABLE probe_t32 (id INTEGER NOT NULL);',
        '-- 故意失败：引用不存在的表',
        'INSERT INTO probe_absent_table VALUES (1);',
        '-- DOWN BEGIN',
        'DROP TABLE IF EXISTS probe_t32;',
        '-- DOWN END',
        '',
      ].join('\n'),
    );

    const db = freshDb();
    try {
      expect(() => runMigrations(db, dir)).toThrow();
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as Array<{ name: string }>;
      // 第一条语句已建出的表必须随事务一起回滚，否则库处于半破状态
      expect(tables.map((t) => t.name)).not.toContain('probe_t32');
      const versions = db.prepare('SELECT version FROM schema_migrations').all() as Array<{
        version: string;
      }>;
      expect(versions.map((v) => v.version)).not.toContain('001');
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rolls back migrations in reverse order with their down scripts', () => {
    const db = freshDb();
    runMigrations(db, MIGRATIONS_DIR);

    // 回滚 027（api_tokens 整表，扩展登录态长期 token）
    const tokenTablesBefore27 = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    expect(tokenTablesBefore27.map((t) => t.name)).toContain('api_tokens');
    const result27 = rollbackLatestMigration(db, MIGRATIONS_DIR);
    expect(result27.version).toBe('027');
    const tokenTablesAfter27 = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    expect(tokenTablesAfter27.map((t) => t.name)).not.toContain('api_tokens');

    // 回滚 026（extension_auth_codes 整表，一次性授权码）
    const codeTablesBefore26 = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    expect(codeTablesBefore26.map((t) => t.name)).toContain('extension_auth_codes');
    const result26 = rollbackLatestMigration(db, MIGRATIONS_DIR);
    expect(result26.version).toBe('026');
    const codeTablesAfter26 = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    expect(codeTablesAfter26.map((t) => t.name)).not.toContain('extension_auth_codes');

    // 回滚 025（user_llm_configs 整表，BYOK 模型配置）
    const cfgTablesBefore25 = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    expect(cfgTablesBefore25.map((t) => t.name)).toContain('user_llm_configs');
    const result25 = rollbackLatestMigration(db, MIGRATIONS_DIR);
    expect(result25.version).toBe('025');
    const cfgTablesAfter25 = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    expect(cfgTablesAfter25.map((t) => t.name)).not.toContain('user_llm_configs');

    // 回滚 024（llm_catalog_models 整表，内置模型目录）
    const catTablesBefore24 = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    expect(catTablesBefore24.map((t) => t.name)).toContain('llm_catalog_models');
    const result24 = rollbackLatestMigration(db, MIGRATIONS_DIR);
    expect(result24.version).toBe('024');
    const catTablesAfter24 = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    expect(catTablesAfter24.map((t) => t.name)).not.toContain('llm_catalog_models');

    // 回滚 023（accounts 去掉 is_admin 列，表本身仍在）
    const accColsBefore23 = db.prepare('PRAGMA table_info(accounts)').all() as Array<{ name: string }>;
    expect(accColsBefore23.map((c) => c.name)).toContain('is_admin');
    const result23 = rollbackLatestMigration(db, MIGRATIONS_DIR);
    expect(result23.version).toBe('023');
    const accColsAfter23 = db.prepare('PRAGMA table_info(accounts)').all() as Array<{ name: string }>;
    expect(accColsAfter23.map((c) => c.name)).not.toContain('is_admin');
    expect(accColsAfter23.map((c) => c.name)).toContain('recruiter_declared_at'); // 只丢列，不丢表

    // 回滚 022（applications 去掉 submit_intent_id 票据外键列，表本身仍在）
    const appColsBefore22 = db.prepare('PRAGMA table_info(applications)').all() as Array<{ name: string }>;
    expect(appColsBefore22.map((c) => c.name)).toContain('submit_intent_id');
    const result22 = rollbackLatestMigration(db, MIGRATIONS_DIR);
    expect(result22.version).toBe('022');
    const appColsAfter22 = db.prepare('PRAGMA table_info(applications)').all() as Array<{ name: string }>;
    expect(appColsAfter22.map((c) => c.name)).not.toContain('submit_intent_id');
    expect(appColsAfter22.map((c) => c.name)).toContain('origin'); // 只丢列，不丢表

    // 回滚 021（submit_intents 整表）
    const submitTablesBefore21 = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    expect(submitTablesBefore21.map((t) => t.name)).toContain('submit_intents');
    const result21 = rollbackLatestMigration(db, MIGRATIONS_DIR);
    expect(result21.version).toBe('021');
    const submitTablesAfter21 = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    expect(submitTablesAfter21.map((t) => t.name)).not.toContain('submit_intents');
    expect(submitTablesAfter21.map((t) => t.name)).toContain('job_run_events'); // 020 还在

    // 回滚 020（job_run_events 整表）
    const result20 = rollbackLatestMigration(db, MIGRATIONS_DIR);
    expect(result20.version).toBe('020');
    const runEventTablesAfter20 = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    expect(runEventTablesAfter20.map((t) => t.name)).not.toContain('job_run_events');
    expect(runEventTablesAfter20.map((t) => t.name)).toContain('job_runs'); // 019 还在

    // 回滚 019（job_runs 整表）
    const result19 = rollbackLatestMigration(db, MIGRATIONS_DIR);
    expect(result19.version).toBe('019');
    const runTablesAfter19 = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    expect(runTablesAfter19.map((t) => t.name)).not.toContain('job_runs');
    expect(runTablesAfter19.map((t) => t.name)).toContain('job_preferences'); // 018 还在

    // 回滚 018（job_preferences 整表）
    const result18 = rollbackLatestMigration(db, MIGRATIONS_DIR);
    expect(result18.version).toBe('018');
    const preferenceTablesAfter18 = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    expect(preferenceTablesAfter18.map((t) => t.name)).not.toContain('job_preferences');
    expect(preferenceTablesAfter18.map((t) => t.name)).toContain('applications'); // 009 还在

    // 回滚 017（profiles 去掉 removal_requested_at 挂起标记，表本身仍在）
    const profileColsBefore17 = db.prepare('PRAGMA table_info(profiles)').all() as Array<{ name: string }>;
    expect(profileColsBefore17.map((c) => c.name)).toContain('removal_requested_at');
    const result17 = rollbackLatestMigration(db, MIGRATIONS_DIR);
    expect(result17.version).toBe('017');
    const profileColsAfter17 = db.prepare('PRAGMA table_info(profiles)').all() as Array<{ name: string }>;
    expect(profileColsAfter17.map((c) => c.name)).not.toContain('removal_requested_at');
    expect(profileColsAfter17.map((c) => c.name)).toContain('subject_login'); // 只丢列，不丢表

    // 回滚 016（profile_removal_requests 整表）
    const remTablesBefore16 = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    expect(remTablesBefore16.map((t) => t.name)).toContain('profile_removal_requests');
    const result16 = rollbackLatestMigration(db, MIGRATIONS_DIR);
    expect(result16.version).toBe('016');
    const remTablesAfter16 = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    expect(remTablesAfter16.map((t) => t.name)).not.toContain('profile_removal_requests');
    expect(remTablesAfter16.map((t) => t.name)).toContain('accounts'); // 015 还在

    // 回滚 015（accounts 去掉 recruiter_declared_at，表本身仍在）
    const accountColsBefore15 = db.prepare('PRAGMA table_info(accounts)').all() as Array<{ name: string }>;
    expect(accountColsBefore15.map((c) => c.name)).toContain('recruiter_declared_at');
    const result15 = rollbackLatestMigration(db, MIGRATIONS_DIR);
    expect(result15.version).toBe('015');
    const accountColsAfter15 = db.prepare('PRAGMA table_info(accounts)').all() as Array<{ name: string }>;
    expect(accountColsAfter15.map((c) => c.name)).not.toContain('recruiter_declared_at');

    // 回滚 014（证据主键退回单列 id；空库无跨画像重复 id，所以回滚是安全的）
    const pkBefore14 = (db.prepare('PRAGMA table_info(evidence)').all() as Array<{
      name: string;
      pk: number;
    }>)
      .filter((c) => c.pk > 0)
      .map((c) => c.name)
      .sort();
    expect(pkBefore14).toEqual(['id', 'profile_id']);
    const result14 = rollbackLatestMigration(db, MIGRATIONS_DIR);
    expect(result14.version).toBe('014');
    const pkAfter14 = (db.prepare('PRAGMA table_info(evidence)').all() as Array<{
      name: string;
      pk: number;
    }>)
      .filter((c) => c.pk > 0)
      .map((c) => c.name);
    expect(pkAfter14).toEqual(['id']);
    let evidenceAfter14 = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    expect(evidenceAfter14.map((t) => t.name)).toContain('evidence'); // 只换主键，不丢表

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
