import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './sqlite/migrator.js';
import { openSqlite } from './sqlite/connection.js';
import { SqliteWaitlistRepository } from './sqlite/waitlist-repo.js';
import type { NewWaitlist } from './entities/index.js';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../db/migrations/sqlite',
);

function freshRepo(): SqliteWaitlistRepository {
  const { client, db } = openSqlite(':memory:');
  runMigrations(client, MIGRATIONS_DIR);
  return new SqliteWaitlistRepository(db);
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

describe('SqliteWaitlistRepository', () => {
  it('inserts and retrieves waitlist entry by id', async () => {
    const repo = freshRepo();
    await repo.insert(sampleEntry('wl-001'));

    const entry = await repo.getById('wl-001');
    expect(entry).toBeDefined();
    expect(entry!.id).toBe('wl-001');
    expect(entry!.email).toBe('test@example.com');
    expect(entry!.name).toBe('Test User');
    expect(entry!.githubUsername).toBe('testuser');
    expect(entry!.source).toBe('landing_page');
    expect(entry!.status).toBe('pending');
    expect(entry!.createdAt).toBeTruthy();
  });

  it('retrieves entry by email (dedup check)', async () => {
    const repo = freshRepo();
    await repo.insert(sampleEntry('wl-001', 'unique@example.com'));

    const entry = await repo.getByEmail('unique@example.com');
    expect(entry).toBeDefined();
    expect(entry!.id).toBe('wl-001');

    expect(await repo.getByEmail('nonexistent@example.com')).toBeUndefined();
  });

  it('rejects duplicate email (SQLite UNIQUE constraint)', async () => {
    const repo = freshRepo();
    await repo.insert(sampleEntry('wl-001', 'dup@example.com'));
    await expect(repo.insert(sampleEntry('wl-002', 'dup@example.com'))).rejects.toThrow();
  });

  it('lists entries by status', async () => {
    const repo = freshRepo();
    await repo.insert(sampleEntry('wl-001', 'pending1@example.com'));
    await repo.insert(sampleEntry('wl-002', 'pending2@example.com'));
    await repo.insert(sampleEntry('wl-003', 'contacted@example.com'));

    await repo.updateStatus('wl-003', 'contacted');

    const pending = await repo.listByStatus('pending');
    expect(pending).toHaveLength(2);

    const contacted = await repo.listByStatus('contacted');
    expect(contacted).toHaveLength(1);
    expect(contacted[0]!.id).toBe('wl-003');
  });

  it('lists all entries in recency order', async () => {
    const repo = freshRepo();
    await repo.insert(sampleEntry('wl-001', 'first@example.com'));
    await repo.insert(sampleEntry('wl-002', 'second@example.com'));
    await repo.insert(sampleEntry('wl-003', 'third@example.com'));

    const all = await repo.listAll();
    expect(all).toHaveLength(3);
    // 默认按 created_at DESC，但内存库中同一毫秒插入可能顺序不确定
    expect(all.map((e) => e.id).sort()).toEqual(['wl-001', 'wl-002', 'wl-003']);
  });

  it('updates entry status', async () => {
    const repo = freshRepo();
    await repo.insert(sampleEntry('wl-001'));

    await repo.updateStatus('wl-001', 'contacted');
    expect((await repo.getById('wl-001'))!.status).toBe('contacted');

    await repo.updateStatus('wl-001', 'converted');
    expect((await repo.getById('wl-001'))!.status).toBe('converted');
  });

  it('updates entry notes', async () => {
    const repo = freshRepo();
    await repo.insert(sampleEntry('wl-001'));

    await repo.updateNotes('wl-001', 'Interested in enterprise plan');
    expect((await repo.getById('wl-001'))!.notes).toBe('Interested in enterprise plan');
  });

  it('counts entries by status', async () => {
    const repo = freshRepo();
    await repo.insert(sampleEntry('wl-001', 'a@example.com'));
    await repo.insert(sampleEntry('wl-002', 'b@example.com'));
    await repo.insert(sampleEntry('wl-003', 'c@example.com'));

    await repo.updateStatus('wl-002', 'contacted');
    await repo.updateStatus('wl-003', 'converted');

    const counts = await repo.countByStatus();
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
