import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './sqlite/migrator.js';
import { openSqlite } from './sqlite/connection.js';
import { SqliteJobPostingsRepository } from './sqlite/job-postings-repo.js';
import { makeJobPostingId, type NewJobPosting } from './entities/index.js';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../db/migrations/sqlite',
);

function freshRepo(): SqliteJobPostingsRepository {
  const { client, db } = openSqlite(':memory:');
  runMigrations(client, MIGRATIONS_DIR);
  return new SqliteJobPostingsRepository(db);
}

let seq = 0;
function samplePosting(overrides: Partial<NewJobPosting> = {}): NewJobPosting {
  seq += 1;
  const n = seq;
  return {
    jobId: `job-${n}`,
    source: 'remoteok',
    sourceUrl: `https://example.com/jobs/${n}`,
    title: 'Senior Rust Engineer',
    company: 'Acme Corp',
    location: 'Remote - US',
    remote: true,
    salaryMin: 100_000,
    salaryMax: 150_000,
    salaryCurrency: 'USD',
    tags: ['rust', 'backend'],
    description: 'Build things in Rust.',
    postedAt: '2026-09-01T00:00:00.000Z',
    fetchedAt: '2026-09-10T00:00:00.000Z',
    normalizedKey: `key-${n}`,
    ...overrides,
  };
}

describe('SqliteJobPostingsRepository', () => {
  it('inserts and retrieves a posting by derived id', async () => {
    const repo = freshRepo();
    const p = samplePosting();
    const counts = await repo.upsertBatch([p], '2026-09-10T00:00:00.000Z');
    expect(counts).toEqual({ inserted: 1, updated: 0, unchanged: 0 });

    const id = makeJobPostingId(p.source, p.sourceUrl);
    const stored = await repo.getById(id);
    expect(stored).toBeDefined();
    expect(stored!.title).toBe('Senior Rust Engineer');
    expect(stored!.tags).toEqual(['rust', 'backend']);
    expect(stored!.status).toBe('active');
    expect(stored!.firstSeenAt).toBe('2026-09-10T00:00:00.000Z');
  });

  it('is idempotent: same (source,sourceUrl) second time is unchanged, no duplicate row', async () => {
    const repo = freshRepo();
    const p = samplePosting();
    await repo.upsertBatch([p], '2026-09-10T00:00:00.000Z');
    const second = await repo.upsertBatch([p], '2026-09-11T00:00:00.000Z');
    expect(second).toEqual({ inserted: 0, updated: 0, unchanged: 1 });

    const rows = await repo.search({ limit: 500 });
    expect(rows).toHaveLength(1);
    // last_seen refreshed, first_seen preserved
    expect(rows[0]!.firstSeenAt).toBe('2026-09-10T00:00:00.000Z');
    expect(rows[0]!.lastSeenAt).toBe('2026-09-11T00:00:00.000Z');
  });

  it('updates changed content while preserving firstSeenAt', async () => {
    const repo = freshRepo();
    const p = samplePosting();
    await repo.upsertBatch([p], '2026-09-10T00:00:00.000Z');
    const changed = samplePosting({ sourceUrl: p.sourceUrl, jobId: p.jobId, title: 'Staff Rust Engineer' });
    const counts = await repo.upsertBatch([changed], '2026-09-12T00:00:00.000Z');
    expect(counts).toEqual({ inserted: 0, updated: 1, unchanged: 0 });

    const rows = await repo.search({ limit: 500 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe('Staff Rust Engineer');
    expect(rows[0]!.firstSeenAt).toBe('2026-09-10T00:00:00.000Z');
  });

  it('searches by keyword across title/company/tags (AND words, case-insensitive)', async () => {
    const repo = freshRepo();
    await repo.upsertBatch(
      [
        samplePosting({ title: 'Rust Backend Engineer', company: 'Alpha' }),
        samplePosting({ title: 'Frontend Developer', company: 'Rustify', tags: ['react'] }),
        samplePosting({ title: 'Data Scientist', company: 'Beta', tags: ['rust-data'] }),
        samplePosting({ title: 'Sales Lead', company: 'Gamma', tags: ['sales'], remote: false }),
      ],
      '2026-09-10T00:00:00.000Z',
    );

    const rust = await repo.search({ keyword: 'rust', limit: 500 });
    expect(rust).toHaveLength(3); // title, company, tag each match once

    const rustEngineer = await repo.search({ keyword: 'rust engineer', limit: 500 });
    expect(rustEngineer).toHaveLength(1);
    expect(rustEngineer[0]!.title).toBe('Rust Backend Engineer');
  });

  it('filters by remote flag, source list and salary floor', async () => {
    const repo = freshRepo();
    await repo.upsertBatch(
      [
        samplePosting({ sourceUrl: 'https://e.com/1', remote: true, salaryMax: 200_000 }),
        samplePosting({ sourceUrl: 'https://e.com/2', remote: false, salaryMax: 80_000 }),
        samplePosting({ sourceUrl: 'https://e.com/3', source: 'remotive', remote: true, salaryMin: null, salaryMax: null }),
      ],
      '2026-09-10T00:00:00.000Z',
    );

    expect(await repo.search({ remote: true, limit: 500 })).toHaveLength(2);
    expect(await repo.search({ sources: ['remotive'], limit: 500 })).toHaveLength(1);
    expect(await repo.search({ salaryMinUsd: 100_000, limit: 500 })).toHaveLength(1);
  });

  it('marks stale active postings inactive and hides them from default search', async () => {
    const repo = freshRepo();
    await repo.upsertBatch([samplePosting()], '2026-09-01T00:00:00.000Z');
    const changed = await repo.markStale('2026-09-08T00:00:00.000Z');
    expect(changed).toBe(1);

    expect(await repo.search({})).toHaveLength(0); // default active only
    const inactive = await repo.search({ status: 'inactive' });
    expect(inactive).toHaveLength(1);
  });

  it('counts by source', async () => {
    const repo = freshRepo();
    await repo.upsertBatch(
      [
        samplePosting({ sourceUrl: 'https://e.com/1', source: 'remoteok' }),
        samplePosting({ sourceUrl: 'https://e.com/2', source: 'remoteok' }),
        samplePosting({ sourceUrl: 'https://e.com/3', source: 'remotive' }),
      ],
      '2026-09-10T00:00:00.000Z',
    );
    const counts = await repo.countBySource();
    expect(counts.remoteok).toBe(2);
    expect(counts.remotive).toBe(1);
  });

  it('countActiveFresh only counts active rows seen within the cutoff window (T24)', async () => {
    const repo = freshRepo();
    await repo.upsertBatch(
      [samplePosting({ sourceUrl: 'https://e.com/fresh', source: 'remoteok' })],
      '2026-09-20T00:00:00.000Z',
    );
    await repo.upsertBatch(
      [samplePosting({ sourceUrl: 'https://e.com/stale', source: 'remoteok' })],
      '2026-08-01T00:00:00.000Z',
    );
    // 只数最近窗口内的行：stale 行虽仍是 active（未跑 markStale），但不再冒充新鲜
    const recent = await repo.countActiveFresh('2026-09-01T00:00:00.000Z');
    expect(recent.remoteok).toBe(1);
    const all = await repo.countActiveFresh('2026-01-01T00:00:00.000Z');
    expect(all.remoteok).toBe(2);
  });
});
