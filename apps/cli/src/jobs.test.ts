import { describe, expect, it } from 'vitest';
import { createStorage } from '@jobagent/storage';
import type { StorageContext } from '@jobagent/storage';
import type { JobPosting, JobSource } from '@jobagent/shared';
import type { JobSourceAdapter } from '@jobagent/job-source';
import { run, type CliDeps } from './index.js';

const FETCHED = '2026-09-13T00:00:00.000Z';

function posting(source: JobSource, n: number, title: string): JobPosting {
  return {
    jobId: `${source}-${n}`,
    source,
    sourceUrl: `https://${source}.test/${n}`,
    title,
    company: 'Acme',
    location: n % 2 ? 'Remote - US' : 'Berlin',
    remote: n % 2 === 1,
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    tags: ['backend'],
    description: null,
    postedAt: FETCHED,
    fetchedAt: FETCHED,
  };
}

function fakeAdapter(source: JobSource, postings: JobPosting[], shouldThrow = false): JobSourceAdapter {
  return {
    source,
    collect: async () => {
      if (shouldThrow) throw new Error('network down');
      return { postings, invalid: 0 };
    },
  };
}

async function harness(jobAdapters: JobSourceAdapter[]): Promise<{
  storage: StorageContext;
  deps: CliDeps;
  out: () => string;
  err: () => string;
  clear: () => void;
}> {
  let out = '';
  let err = '';
  const storage = await createStorage({ sqlitePath: ':memory:' });
  const deps: CliDeps = {
    storage,
    jobAdapters,
    now: () => FETCHED,
    stdout: { write: (c: string) => void (out += c) },
    logger: {
      log: () => undefined,
      info: () => undefined,
      warn: (m: string) => void (err += `${m}\n`),
      error: (m: string) => void (err += `${m}\n`),
    },
  };
  return {
    storage,
    deps,
    out: () => out,
    err: () => err,
    clear: () => {
      out = '';
      err = '';
    },
  };
}

describe('cli jobs sync', () => {
  it('ingests postings from adapters and is idempotent on second run', async () => {
    const h = await harness([fakeAdapter('remoteok', [posting('remoteok', 1, 'Rust Engineer')])]);
    const first = await run(['jobs', 'sync'], h.deps);
    expect(first).toBe(0);
    expect(h.out()).toContain('remoteok');
    // data row: source, fetched, inserted, updated, unchanged, invalid
    expect(h.out()).toContain('remoteok\t1\t1\t0\t0\t0');

    h.clear();
    const second = await run(['jobs', 'sync'], h.deps);
    expect(second).toBe(0);
    expect(h.out()).toContain('remoteok\t1\t0\t0\t1\t0');
    expect(await h.storage.jobPostings.search({})).toHaveLength(1);
  });

  it('dry-run does not write', async () => {
    const h = await harness([fakeAdapter('remotive', [posting('remotive', 1, 'Go Engineer')])]);
    const code = await run(['jobs', 'sync', '--dry-run'], h.deps);
    expect(code).toBe(0);
    expect(h.out()).toContain('dry-run');
    expect(await h.storage.jobPostings.search({})).toHaveLength(0);
  });

  it('returns 1 when every source fails', async () => {
    const h = await harness([fakeAdapter('remoteok', [], true)]);
    const code = await run(['jobs', 'sync'], h.deps);
    expect(code).toBe(1);
  });

  it('rejects unknown source with exit 2', async () => {
    const h = await harness([]);
    const code = await run(['jobs', 'sync', '--source', 'linkedin'], h.deps);
    expect(code).toBe(2);
    expect(h.err()).toContain('unknown source');
  });
});

describe('cli jobs search / stats', () => {
  it('searches ingested postings and filters remote', async () => {
    const h = await harness([
      fakeAdapter('lever', [posting('lever', 1, 'Rust Engineer'), posting('lever', 2, 'Frontend Engineer')]),
    ]);
    await run(['jobs', 'sync'], h.deps);

    const all = await run(['jobs', 'search', '--json'], h.deps);
    expect(all).toBe(0);
    expect(h.out()).toContain('Rust Engineer');

    h.clear();
    const remote = await run(['jobs', 'search', '--remote', '--keyword', 'rust'], h.deps);
    expect(remote).toBe(0);
    expect(h.out()).toContain('Rust Engineer');
    expect(h.out()).not.toContain('Frontend Engineer');
  });

  it('prints per-source stats', async () => {
    const h = await harness([fakeAdapter('remoteok', [posting('remoteok', 1, 'X')])]);
    await run(['jobs', 'sync'], h.deps);
    const code = await run(['jobs', 'stats'], h.deps);
    expect(code).toBe(0);
    expect(h.out()).toContain('remoteok');
    expect(h.out()).toContain('active=1');
  });

  it('missing subcommand exits 2', async () => {
    const h = await harness([]);
    const code = await run(['jobs'], h.deps);
    expect(code).toBe(2);
    expect(h.err()).toContain('Usage');
  });
});
