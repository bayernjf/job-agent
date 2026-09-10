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
  '../../../db/migrations',
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

  it('creates the core profiles table with expected columns', () => {
    const db = freshDb();
    runMigrations(db, MIGRATIONS_DIR);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain('profiles');
    expect(tables.map((t) => t.name)).toContain('schema_migrations');

    const columns = db.prepare('PRAGMA table_info(profiles)').all() as Array<{ name: string }>;
    const names = columns.map((c) => c.name);
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
      expect(names).toContain(expected);
    }

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='profiles'")
      .all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).toContain('idx_profiles_subject_created');
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

  it('rolls back the latest migration with its down script', () => {
    const db = freshDb();
    runMigrations(db, MIGRATIONS_DIR);
    const result = rollbackLatestMigration(db, MIGRATIONS_DIR);
    expect(result.version).toBe('001');

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).not.toContain('profiles');

    const versions = db.prepare('SELECT version FROM schema_migrations').all();
    expect(versions).toEqual([]);
    db.close();
  });
});
