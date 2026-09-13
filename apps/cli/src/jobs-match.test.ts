import { describe, expect, it } from 'vitest';
import type { JobPosting, JobSource } from '@jobagent/shared';
import { createStorage, type NewJobPosting, type StorageContext } from '@jobagent/storage';
import { run, type CliDeps } from './index.js';

const NOW = '2026-09-13T00:00:00.000Z';
let seq = 0;

function posting(overrides: Partial<JobPosting> & { title: string }): NewJobPosting {
  seq += 1;
  const base: JobPosting = {
    jobId: `j${seq}`,
    source: 'remoteok' as JobSource,
    sourceUrl: `https://x.test/${seq}`,
    title: '',
    company: 'Acme',
    remote: false,
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    tags: [],
    description: null,
    postedAt: NOW,
    fetchedAt: NOW,
  };
  return { ...base, ...overrides, normalizedKey: `nk${seq}` };
}

async function harness(rows: NewJobPosting[]): Promise<{
  storage: StorageContext;
  deps: CliDeps;
  out: () => string;
  err: () => string;
}> {
  let out = '';
  let err = '';
  const storage = await createStorage({ sqlitePath: ':memory:' });
  if (rows.length) await storage.jobPostings.upsertBatch(rows, NOW);
  const deps: CliDeps = {
    storage,
    now: () => NOW,
    stdout: { write: (c: string) => void (out += c) },
    logger: {
      log: () => undefined,
      info: () => undefined,
      warn: (m: string) => void (err += `${m}\n`),
      error: (m: string) => void (err += `${m}\n`),
    },
  };
  return { storage, deps, out: () => out, err: () => err };
}

describe('jobs match', () => {
  it('ranks title/tag hits above description-only hits', async () => {
    const h = await harness([
      posting({ title: 'Backend Engineer', description: 'python in the stack' }),
      posting({ title: 'Senior Python Engineer', tags: ['python'] }),
    ]);
    const code = await run(['jobs', 'match', '--skills', 'python'], h.deps);
    expect(code).toBe(0);
    const lines = h.out().trim().split('\n');
    expect(lines[0]).toContain('Senior Python Engineer');
    // first line carries the higher score
    const topScore = Number(lines[0]!.split('\t')[0]);
    const secondScore = Number(lines[1]!.split('\t')[0]);
    expect(topScore).toBeGreaterThan(secondScore);
  });

  it('requires --skills (exit 2)', async () => {
    const h = await harness([posting({ title: 'Python Engineer' })]);
    const code = await run(['jobs', 'match'], h.deps);
    expect(code).toBe(2);
    expect(h.err()).toContain('--skills');
  });

  it('applies --remote and emits JSON with --json', async () => {
    const h = await harness([
      posting({ title: 'Python Engineer', remote: true }),
      posting({ title: 'Python Engineer', remote: false }),
    ]);
    const code = await run(['jobs', 'match', '--skills', 'python', '--remote', '--json'], h.deps);
    expect(code).toBe(0);
    const parsed = JSON.parse(h.out()) as Array<{ posting: { remote: boolean } }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.posting.remote).toBe(true);
  });

  it('reports no matches gracefully', async () => {
    const h = await harness([posting({ title: 'Sales Manager' })]);
    const code = await run(['jobs', 'match', '--skills', 'python'], h.deps);
    expect(code).toBe(0);
    expect(h.out()).toContain('no postings match');
  });
});
