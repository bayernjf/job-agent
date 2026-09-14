import { describe, expect, it } from 'vitest';
import { createStorage } from '@jobagent/storage';
import type { StorageContext } from '@jobagent/storage';
import type { GitHubCollectedData } from '@jobagent/github-source';
import { run, type CliDeps, type AnalyzeResult } from './index.js';

function makeInput(login: string) {
  return {
    subject: {
      login,
      displayName: `Person ${login}`,
      avatarUrl: null,
      profileUrl: `https://github.com/${login}`,
      bio: null,
      company: null,
      location: null,
      email: null,
      createdAt: '2024-01-01T00:00:00Z',
      followers: 1,
      following: 0,
      publicRepos: 1,
    },
    dataWindow: { since: '2024-01-01T00:00:00Z', until: '2026-01-01T00:00:00Z' },
    repos: [
      {
        name: 'demo',
        ownerLogin: login,
        url: `https://github.com/${login}/demo`,
        isFork: false,
        isArchived: false,
        primaryLanguage: 'TypeScript',
        topics: [],
        description: null,
        stargazerCount: 0,
        forkCount: 0,
        pushedAt: '2025-12-01T00:00:00Z',
        createdAt: '2024-01-01T00:00:00Z',
      },
    ],
    commits: [
      {
        oid: 'aa00000000000000000000000000000000000001',
        committedAt: '2025-11-01T00:00:00Z',
        authorName: `Person ${login}`,
        authorEmail: null,
        repoName: 'demo',
        messageHeadline: 'init',
      },
    ],
    pullRequests: [],
    issues: [],
    contributions: {
      totalCommitContributions: 5,
      totalPullRequestContributions: 0,
      totalIssueContributions: 0,
      totalRepositoryContributions: 0,
      contributionMonths: [{ year: 2025, month: 11, count: 5 }],
    },
    evidence: [
      {
        evidenceId: `user:${login}`,
        sourcePlatform: 'github',
        sourceType: 'contribution',
        url: `https://github.com/${login}`,
        occurredAt: '2024-01-01T00:00:00Z',
        layer: 'L0',
        claim: `GitHub 账号 ${login}`,
        rawRef: login,
      },
      {
        evidenceId: 'repo:demo',
        sourcePlatform: 'github',
        sourceType: 'repo',
        url: `https://github.com/${login}/demo`,
        occurredAt: '2025-12-01T00:00:00Z',
        layer: 'L0',
        claim: '仓库 demo',
        rawRef: 'demo',
      },
      {
        evidenceId: 'commit:demo:aa00000000000000000000000000000000000001',
        sourcePlatform: 'github',
        sourceType: 'commit',
        url: `https://github.com/${login}/demo/commit/aa00000000000000000000000000000000000001`,
        occurredAt: '2025-11-01T00:00:00Z',
        layer: 'L1',
        claim: 'init',
        rawRef: 'demo#aa00000000000000000000000000000000000001',
      },
    ] as GitHubCollectedData['input']['evidence'],
    missing: [],
    collectedAt: '2026-09-11T00:00:00.000Z',
  };
}

function fakeCollected(login: string): GitHubCollectedData {
  return {
    input: makeInput(login),
    evidence: makeInput(login).evidence,
    meta: { budgetUsed: { graphqlPoints: 10, restCalls: 1 }, missing: [] },
  };
}

function capture(): { stdout: string; stderr: string; deps: (source: CliDeps['source']) => CliDeps } {
  let out = '';
  let err = '';
  return {
    get stdout() {
      return out;
    },
    get stderr() {
      return err;
    },
    deps: (source) => ({
      token: 'test-token',
      source,
      stdout: { write: (c) => void (out += c) },
      logger: {
        log: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: (m: string) => void (err += `${m}\n`),
      },
    }),
  };
}

