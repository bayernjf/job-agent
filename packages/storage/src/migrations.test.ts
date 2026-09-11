import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  listMigrationFiles,
  rollbackLatestMigration,
  runMigrations,
} from './migrator.js';

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
    expect(tables.map((t) => t.name)).toContain('schema_migrations');

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

    // 第一步：回滚最新的 004（waitlist）
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
