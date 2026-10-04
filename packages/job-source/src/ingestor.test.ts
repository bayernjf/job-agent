import { describe, expect, it, vi } from 'vitest';
import type { JobPosting, JobSource } from '@jobagent/shared';
import { syncOnce } from './ingestor.js';
import type { JobSourceAdapter } from './adapters/types.js';
import type { NewJobPosting, UpsertCounts } from '@jobagent/storage';

const FETCHED = '2026-09-13T00:00:00.000Z';

function makePosting(source: JobSource, n: number): JobPosting {
  return {
    jobId: `${source}-${n}`,
    source,
    sourceUrl: `https://${source}.test/${n}`,
    title: `Engineer ${n}`,
    company: 'Acme',
    location: null,
    remote: true,
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    tags: [],
    description: null,
    postedAt: FETCHED,
    fetchedAt: FETCHED,
  };
}

function adapter(
  source: JobSource,
  impl: () => Promise<{ postings: JobPosting[]; invalid: number }>,
): JobSourceAdapter {
  return { source, collect: vi.fn(impl) };
}

function fakeRepo(counts: UpsertCounts = { inserted: 1, updated: 0, unchanged: 0 }) {
  const upserted: NewJobPosting[][] = [];
  const markStale = vi.fn(async () => 0);
  const upsertBatch = vi.fn(async (rows: NewJobPosting[]) => {
    upserted.push(rows);
    return { ...counts, inserted: rows.length === 0 ? 0 : counts.inserted };
  });
  return { upsertBatch, markStale, upserted };
}

const fixedNow = () => new Date(FETCHED);

describe('syncOnce', () => {
  it('runs sources serially, enriches normalizedKey, upserts and marks stale', async () => {
    const order: string[] = [];
    const a = adapter('remoteok', async () => {
      order.push('remoteok');
      return { postings: [makePosting('remoteok', 1)], invalid: 0 };
    });
    const b = adapter('remotive', async () => {
      order.push('remotive');
      return { postings: [makePosting('remotive', 1), makePosting('remotive', 2)], invalid: 1 };
    });
    const repo = fakeRepo();
    const result = await syncOnce({ adapters: [a, b], repo, now: fixedNow, staleDays: 7 });

    expect(order).toEqual(['remoteok', 'remotive']);
    expect(result.ok).toBe(true);
    expect(result.markedStale).toBe(0);
    expect(repo.markStale).toHaveBeenCalledOnce();
    expect(repo.upserted[0]![0]).toHaveProperty('normalizedKey');
    const remotive = result.outcomes.find((o) => o.source === 'remotive')!;
    expect(remotive.fetched).toBe(3); // 2 valid + 1 invalid
    expect(remotive.invalid).toBe(1);
  });

  it('logs the database error code instead of the echoed SQL', async () => {
    const hugeSql = 'insert into "job_postings" '.padEnd(12_000, 'x');
    const upsertBatch = vi.fn(async () => {
      const err = new Error(`Failed query: ${hugeSql}`) as Error & { cause?: unknown };
      err.cause = Object.assign(
        new Error('null value in column "salary_min" of relation "job_postings" violates not-null constraint'),
        { code: '23502' },
      );
      throw err;
    });
    const a = adapter('weworkremotely', async () => ({
      postings: [makePosting('weworkremotely', 1)],
      invalid: 0,
    }));

    const result = await syncOnce({
      adapters: [a],
      repo: { upsertBatch, markStale: vi.fn(async () => 0) },
      now: fixedNow,
      staleDays: 7,
    });

    const outcome = result.outcomes.find((o) => o.source === 'weworkremotely')!;
    const message = outcome.error ?? '';
    expect(message).toContain('db 23502');
    expect(message).toContain('violates not-null constraint');
    // 旧写法只打 err.message：上万字符的 SQL 把真正的错误码挤出日志窗口，
    // 生产那条 weworkremotely 失败因此一直读不出原因。
    expect(message).not.toContain('xxxx');
    expect(message.length).toBeLessThan(400);
  });

  it('isolates a failing source and still succeeds overall', async () => {
    const bad = adapter('greenhouse', async () => {
      throw new Error('boom');
    });
    const good = adapter('lever', async () => ({ postings: [makePosting('lever', 1)], invalid: 0 }));
    const repo = fakeRepo();
    const result = await syncOnce({ adapters: [bad, good], repo, now: fixedNow });

    expect(result.ok).toBe(true);
    const gh = result.outcomes.find((o) => o.source === 'greenhouse')!;
    expect(gh.error).toContain('boom');
    expect(result.outcomes.find((o) => o.source === 'lever')!.error).toBeUndefined();
  });

  it('reports ok=false when every source fails or yields nothing', async () => {
    const bad = adapter('remoteok', async () => {
      throw new Error('down');
    });
    const empty = adapter('remotive', async () => ({ postings: [], invalid: 0 }));
    const repo = fakeRepo();
    const result = await syncOnce({ adapters: [bad, empty], repo, now: fixedNow });
    expect(result.ok).toBe(false);
  });

  it('dry-run does not write or mark stale', async () => {
    const a = adapter('remoteok', async () => ({ postings: [makePosting('remoteok', 1)], invalid: 0 }));
    const repo = fakeRepo();
    const result = await syncOnce({ adapters: [a], repo, now: fixedNow, dryRun: true });
    expect(repo.upsertBatch).not.toHaveBeenCalled();
    expect(repo.markStale).not.toHaveBeenCalled();
    expect(result.outcomes[0]!.inserted).toBe(0);
    expect(result.markedStale).toBe(0);
  });

  it('enforces a per-source budget: a hanging source is aborted and skipped, later sources still run', async () => {
    // 模拟 runner 上 greenhouse 请求挂起（永不 resolve）：预算到点必须中止并隔离该源。
    const hang = adapter('greenhouse', () => new Promise<{ postings: JobPosting[]; invalid: number }>(() => {}));
    const good = adapter('lever', async () => ({ postings: [makePosting('lever', 1)], invalid: 0 }));
    const repo = fakeRepo();
    const aborted: boolean[] = [];
    const fakeHttp = {
      getJson: async () => {
        throw new Error('not used in this test');
      },
      abortAll: () => {
        aborted.push(true);
      },
    };
    const result = await syncOnce({
      adapters: [hang, good],
      repo,
      now: fixedNow,
      http: fakeHttp as never,
      sourceBudgetsMs: { greenhouse: 50, lever: 60_000 },
    });

    expect(aborted).toHaveLength(1);
    const gh = result.outcomes.find((o) => o.source === 'greenhouse')!;
    expect(gh.error).toContain('exceeded');
    expect(gh.fetched).toBe(0);
    expect(result.outcomes.find((o) => o.source === 'lever')!.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(repo.upsertBatch).toHaveBeenCalledOnce(); // 只有 lever 的产出入库
  });
});
