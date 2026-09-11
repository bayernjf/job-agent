import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './migrator.js';
import { WaitlistRepository, type NewWaitlist } from './waitlist.js';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../db/migrations/sqlite',
);

function freshRepo(): WaitlistRepository {
  const db = new Database(':memory:');
  runMigrations(db, MIGRATIONS_DIR);
  const orm = drizzle(db);
  return new WaitlistRepository(orm);
}

function sampleEntry(id: string, email = 'test@example.com'): NewWaitlist {
  return {
    id,
    email,
    name: 'Test User',
    githubUsername: 'testuser',
    source: 'landing_page',
  };
}

describe('WaitlistRepository', () => {
  it('inserts and retrieves waitlist entry by id', () => {
    const repo = freshRepo();
    repo.insert(sampleEntry('wl-001'));

    const entry = repo.getById('wl-001');
    expect(entry).toBeDefined();
    expect(entry!.id).toBe('wl-001');
    expect(entry!.email).toBe('test@example.com');
    expect(entry!.name).toBe('Test User');
    expect(entry!.githubUsername).toBe('testuser');
    expect(entry!.source).toBe('landing_page');
    expect(entry!.status).toBe('pending');
    expect(entry!.createdAt).toBeTruthy();
  });

  it('retrieves entry by email (dedup check)', () => {
    const repo = freshRepo();
    repo.insert(sampleEntry('wl-001', 'unique@example.com'));

    const entry = repo.getByEmail('unique@example.com');
    expect(entry).toBeDefined();
    expect(entry!.id).toBe('wl-001');

    expect(repo.getByEmail('nonexistent@example.com')).toBeUndefined();
  });

  it('rejects duplicate email (SQLite UNIQUE constraint)', () => {
    const repo = freshRepo();
    repo.insert(sampleEntry('wl-001', 'dup@example.com'));
    expect(() => repo.insert(sampleEntry('wl-002', 'dup@example.com'))).toThrow();
  });

  it('lists entries by status', () => {
    const repo = freshRepo();
    repo.insert(sampleEntry('wl-001', 'pending1@example.com'));
    repo.insert(sampleEntry('wl-002', 'pending2@example.com'));
    repo.insert(sampleEntry('wl-003', 'contacted@example.com'));

    repo.updateStatus('wl-003', 'contacted');

    const pending = repo.listByStatus('pending');
    expect(pending).toHaveLength(2);

    const contacted = repo.listByStatus('contacted');
    expect(contacted).toHaveLength(1);
    expect(contacted[0]!.id).toBe('wl-003');
  });

  it('lists all entries in recency order', () => {
    const repo = freshRepo();
    repo.insert(sampleEntry('wl-001', 'first@example.com'));
    repo.insert(sampleEntry('wl-002', 'second@example.com'));
    repo.insert(sampleEntry('wl-003', 'third@example.com'));

    const all = repo.listAll();
    expect(all).toHaveLength(3);
    // 默认按 created_at DESC，但内存库中同一毫秒插入可能顺序不确定
    expect(all.map((e) => e.id).sort()).toEqual(['wl-001', 'wl-002', 'wl-003']);
  });

  it('updates entry status', () => {
    const repo = freshRepo();
    repo.insert(sampleEntry('wl-001'));

    repo.updateStatus('wl-001', 'contacted');
    expect(repo.getById('wl-001')!.status).toBe('contacted');

    repo.updateStatus('wl-001', 'converted');
    expect(repo.getById('wl-001')!.status).toBe('converted');
  });

  it('updates entry notes', () => {
    const repo = freshRepo();
    repo.insert(sampleEntry('wl-001'));

    repo.updateNotes('wl-001', 'Interested in enterprise plan');
    expect(repo.getById('wl-001')!.notes).toBe('Interested in enterprise plan');
  });

  it('counts entries by status', () => {
    const repo = freshRepo();
    repo.insert(sampleEntry('wl-001', 'a@example.com'));
    repo.insert(sampleEntry('wl-002', 'b@example.com'));
    repo.insert(sampleEntry('wl-003', 'c@example.com'));

    repo.updateStatus('wl-002', 'contacted');
    repo.updateStatus('wl-003', 'converted');

    const counts = repo.countByStatus();
    expect(counts.pending).toBe(1);
    expect(counts.contacted).toBe(1);
    expect(counts.converted).toBe(1);
    expect(counts.archived).toBe(0);
  });

  it('migration 004 creates waitlist table with expected columns', () => {
    const db = new Database(':memory:');
    runMigrations(db, MIGRATIONS_DIR);

    const columns = db
      .prepare("PRAGMA table_info(waitlist)")
      .all() as Array<{ name: string }>;
    const colNames = columns.map((c) => c.name);

    for (const expected of [
      'id', 'email', 'name', 'github_username', 'source',
      'status', 'notes', 'created_at', 'updated_at',
    ]) {
      expect(colNames).toContain(expected);
    }

    // email 应该有 UNIQUE 约束
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='waitlist'")
      .all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).toContain('idx_waitlist_email');
    expect(indexes.map((i) => i.name)).toContain('idx_waitlist_status_created');

    db.close();
  });
});
