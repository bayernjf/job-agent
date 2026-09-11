import { describe, expect, it } from 'vitest';
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
    expect(parsed.meta.budgetUsed.graphqlPoints).toBe(10);
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