describe('cli run', () => {
  it('analyze outputs a JSON profile and exits 0', async () => {
    const c = capture();
    const code = await run(
      ['analyze', 'dev-strong'],
      c.deps({ collect: async (login) => fakeCollected(login) }),
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(c.stdout) as AnalyzeResult;
    expect(parsed.profile.subject.login).toBe('dev-strong');
    expect((parsed.meta.budgetUsed as { graphqlPoints?: number }).graphqlPoints).toBe(10);
  });

  it('forwards --platform gitee to the analyzer', async () => {
    const c = capture();
    const code = await run(
      ['analyze', 'dev-strong', '--platform', 'gitee'],
      c.deps({ collect: async (login) => fakeCollected(login) }),
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(c.stdout) as AnalyzeResult;
    expect(parsed.profile.subject.platform).toBe('gitee');
    expect(parsed.profile.caveats.some((m) => m.includes('Public Gitee data only'))).toBe(true);
  });

  it('exits 2 on an unknown --platform value', async () => {
    const c = capture();
    const code = await run(
      ['analyze', 'dev-strong', '--platform', 'gitlab'],
      c.deps({ collect: async (login) => fakeCollected(login) }),
    );
    expect(code).toBe(2);
    expect(c.stderr).toContain('--platform');
  });

  it('analyze writes to --out file instead of stdout', async () => {
    const c = capture();
    const outFile = `${import.meta.dirname}/tmp-cli-test.json`;
    const code = await run(
      ['analyze', 'dev-strong', '--out', outFile],
      c.deps({ collect: async (login) => fakeCollected(login) }),
    );
    expect(code).toBe(0);
    expect(c.stdout).toBe('');
    const { readFileSync, rmSync } = await import('node:fs');
    const parsed = JSON.parse(readFileSync(outFile, 'utf8')) as AnalyzeResult;
    expect(parsed.profile.subject.login).toBe('dev-strong');
    rmSync(outFile, { force: true });
  });

  it('exits 1 with guidance when GITHUB_TOKEN is missing and no source injected', async () => {
    const c = capture();
    const code = await run(['analyze', 'dev-strong'], { ...c.deps(undefined), token: undefined });
    expect(code).toBe(1);
    expect(c.stderr).toContain('GITHUB_TOKEN');
  });

  it('batch emits one JSONL line per account and reports failures', async () => {
    const c = capture();
    const source = {
      collect: async (login: string) => {
        if (login === 'ghost') throw new Error('not found');
        return fakeCollected(login);
      },
    };
    const code = await run(['batch', 'nope-file'], { ...c.deps(source), token: 't' });
    expect(code).toBe(1); // 文件读取失败
    expect(c.stderr).toContain('cannot read batch file');
  });

  it('batch succeeds on a real temp file with ok and failed lines', async () => {
    const { writeFileSync, rmSync } = await import('node:fs');
    const file = `${import.meta.dirname}/tmp-batch.txt`;
    writeFileSync(file, 'dev-strong\n# comment\nghost\n', 'utf8');
    const c = capture();
    const source = {
      collect: async (login: string) => {
        if (login === 'ghost') throw new Error('not found');
        return fakeCollected(login);
      },
    };
    const code = await run(['batch', file], c.deps(source));
    expect(code).toBe(1); // ghost 失败
    const lines = c.stdout.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('dev-strong');
    expect(lines[1]).toContain('ghost');
    expect(lines[1]).toContain('not found');
    rmSync(file, { force: true });
  });

  it('no command exits 2 with usage', async () => {
    const c = capture();
    const code = await run([], c.deps({ collect: async (l) => fakeCollected(l) }));
    expect(code).toBe(2);
    expect(c.stderr).toContain('Usage');
  });
});

describe('cli waitlist', () => {
  async function seeded(): Promise<{ deps: CliDeps; storage: StorageContext; out: string; err: string }> {
    const c = capture();
    const storage = await createStorage({ sqlitePath: ':memory:' });
    await storage.waitlist.insert({
      id: 'w1',
      email: 'alice@example.com',
      name: 'Alice',
      githubUsername: 'alice-dev',
      source: 'landing_page',
      status: 'pending',
    });
    await storage.waitlist.insert({
      id: 'w2',
      email: 'bob@example.com',
      name: 'Bob',
      githubUsername: 'bob-dev',
      source: 'landing_page',
      status: 'pending',
    });
    await storage.waitlist.insert({
      id: 'w3',
      email: 'carol@example.com',
      name: 'Carol',
      githubUsername: 'carol-dev',
      source: 'landing_page',
      status: 'contacted',
    });
    return {
      deps: { ...c.deps({ collect: async (l) => fakeCollected(l) }), storage },
      storage,
      get out() {
        return c.stdout;
      },
      get err() {
        return c.stderr;
      },
    };
  }

  it('default shows per-status counts and total', async () => {
    const s = await seeded();
    const code = await run(['waitlist'], s.deps);
    expect(code).toBe(0);
    expect(s.out).toContain('pending    2');
    expect(s.out).toContain('contacted  1');
    expect(s.out).toContain('total      3');
  });

  it('--count is the same as the default', async () => {
    const s = await seeded();
    const code = await run(['waitlist', '--count'], s.deps);
    expect(code).toBe(0);
    expect(s.out).toContain('pending    2');
    expect(s.out).toContain('total      3');
  });

  it('--status lists matching entries as email/status/username/createdAt', async () => {
    const s = await seeded();
    const code = await run(['waitlist', '--status', 'pending'], s.deps);
    expect(code).toBe(0);
    const lines = s.out.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('alice@example.com');
    expect(lines[0]).toContain('alice-dev');
    expect(lines[1]).toContain('bob@example.com');
  });

  it('--limit caps the number of rows', async () => {
    const s = await seeded();
    const code = await run(['waitlist', '--status', 'pending', '--limit', '1'], s.deps);
    expect(code).toBe(0);
    expect(s.out.trim().split('\n')).toHaveLength(1);
  });

  it('empty status list prints a notice', async () => {
    const s = await seeded();
    const code = await run(['waitlist', '--status', 'archived'], s.deps);
    expect(code).toBe(0);
    expect(s.out).toContain('(no archived entries)');
  });

  it('rejects an unknown status with exit 2', async () => {
    const s = await seeded();
    const code = await run(['waitlist', '--status', 'spam'], s.deps);
    expect(code).toBe(2);
    expect(s.err).toContain('unknown waitlist status');
  });

  it('rejects a non-positive --limit with exit 2', async () => {
    const s = await seeded();
    const code = await run(['waitlist', '--limit', '0'], s.deps);
    expect(code).toBe(2);
    expect(s.err).toContain('--limit must be a positive integer');
  });
});
