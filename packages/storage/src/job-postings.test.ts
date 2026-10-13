import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './sqlite/migrator.js';
import { openSqlite } from './sqlite/connection.js';
import { SqliteJobPostingsRepository } from './sqlite/job-postings-repo.js';
import { makeJobPostingId, type NewJobPosting, type RecruiterPostingDraft } from './entities/index.js';

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

  // 回归（生产 2026-10-03 实锤）：WWR RSS 同一岗位在一次抓取里列了两次。
  // 已有行的重复拷贝同进 PG 的 ON CONFLICT DO UPDATE 批次会报 21000
  // （cannot affect row a second time），组批前必须按派生主键去重；
  // 计数口径双方言一致：一次逻辑岗位只计一次，保留最后一次出现的内容。
  it('collapses in-batch duplicates of the same (source,sourceUrl)', async () => {
    const repo = freshRepo();
    const p = samplePosting();

    const fresh = await repo.upsertBatch([p, p], '2026-09-10T00:00:00.000Z');
    expect(fresh).toEqual({ inserted: 1, updated: 0, unchanged: 0 });

    const stale = await repo.upsertBatch(
      [{ ...p, title: 'Wrong Copy' }, { ...p, title: 'Staff Rust Engineer' }],
      '2026-09-11T00:00:00.000Z',
    );
    expect(stale).toEqual({ inserted: 0, updated: 1, unchanged: 0 });

    const rows = await repo.search({ limit: 500 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe('Staff Rust Engineer');
    expect(rows[0]!.firstSeenAt).toBe('2026-09-10T00:00:00.000Z');
    expect(rows[0]!.lastSeenAt).toBe('2026-09-11T00:00:00.000Z');
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

  it('search limit boundary: 5000 passes through and 5001 is clamped to 5000', async () => {
    const repo = freshRepo();
    const batch: NewJobPosting[] = [];
    for (let i = 0; i < 5001; i += 1) {
      batch.push(samplePosting({ sourceUrl: `https://example.com/jobs/bulk-${i}`, jobId: `job-bulk-${i}` }));
    }
    await repo.upsertBatch(batch, '2026-09-10T00:00:00.000Z');
    // agent scanPoolLimit 真实上限：5000 不得被仓储静默截断（默认 2000、env 上限 5000）
    expect(await repo.search({ limit: 5000 })).toHaveLength(5000);
    // 越过 MAX_LIMIT：钳到 5000，而不是放行任意值
    expect(await repo.search({ limit: 5001 })).toHaveLength(5000);
  });

  it('filters by freshness of last_seen_at only when the caller asks (seenAfter)', async () => {
    const repo = freshRepo();
    // 两条都是 active；差别只在"上一次被源站列出"的时间
    await repo.upsertBatch([samplePosting({ sourceUrl: 'https://e.com/fresh' })], '2026-10-12T00:00:00.000Z');
    await repo.upsertBatch([samplePosting({ sourceUrl: 'https://e.com/stale' })], '2026-09-01T00:00:00.000Z');

    const windowed = await repo.search({ seenAfter: '2026-10-05T00:00:00.000Z', limit: 500 });
    expect(windowed.map((p) => p.sourceUrl)).toEqual(['https://e.com/fresh']);

    // 不传＝运营面原样（默认不放窗口，避免每个调用方都被静默少看）
    expect(await repo.search({ limit: 500 })).toHaveLength(2);
    // 与 postedAfter 互不干涉：那条筛的是发布时间
    expect(await repo.search({ postedAfter: '2026-01-01T00:00:00.000Z', limit: 500 })).toHaveLength(2);
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

/**
 * 决策 #25（B3-a，2026-10-13）：招聘方自建 JD 是私有行。
 * 这一组钉的是"公开池永远看不到它"这条隐私不变量——判据是归属列，
 * 而排除发生在仓储层，所以每个读取口都自动受保护。
 */
describe('recruiter-owned postings never enter the public pool', () => {
  function draft(overrides: Partial<RecruiterPostingDraft> = {}): RecruiterPostingDraft {
    return {
      title: 'Staff Agent Engineer',
      company: 'In-house Team',
      location: 'Shanghai',
      remote: false,
      tags: ['typescript', 'agents'],
      description: 'Own our internal agent platform.',
      postedAt: '2026-10-13T00:00:00.000Z',
      fetchedAt: '2026-10-13T00:00:00.000Z',
      createdByAccountId: 'acct-recruiter-1',
      ...overrides,
    };
  }

  it('stays out of search()/per-source counts while returning to its owner', async () => {
    const repo = freshRepo();
    await repo.upsertBatch([samplePosting()], '2026-09-10T00:00:00.000Z');
    const owned = await repo.insertOwned(draft(), '2026-10-13T00:00:00.000Z');

    // 默认读取＝公开池：私有行一条都不出现
    const pool = await repo.search({ limit: 500 });
    expect(pool).toHaveLength(1);
    expect(pool.some((p) => p.source === 'recruiter')).toBe(false);
    const counts = await repo.countBySource();
    expect(counts.recruiter).toBeUndefined();
    const fresh = await repo.countActiveFresh('2026-01-01T00:00:00.000Z');
    expect(fresh.recruiter).toBeUndefined();

    // 只有被显式点名归属时才返回
    const mine = await repo.search({ ownerAccountId: 'acct-recruiter-1', limit: 500 });
    expect(mine).toHaveLength(1);
    expect(mine[0]!.title).toBe('Staff Agent Engineer');
    // 归属列是排除判据，因此仓储的 getById 仍返回该行——单条读取的越权拒绝在路由层
    expect(await repo.getById(owned.id)).toBeDefined();
  });

  it('derives its identity inside the repository', async () => {
    const repo = freshRepo();
    const owned = await repo.insertOwned(draft(), '2026-10-13T00:00:00.000Z');
    expect(owned.source).toBe('recruiter');
    // RFC 2606 保留域：过 JobPostingSchema 的 url 校验，又永远不会被当真外链去抓
    expect(owned.sourceUrl.startsWith('https://recruiter.invalid/acct-recruiter-1/')).toBe(true);
    expect(owned.id).toBe(makeJobPostingId('recruiter', owned.sourceUrl));
    expect(owned.createdByAccountId).toBe('acct-recruiter-1');
    expect(owned.searchRunId ?? null).toBeNull(); // 不挂搜岗 run，否则会被 run 结果口读出
    expect(owned.status).toBe('active');
  });

  it('is never retired by markStale, while pool rows still are (positive control)', async () => {
    const repo = freshRepo();
    await repo.upsertBatch([samplePosting()], '2026-01-01T00:00:00.000Z');
    await repo.insertOwned(draft(), '2026-01-01T00:00:00.000Z');

    const changed = await repo.markStale('2026-06-01T00:00:00.000Z');
    expect(changed).toBe(1); // 清扫照常工作（不是被我这条例外整体挡掉）

    const mine = await repo.search({ ownerAccountId: 'acct-recruiter-1', status: 'active' });
    expect(mine).toHaveLength(1);
    const retired = await repo.search({ ownerAccountId: 'acct-recruiter-1', status: 'inactive' });
    expect(retired).toHaveLength(0);
  });

  it('lists only my rows (retired included) and nothing for another account', async () => {
    const repo = freshRepo();
    const first = await repo.insertOwned(draft(), '2026-10-13T00:00:00.000Z');
    await repo.insertOwned(
      draft({ title: 'Second Role', postedAt: '2026-10-14T00:00:00.000Z' }),
      '2026-10-14T00:00:00.000Z',
    );
    await repo.upsertBatch([samplePosting()], '2026-09-10T00:00:00.000Z');

    const mine = await repo.listOwned('acct-recruiter-1');
    expect(mine).toHaveLength(2);
    expect(mine.map((p) => p.title)).toEqual(['Second Role', 'Staff Agent Engineer']); // postedAt desc
    expect(await repo.listOwned('acct-other')).toHaveLength(0);

    const retired = await repo.retireOwned(first.id, 'acct-recruiter-1', '2026-10-15T00:00:00.000Z');
    expect(retired!.status).toBe('inactive');
    expect(await repo.listOwned('acct-recruiter-1')).toHaveLength(2); // 含已下线
    expect(await repo.listOwned('acct-recruiter-1', { status: 'active' })).toHaveLength(1);
  });

  it('treats a foreign row as nonexistent on retireOwned (no existence leak)', async () => {
    const repo = freshRepo();
    const owned = await repo.insertOwned(draft(), '2026-10-13T00:00:00.000Z');
    expect(await repo.retireOwned(owned.id, 'acct-intruder', '2026-10-14T00:00:00.000Z')).toBeUndefined();
    const stillActive = await repo.search({ ownerAccountId: 'acct-recruiter-1' });
    expect(stillActive[0]!.status).toBe('active');
    expect(await repo.retireOwned('nope', 'acct-recruiter-1', '2026-10-14T00:00:00.000Z')).toBeUndefined();
  });
});

describe('listSightingsByNormalizedKeys (repost observation reads)', () => {
  it('returns every pool row sharing a key, oldest first, inactive included', async () => {
    const repo = freshRepo();
    // 同一岗位文本被两个源分别列过：两次入库 → 两条观测
    await repo.upsertBatch(
      [samplePosting({ normalizedKey: 'same-text', source: 'remoteok' })],
      '2026-06-01T00:00:00.000Z',
    );
    await repo.upsertBatch(
      [
        samplePosting({
          normalizedKey: 'same-text',
          source: 'remotive',
          sourceUrl: 'https://example.com/jobs/other',
        }),
      ],
      '2026-09-05T00:00:00.000Z',
    );
    await repo.upsertBatch(
      [samplePosting({ normalizedKey: 'other-text' })],
      '2026-09-06T00:00:00.000Z',
    );

    const sightings = await repo.listSightingsByNormalizedKeys(['same-text']);
    expect(sightings).toHaveLength(2);
    expect(sightings.map((s) => s.source)).toEqual(['remoteok', 'remotive']);
    expect(sightings.map((s) => s.firstSeenAt)).toEqual([
      '2026-06-01T00:00:00.000Z',
      '2026-09-05T00:00:00.000Z',
    ]);

    // 失活只改 status、不刷 last_seen_at ⇒ 已下架的历史观测仍是再上架判据的输入
    await repo.markStale('2026-09-06T00:00:00.000Z');
    const afterStale = await repo.listSightingsByNormalizedKeys(['same-text']);
    expect(afterStale).toHaveLength(2);
    expect(afterStale.map((s) => s.lastSeenAt)).toEqual([
      '2026-06-01T00:00:00.000Z',
      '2026-09-05T00:00:00.000Z',
    ]);
  });

  it('short-circuits an empty key list instead of emitting IN ()', async () => {
    const repo = freshRepo();
    await repo.upsertBatch([samplePosting()], '2026-09-10T00:00:00.000Z');
    expect(await repo.listSightingsByNormalizedKeys([])).toEqual([]);
  });

  it('never surfaces a row whose normalized_key is absent (recruiter JD, empty-string probe)', async () => {
    const repo = freshRepo();
    await repo.insertOwned(
      {
        title: 'Staff Agent Engineer',
        company: 'In-house Team',
        location: 'Shanghai',
        remote: false,
        tags: ['typescript'],
        description: 'Own our internal agent platform.',
        postedAt: '2026-10-13T00:00:00.000Z',
        fetchedAt: '2026-10-13T00:00:00.000Z',
        createdByAccountId: 'acct-recruiter-1',
      },
      '2026-10-13T00:00:00.000Z',
    );
    // SQL 的 `NULL IN ('')` 永不为真：调用方误传空串也拿不到任何私有行
    expect(await repo.listSightingsByNormalizedKeys([''])).toEqual([]);
  });
});
