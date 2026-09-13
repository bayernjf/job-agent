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
});
