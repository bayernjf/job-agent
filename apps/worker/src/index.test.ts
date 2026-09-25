/**
 * Worker 测试（M1·W3）：
 * - processJob：成功路径（采集→分析→写画像→标记成功）
 * - processJob：采集失败抛出异常
 * - handleJobFailure：重试 vs 永久失败
 * - runWorker：主循环认领并处理任务
 * - runWorker：无任务时等待
 *
 * 全部用内存数据库（createStorage :memory:）+ fake GitHubSource，不打真实 GitHub。
 */

import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AnalyzerInput } from '@jobagent/analyzer-core';
import type { AbilityProfile, EvidenceItem } from '@jobagent/shared';
import type { GitHubCollectedData } from '@jobagent/github-source';
import type { GiteeCollectedData } from '@jobagent/gitee-source';
import { createStorage, type StorageContext } from '@jobagent/storage';
import {
  claimAndProcessOne,
  handleJobFailure,
  processJob,
  runWorker,
  type WorkerRepos,
} from './index.js';

async function freshRepos(): Promise<StorageContext> {
  return createStorage({ sqlitePath: ':memory:' });
}

function sampleProfile(overrides: Partial<AbilityProfile> = {}): AbilityProfile {
  return {
    profileId: randomUUID(),
    analyzerVersion: 'schema-0.1-engine-0.1.0',
    generatedAt: '2026-09-11T00:00:00.000Z',
    dataWindow: { since: '2025-09-11T00:00:00.000Z', until: '2026-09-11T00:00:00.000Z' },
    analysisLayers: ['L0', 'L1'],
    subject: {
      platform: 'github',
      login: 'test-user',
      profileUrl: 'https://github.com/test-user',
      claimed: false,
    },
    summary: { headline: 'Test developer' },
    skillTags: [{ name: 'TypeScript', kind: 'language', depth: 'proficient', confidence: 0.8, evidenceRefs: [] }],
    activity: { longevityMonths: 12 },
    collaboration: { evidenceRefs: [] },
    authenticity: {
      status: 'likely_authentic',
      confidence: 0.75,
      signals: [],
    },
    interviewQuestions: [],
    caveats: [],
    ...overrides,
  };
}

function sampleEvidence(login: string): EvidenceItem {
  return {
    evidenceId: `repo:${login}/sample-repo`,
    sourcePlatform: 'github',
    sourceType: 'repo',
    url: `https://github.com/${login}/sample-repo`,
    occurredAt: '2026-01-01T00:00:00.000Z',
    layer: 'L0',
    claim: 'Public repository exists',
    rawRef: `${login}/sample-repo`,
  };
}

function fakeCollectedData(login: string): GitHubCollectedData {
  const evidence = [sampleEvidence(login)];
  const input: AnalyzerInput = {
    subject: {
      login,
      displayName: 'Test User',
      avatarUrl: null,
      profileUrl: `https://github.com/${login}`,
      bio: null,
      company: null,
      location: null,
      email: null,
      createdAt: '2020-01-01T00:00:00.000Z',
      followers: 10,
      following: 3,
      publicRepos: 5,
    },
    dataWindow: { since: '2025-09-11T00:00:00.000Z', until: '2026-09-11T00:00:00.000Z' },
    repos: [],
    commits: [],
    pullRequests: [],
    issues: [],
    contributions: {
      totalCommitContributions: 100,
      totalPullRequestContributions: 5,
      totalIssueContributions: 3,
      totalRepositoryContributions: 5,
      contributionMonths: [],
    },
    evidence: evidence as EvidenceItem[],
    missing: [],
    collectedAt: '2026-09-11T00:00:00.000Z',
  };
  return {
    input,
    evidence,
    meta: {
      budgetUsed: { graphqlPoints: 10, restCalls: 2 },
      missing: [],
    },
  };
}

function makeFakeSource(data?: GitHubCollectedData, shouldFail = false) {
  return {
    collect: vi.fn(async (login: string): Promise<GitHubCollectedData> => {
      if (shouldFail) throw new Error('GitHub API rate limit exceeded');
      return data ?? fakeCollectedData(login);
    }),
  };
}

/** 把单个 fake source 包装为 {github, gitee} map（两平台共用同一 fake） */
function asSources(source: ReturnType<typeof makeFakeSource>) {
  return { github: source, gitee: source };
}

/** 构造 Gitee 形状采集结果（REST-only 预算 {restCalls}、subject 指向 gitee.com），复用最小 input 夹具 */
function fakeGiteeData(login: string, missing: string[] = []): GiteeCollectedData {
  const base = fakeCollectedData(login);
  base.input.subject.profileUrl = `https://gitee.com/${login}`;
  const giteeEvidence: EvidenceItem[] = [
    {
      ...sampleEvidence(login),
      sourcePlatform: 'gitee',
      url: `https://gitee.com/${login}/sample-repo`,
    },
  ];
  base.input.evidence = giteeEvidence;
  return {
    input: base.input,
    evidence: giteeEvidence,
    meta: { budgetUsed: { restCalls: 3 }, missing },
  } as unknown as GiteeCollectedData;
}

function makeFakeGiteeSource(data: GiteeCollectedData, error?: { code: string; message: string }) {
  return {
    collect: vi.fn(async (): Promise<GiteeCollectedData> => {
      if (error) throw Object.assign(new Error(error.message), { code: error.code });
      return data;
    }),
  };
}

async function createQueuedJob(repos: WorkerRepos, login = 'test-user'): Promise<string> {
  const id = `job-${randomUUID().slice(0, 8)}`;
  await repos.jobs.create({ id, subjectLogin: login });
  return id;
}

describe('processJob', () => {
  it('collects, analyzes, writes profile, and marks job succeeded', async () => {
    const repos = await freshRepos();
    const jobId = await createQueuedJob(repos);
    const job = (await repos.jobs.claimNext('test-worker'))!;
    const source = makeFakeSource();

    const result = await processJob(job, repos, asSources(source));

    // 采集被调用
    expect(source.collect).toHaveBeenCalledWith('test-user');

    // 画像被写入
    const profile = await repos.profiles.getById(result.profileId);
    expect(profile).toBeDefined();
    expect(profile!.subjectLogin).toBe('test-user');
    expect(profile!.status).toBe('complete');

    // 证据行非空落库（报告页证据链接与可回溯性的前提）
    const storedEvidence = await repos.evidence.listByProfile(result.profileId);
    expect(storedEvidence.length).toBeGreaterThan(0);
    expect(storedEvidence[0]!.url).toBe('https://github.com/test-user/sample-repo');

    // 任务标记成功
    const updatedJob = (await repos.jobs.getById(jobId))!;
    expect(updatedJob.status).toBe('succeeded');
    expect(updatedJob.stage).toBe('complete');
    expect(updatedJob.profileId).toBe(result.profileId);
    expect(updatedJob.budgetUsed).toEqual({ graphqlPoints: 10, restCalls: 2 });
    expect(updatedJob.missing).toEqual([]);
    expect(updatedJob.finishedAt).toBeTruthy();
  });

  it('updates stage to L1 after collection', async () => {
    const repos = await freshRepos();
    await createQueuedJob(repos);
    const job = (await repos.jobs.claimNext('test-worker'))!;
    const source = makeFakeSource();

    await processJob(job, repos, asSources(source));

    // 最终 stage 是 complete（succeed 时设置）
    expect((await repos.jobs.getById(job.id))!.stage).toBe('complete');
  });

  it('propagates collection errors to caller', async () => {
    const repos = await freshRepos();
    await createQueuedJob(repos);
    const job = (await repos.jobs.claimNext('test-worker'))!;
    const source = makeFakeSource(undefined, true);

    await expect(processJob(job, repos, asSources(source))).rejects.toThrow('GitHub API rate limit exceeded');

    // 任务仍为 running（调用方决定重试或失败）
    expect((await repos.jobs.getById(job.id))!.status).toBe('running');
  });

  it('records missing layers from collection', async () => {
    const repos = await freshRepos();
    await createQueuedJob(repos);
    const job = (await repos.jobs.claimNext('test-worker'))!;
    const data = fakeCollectedData('test-user');
    data.meta.missing = ['pull_requests', 'commits:some/repo'];
    const source = makeFakeSource(data);

    const result = await processJob(job, repos, asSources(source));

    expect(result.missing).toEqual(['pull_requests', 'commits:some/repo']);
    expect((await repos.jobs.getById(job.id))!.missing).toEqual(['pull_requests', 'commits:some/repo']);
  });

  /** T25 分阶段 fake 源：collectStagedL0/collectStagedL1 双方法（worker 新路径专用） */
  function makeStagedFakeSource(opts?: { l1Missing?: string[]; l1Throws?: boolean }) {
    const l0Input = fakeCollectedData('test-user').input;
    const l1Input = fakeCollectedData('test-user').input;
    return {
      // collect 仅用于满足 SourceMap 类型（worker 探测到 staged 方法后走分阶段路径，不会调 collect）
      collect: vi.fn(async (): Promise<GitHubCollectedData> => fakeCollectedData('test-user')),
      collectStagedL0: vi.fn(async (login: string) => ({
        handle: { login },
        l0Input,
        l0Evidence: l0Input.evidence as EvidenceItem[],
        budgetUsed: { graphqlPoints: 5, restCalls: 1 },
      })),
      collectStagedL1: vi.fn(async (_login: string, _handle: unknown) => {
        if (opts?.l1Throws) throw new Error('L1 exploded');
        return {
          fullInput: l1Input,
          fullEvidence: l1Input.evidence as EvidenceItem[],
          missing: opts?.l1Missing ?? [],
          budgetUsed: { graphqlPoints: 10, restCalls: 2 },
        };
      }),
    };
  }

  it('T25: staged source writes partial:L0 early, then upgrades to complete on the same profile', async () => {
    const repos = await freshRepos();
    const jobId = await createQueuedJob(repos);
    const job = (await repos.jobs.claimNext('test-worker'))!;
    const source = makeStagedFakeSource();

    const result = await processJob(job, repos, asSources(source));

    // 两阶段都被调用，handle 原样回传
    expect(source.collectStagedL0).toHaveBeenCalledWith('test-user');
    expect(source.collectStagedL1).toHaveBeenCalledWith('test-user', { login: 'test-user' });

    // 最终画像 complete、双层、证据落库（替换后的 L1 全量）
    const profile = await repos.profiles.getById(result.profileId);
    expect(profile).toBeDefined();
    expect(profile!.status).toBe('complete');
    expect(profile!.analysisLayers).toEqual(['L0', 'L1']);
    const storedEvidence = await repos.evidence.listByProfile(result.profileId);
    expect(storedEvidence.length).toBeGreaterThan(0);

    // 任务 succeeded 且 missing 为空
    const updatedJob = (await repos.jobs.getById(jobId))!;
    expect(updatedJob.status).toBe('succeeded');
    expect(updatedJob.profileId).toBe(result.profileId);
    expect(updatedJob.missing).toEqual([]);
    expect(updatedJob.budgetUsed).toEqual({ graphqlPoints: 10, restCalls: 2 });
  });

  it('T25: staged source with L1 missing keeps profile partial and records missing on the job', async () => {
    const repos = await freshRepos();
    const jobId = await createQueuedJob(repos);
    const job = (await repos.jobs.claimNext('test-worker'))!;
    const source = makeStagedFakeSource({ l1Missing: ['l1_failed'] });

    const result = await processJob(job, repos, asSources(source));

    expect(result.missing).toEqual(['l1_failed']);
    const profile = await repos.profiles.getById(result.profileId);
    expect(profile!.status).toBe('partial');
    expect((await repos.jobs.getById(jobId))!.missing).toEqual(['l1_failed']);
  });

  it('T25: unexpected L1 throw keeps the partial:L0 profile and still succeeds the job', async () => {
    const repos = await freshRepos();
    const jobId = await createQueuedJob(repos);
    const job = (await repos.jobs.claimNext('test-worker'))!;
    const source = makeStagedFakeSource({ l1Throws: true });

    const result = await processJob(job, repos, asSources(source));

    expect(result.missing).toEqual(['l1_failed']);
    const profile = await repos.profiles.getById(result.profileId);
    expect(profile!.status).toBe('partial');
    expect(profile!.analysisLayers).toEqual(['L0']);
    expect((await repos.jobs.getById(jobId))!.status).toBe('succeeded');
  });

  it('routes to gitee source and passes platform when job.subjectPlatform=gitee', async () => {
    const repos = await freshRepos();
    const jobId = `job-${randomUUID().slice(0, 8)}`;
    await repos.jobs.create({ id: jobId, subjectPlatform: 'gitee', subjectLogin: 'gitee-user' });
    const job = (await repos.jobs.claimNext('test-worker'))!;

    const githubSource = makeFakeSource();
    const giteeSource = makeFakeSource();
    const sources = { github: githubSource, gitee: giteeSource };

    const result = await processJob(job, repos, sources);

    // gitee source 被调用，github source 未被调用
    expect(giteeSource.collect).toHaveBeenCalledWith('gitee-user');
    expect(githubSource.collect).not.toHaveBeenCalled();

    // 画像 platform 为 gitee
    expect(result.profile.subject.platform).toBe('gitee');
    expect(result.profile.subject.login).toBe('gitee-user');
  });

  it('fuses GitHub+Gitee for platform=all and persists under the all lookup key', async () => {
    const repos = await freshRepos();
    const jobId = `job-${randomUUID().slice(0, 8)}`;
    await repos.jobs.create({ id: jobId, subjectPlatform: 'all', subjectLogin: 'dual-user' });
    const job = (await repos.jobs.claimNext('test-worker'))!;

    const ghSource = makeFakeSource(fakeCollectedData('dual-user')); // budget {graphqlPoints:10, restCalls:2}
    const geSource = makeFakeGiteeSource(fakeGiteeData('dual-user', ['events'])); // budget {restCalls:3}

    const result = await processJob(job, repos, { github: ghSource, gitee: geSource });

    expect(ghSource.collect).toHaveBeenCalledWith('dual-user');
    expect(geSource.collect).toHaveBeenCalledWith('dual-user');

    // 两源都成功：检索键列存 all，但 snapshot 主源视角仍是 github
    const stored = await repos.profiles.getById(result.profileId);
    expect(stored!.subjectPlatform).toBe('all');
    expect(result.profile.subject.platform).toBe('github');
    expect(result.secondaryAvailable).toBe(true);
    expect(result.fusion).toBeDefined();
    // 融合报告同时挂进画像快照并持久化（报告页可读取），而非只停留在日志/返回值
    expect(result.profile.fusion).toBeDefined();
    expect(stored!.snapshot!.fusion).toEqual(result.fusion);

    // 融合后的证据同样落库（同 id 跨源去重，保留主源条目）
    const fusedEvidence = await repos.evidence.listByProfile(result.profileId);
    expect(fusedEvidence.length).toBeGreaterThan(0);
    expect(fusedEvidence.some((e) => e.sourcePlatform === 'github')).toBe(true);

    const done = (await repos.jobs.getById(jobId))!;
    expect(done.status).toBe('succeeded');
    // 预算合并：graphqlPoints 仅 GitHub；restCalls 两源相加 2+3=5
    expect(done.budgetUsed).toEqual({ graphqlPoints: 10, restCalls: 5 });
    // 辅源缺失项加 gitee: 前缀
    expect(done.missing).toEqual(['gitee:events']);
  });

  it('falls back to a GitHub-only profile when Gitee has no such account (not_found)', async () => {
    const repos = await freshRepos();
    const jobId = `job-${randomUUID().slice(0, 8)}`;
    await repos.jobs.create({ id: jobId, subjectPlatform: 'all', subjectLogin: 'gh-only' });
    const job = (await repos.jobs.claimNext('test-worker'))!;

    const ghSource = makeFakeSource(fakeCollectedData('gh-only'));
    const geSource = makeFakeGiteeSource(fakeGiteeData('gh-only'), {
      code: 'not_found',
      message: 'Gitee resource not found: /users/gh-only',
    });

    const result = await processJob(job, repos, { github: ghSource, gitee: geSource });

    expect(ghSource.collect).toHaveBeenCalledWith('gh-only');
    // 不抛错、作业成功；产物按 github 持久化，不冒充融合
    const stored = await repos.profiles.getById(result.profileId);
    expect(stored!.subjectPlatform).toBe('github');
    expect(result.secondaryAvailable).toBe(false);
    expect(result.fusion).toBeUndefined();
    // Gitee 无账号降级为纯 GitHub 画像，快照里也不得残留融合报告
    expect(stored!.snapshot!.fusion).toBeUndefined();

    const done = (await repos.jobs.getById(jobId))!;
    expect(done.status).toBe('succeeded');
    expect(done.budgetUsed).toEqual({ graphqlPoints: 10, restCalls: 2 });
    expect(done.missing).toContain('gitee:account_not_found');
  });

  it('propagates a transient Gitee api_error so the platform=all job is retried', async () => {
    const repos = await freshRepos();
    const jobId = `job-${randomUUID().slice(0, 8)}`;
    await repos.jobs.create({ id: jobId, subjectPlatform: 'all', subjectLogin: 'dual-user' });
    const job = (await repos.jobs.claimNext('test-worker'))!;

    const ghSource = makeFakeSource(fakeCollectedData('dual-user'));
    const geSource = makeFakeGiteeSource(fakeGiteeData('dual-user'), {
      code: 'api_error',
      message: 'Gitee rate limited',
    });

    await expect(
      processJob(job, repos, { github: ghSource, gitee: geSource }),
    ).rejects.toThrow('Gitee rate limited');

    // 主源已采、辅源瞬时错误：作业保持 running，交由 handleJobFailure 重试（不静默降级）
    expect((await repos.jobs.getById(jobId))!.status).toBe('running');
  });
});

describe('degradation under collection faults', () => {
  it('treats a budget-exhausted timeout as transient and requeues the job', async () => {
    const repos = await freshRepos();
    const jobId = `job-${randomUUID().slice(0, 8)}`;
    await repos.jobs.create({ id: jobId, subjectLogin: 'slow-user' });
    const job = (await repos.jobs.claimNext('test-worker'))!;

    const timeoutSource = {
      collect: vi.fn(async () => {
        throw Object.assign(new Error('Collection timed out after L0'), {
          code: 'budget_exhausted',
        });
      }),
    };

    await expect(
      processJob(job, repos, asSources(timeoutSource)),
    ).rejects.toThrow('Collection timed out after L0');

    // 瞬时错误：handleJobFailure 退回队列等待重试，不永久失败
    await handleJobFailure(job, repos, new Error('Collection timed out after L0') as Error & { code: string }, 3);
    const updated = (await repos.jobs.getById(jobId))!;
    expect(updated.status).toBe('queued');
  });

  it('marks missing sections on the profile caveat when collection is partial', async () => {
    const repos = await freshRepos();
    const jobId = `job-${randomUUID().slice(0, 8)}`;
    await repos.jobs.create({ id: jobId, subjectLogin: 'partial-user' });
    const job = (await repos.jobs.claimNext('test-worker'))!;

    const data = fakeCollectedData('partial-user');
    data.input.commits = [];
    data.input.pullRequests = [];
    data.input.issues = [];
    data.input.contributions.totalCommitContributions = 0;
    data.input.missing = ['pull_requests', 'issues', 'events'];
    data.meta.missing = ['pull_requests', 'issues', 'events'];
    const source = makeFakeSource(data);

    const result = await processJob(job, repos, asSources(source));

    // 缺失项透传到画像 caveat，报告无法假装完整
    expect(result.profile.caveats.some((c) => c.includes('Partial data missing'))).toBe(true);
    expect(result.profile.caveats.join('')).toContain('pull_requests');
    // 无行为证据：真实性降级为 insufficient_data，而非 likely_authentic
    expect(result.profile.authenticity.status).toBe('insufficient_data');
    expect((await repos.jobs.getById(jobId))!.missing).toEqual([
      'pull_requests',
      'issues',
      'events',
    ]);
  });

  it('does not output a likely-authentic profile from L0-only half evidence', async () => {
    const repos = await freshRepos();
    const jobId = `job-${randomUUID().slice(0, 8)}`;
    await repos.jobs.create({ id: jobId, subjectLogin: 'l0-only' });
    const job = (await repos.jobs.claimNext('test-worker'))!;

    // 仅 L0 仓库元数据：有 repo、有 evidence，但 L1 时序（commit/PR/issue）全空
    const data = fakeCollectedData('l0-only');
    data.input.commits = [];
    data.input.pullRequests = [];
    data.input.issues = [];
    data.input.contributions.totalCommitContributions = 5;
    data.input.missing = ['commits', 'pull_requests', 'issues'];
    data.meta.missing = ['commits', 'pull_requests', 'issues'];
    const source = makeFakeSource(data);

    const result = await processJob(job, repos, asSources(source));

    const stored = await repos.profiles.getById(result.profileId);
    expect(stored!.snapshot!.authenticity.status).not.toBe('likely_authentic');
    expect(result.profile.authenticity.status).toBe('insufficient_data');
    // 证据链接仍落库（可回溯），但结论本身已显式降级
    const storedEvidence = await repos.evidence.listByProfile(result.profileId);
    expect(storedEvidence.length).toBeGreaterThan(0);
  });
});

describe('handleJobFailure', () => {
  it('resets to queued when attempts < maxRetries', async () => {
    const repos = await freshRepos();
    await createQueuedJob(repos);
    const job = (await repos.jobs.claimNext('test-worker'))!; // attempts = 1

    await handleJobFailure(job, repos, new Error('temporary error'), 3);

    const updated = (await repos.jobs.getById(job.id))!;
    expect(updated.status).toBe('queued');
    expect(updated.errorMessage).toBe('temporary error');
    expect(updated.attempts).toBe(1); // 保留 attempts
    expect(updated.stage).toBeNull();
    expect(updated.startedAt).toBeNull();
    expect(updated.finishedAt).toBeNull();
    expect(updated.claimedBy).toBeNull();
  });

  it('does not retry not_found errors — fails immediately even on first attempt', async () => {
    const repos = await freshRepos();
    await createQueuedJob(repos, 'ghost-user');
    const job = (await repos.jobs.claimNext('test-worker'))!; // attempts = 1

    const err = new Error('Gitee resource not found: /users/ghost') as Error & { code: string };
    err.code = 'not_found';
    await handleJobFailure(job, repos, err, 3);

    const updated = (await repos.jobs.getById(job.id))!;
    expect(updated.status).toBe('failed');
    expect(updated.attempts).toBe(1); // not incremented beyond the first attempt
  });

  it('marks failed when attempts >= maxRetries', async () => {
    const repos = await freshRepos();
    const jobId = await createQueuedJob(repos, 'user-2');

    // 用真实认领/重排流程构造 attempts=3、status=running 的任务
    let job = (await repos.jobs.claimNext('test-worker'))!; // attempts 1
    await handleJobFailure(job, repos, new Error('e1'), 3); // -> queued
    job = (await repos.jobs.claimNext('test-worker'))!; // attempts 2
    await handleJobFailure(job, repos, new Error('e2'), 3); // -> queued
    job = (await repos.jobs.claimNext('test-worker'))!; // attempts 3, running
    expect(job.attempts).toBe(3);
    expect(job.id).toBe(jobId);

    await handleJobFailure(job, repos, new Error('permanent error'), 3);

    const updated = (await repos.jobs.getById(jobId))!;
    expect(updated.status).toBe('failed');
    expect(updated.errorMessage).toBe('permanent error');
    expect(updated.finishedAt).toBeTruthy();
  });

  it('requeued job can be claimed again (attempts increments)', async () => {
    const repos = await freshRepos();
    const jobId = await createQueuedJob(repos);

    // 第 1 次认领 + 失败 + 重试
    const job1 = (await repos.jobs.claimNext('worker-1'))!;
    expect(job1.attempts).toBe(1);
    await handleJobFailure(job1, repos, new Error('error 1'), 3);
    expect((await repos.jobs.getById(jobId))!.status).toBe('queued');

    // 第 2 次认领
    const job2 = (await repos.jobs.claimNext('worker-2'))!;
    expect(job2.attempts).toBe(2);
    expect(job2.id).toBe(jobId);
    await handleJobFailure(job2, repos, new Error('error 2'), 3);

    // 第 3 次认领
    const job3 = (await repos.jobs.claimNext('worker-3'))!;
    expect(job3.attempts).toBe(3);
    await handleJobFailure(job3, repos, new Error('error 3'), 3);

    // 第 3 次失败后永久 failed，不能再认领
    expect((await repos.jobs.getById(jobId))!.status).toBe('failed');
    expect(await repos.jobs.claimNext('worker-4')).toBeNull();
  });
});

describe('runWorker', () => {
  it('claims and processes jobs in the main loop', async () => {
    const repos = await freshRepos();
    const jobId1 = await createQueuedJob(repos, 'user-1');
    const jobId2 = await createQueuedJob(repos, 'user-2');
    const source = makeFakeSource();

    let callCount = 0;
    await runWorker({
      repos,
      sources: asSources(source),
      workerId: 'test-worker',
      pollIntervalMs: 10,
      maxRetries: 3,
      sleep: async () => {},
      shouldContinue: () => {
        callCount += 1;
        return callCount <= 3; // 运行 3 次循环（处理 2 个任务 + 1 次空轮询）
      },
    });

    expect(source.collect).toHaveBeenCalledTimes(2);
    expect((await repos.jobs.getById(jobId1))!.status).toBe('succeeded');
    expect((await repos.jobs.getById(jobId2))!.status).toBe('succeeded');
  });

  it('handles job failures with retry in the main loop', async () => {
    const repos = await freshRepos();
    const jobId = await createQueuedJob(repos, 'failing-user');

    // 前 2 次失败，第 3 次成功
    let collectCalls = 0;
    const source = {
      collect: vi.fn(async (): Promise<GitHubCollectedData> => {
        collectCalls += 1;
        if (collectCalls < 3) throw new Error(`temporary error ${collectCalls}`);
        return fakeCollectedData('failing-user');
      }),
    };

    let loopCount = 0;
    await runWorker({
      repos,
      sources: asSources(source),
      workerId: 'test-worker',
      pollIntervalMs: 10,
      maxRetries: 3,
      sleep: async () => {},
      shouldContinue: () => {
        loopCount += 1;
        return loopCount <= 5; // 足够处理 3 次尝试
      },
    });

    expect(collectCalls).toBe(3);
    expect((await repos.jobs.getById(jobId))!.status).toBe('succeeded');
    expect((await repos.jobs.getById(jobId))!.attempts).toBe(3);
  });

  it('sleeps when no jobs are available', async () => {
    const repos = await freshRepos();
    const source = makeFakeSource();
    const sleep = vi.fn(async () => {});

    let loopCount = 0;
    await runWorker({
      repos,
      sources: asSources(source),
      workerId: 'test-worker',
      pollIntervalMs: 100,
      sleep,
      shouldContinue: () => {
        loopCount += 1;
        return loopCount <= 2; // 2 次空轮询
      },
    });

    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(100);
    expect(source.collect).not.toHaveBeenCalled();
  });
});

describe('demo concurrency gate', () => {
  async function createJob(
    repos: WorkerRepos,
    id: string,
    login: string,
    requesterKind: 'public' | 'demo' = 'public',
  ): Promise<void> {
    await repos.jobs.create({
      id,
      subjectLogin: login,
      requesterKind,
      demoSessionId: requesterKind === 'demo' ? 'demo-session-1' : undefined,
    });
  }

  it('processes the first demo job within the cap', async () => {
    const repos = await freshRepos();
    await createJob(repos, 'demo-1', 'demo-one', 'demo');
    const source = makeFakeSource();

    let loops = 0;
    await runWorker({
      repos,
      sources: asSources(source),
      workerId: 'w',
      pollIntervalMs: 10,
      demoMaxConcurrent: 1,
      sleep: async () => {},
      shouldContinue: () => (loops += 1) <= 2,
    });

    expect((await repos.jobs.getById('demo-1'))!.status).toBe('succeeded');
  });

  it('defers an over-cap demo job without burning attempts and backs off', async () => {
    const repos = await freshRepos();
    await createJob(repos, 'demo-a', 'demo-a', 'demo');
    const runningA = (await repos.jobs.claimNext('w'))!; // A 已在 running
    await createJob(repos, 'demo-b', 'demo-b', 'demo');
    const source = makeFakeSource();
    const sleep = vi.fn(async () => {});

    let loops = 0;
    await runWorker({
      repos,
      sources: asSources(source),
      workerId: 'w',
      pollIntervalMs: 10,
      demoMaxConcurrent: 1,
      demoBackoffMs: 50,
      sleep,
      shouldContinue: () => (loops += 1) <= 1,
    });

    // B 被退回队列、attempts 抵消回 0、未采集、按 backoff 退避
    const b = (await repos.jobs.getById('demo-b'))!;
    expect(b.status).toBe('queued');
    expect(b.attempts).toBe(0);
    expect(b.claimedBy).toBeNull();
    expect(b.errorMessage).toBeNull();
    expect(source.collect).not.toHaveBeenCalled();
    expect(sleep).toHaveBeenCalledWith(50);

    // A 释放后，B 仍可被认领并成功（证明反复 defer 没耗尽重试预算）
    await repos.jobs.succeed(runningA.id, 'prof-a');
    let loops2 = 0;
    await runWorker({
      repos,
      sources: asSources(source),
      workerId: 'w',
      pollIntervalMs: 10,
      demoMaxConcurrent: 1,
      sleep: async () => {},
      shouldContinue: () => (loops2 += 1) <= 2,
    });
    expect((await repos.jobs.getById('demo-b'))!.status).toBe('succeeded');
  });

  it('never blocks formal (public) jobs even when demo cap is full', async () => {
    const repos = await freshRepos();
    await createJob(repos, 'demo-a', 'demo-a', 'demo');
    await repos.jobs.claimNext('w'); // 一个 demo 已在 running，占满 cap=1
    await createJob(repos, 'formal-1', 'formal-one', 'public');
    const source = makeFakeSource();

    let loops = 0;
    await runWorker({
      repos,
      sources: asSources(source),
      workerId: 'w',
      pollIntervalMs: 10,
      demoMaxConcurrent: 1,
      sleep: async () => {},
      shouldContinue: () => (loops += 1) <= 2,
    });

    expect((await repos.jobs.getById('formal-1'))!.status).toBe('succeeded');
    expect(source.collect).toHaveBeenCalledTimes(1);
  });

  it('claims a later formal job before an earlier queued demo job', async () => {
    const repos = await freshRepos();
    await createJob(repos, 'demo-first', 'demo-first', 'demo'); // 先入队
    await createJob(repos, 'formal-later', 'formal-later', 'public'); // 后入队
    const source = makeFakeSource();

    let loops = 0;
    await runWorker({
      repos,
      sources: asSources(source),
      workerId: 'w',
      pollIntervalMs: 10,
      demoMaxConcurrent: 1,
      sleep: async () => {},
      shouldContinue: () => (loops += 1) <= 3,
    });

    // 正式任务先被采集，随后 demo 在 cap 内也被处理
    expect(source.collect.mock.calls[0]![0]).toBe('formal-later');
    expect((await repos.jobs.getById('formal-later'))!.status).toBe('succeeded');
    expect((await repos.jobs.getById('demo-first'))!.status).toBe('succeeded');
  });
});

describe('claimAndProcessOne (serverless cron entry)', () => {
  it('returns idle when the queue is empty (and creates no source)', async () => {
    const repos = await freshRepos();
    const source = makeFakeSource();

    const outcome = await claimAndProcessOne({
      repos,
      sources: asSources(source),
      workerId: 'cron',
    });

    expect(outcome).toEqual({ kind: 'idle' });
    expect(source.collect).not.toHaveBeenCalled();
  });

  it('returns idle on an empty queue even without GITHUB_TOKEN or injected sources', async () => {
    // 守护 lazy source 构造：serverless cron 空窗期无任务、未配 token 时也必须 idle，
    // 而不是在认领前构造 source 触发 "GITHUB_TOKEN is not set"（smoke 预演发现的顺序问题）。
    vi.stubEnv('GITHUB_TOKEN', '');
    vi.stubEnv('GITEE_TOKEN', '');
    const repos = await freshRepos();

    const outcome = await claimAndProcessOne({ repos, workerId: 'cron', reclaimStaleMs: null });

    expect(outcome).toEqual({ kind: 'idle' });
    vi.unstubAllEnvs();
  });

  it('processes exactly one queued job and reports its profileId', async () => {
    const repos = await freshRepos();
    const jobId = await createQueuedJob(repos, 'one-shot');
    await createQueuedJob(repos, 'still-queued'); // 第二个任务本轮不应被处理
    const source = makeFakeSource();

    const outcome = await claimAndProcessOne({
      repos,
      sources: asSources(source),
      workerId: 'cron',
    });

    expect(outcome.kind).toBe('processed');
    if (outcome.kind === 'processed') {
      expect(outcome.jobId).toBe(jobId);
      expect((await repos.jobs.getById(jobId))!.status).toBe('succeeded');
      expect(await repos.profiles.getById(outcome.profileId)).toBeTruthy();
    }
    expect(source.collect).toHaveBeenCalledTimes(1);
    // 第二个任务仍在队列，等待下一次 cron 触发
    const remaining = await repos.jobs.claimNext('cron-2');
    expect(remaining?.subjectLogin).toBe('still-queued');
  });

  it('defers an over-cap demo job without processing', async () => {
    const repos = await freshRepos();
    await repos.jobs.create({
      id: 'demo-running',
      subjectLogin: 'demo-run',
      requesterKind: 'demo',
      demoSessionId: 's1',
    });
    await repos.jobs.claimNext('w'); // 占满 cap=1
    await repos.jobs.create({
      id: 'demo-waiting',
      subjectLogin: 'demo-wait',
      requesterKind: 'demo',
      demoSessionId: 's1',
    });
    const source = makeFakeSource();

    const outcome = await claimAndProcessOne({
      repos,
      sources: asSources(source),
      workerId: 'cron',
      demoMaxConcurrent: 1,
    });

    expect(outcome).toEqual({ kind: 'deferred', jobId: 'demo-waiting' });
    expect((await repos.jobs.getById('demo-waiting'))!.status).toBe('queued');
    expect(source.collect).not.toHaveBeenCalled();
  });

  it('reports a non-permanent failure for a transient error (job requeued)', async () => {
    const repos = await freshRepos();
    const jobId = await createQueuedJob(repos, 'flaky');
    const source = makeFakeSource(undefined, true); // always throws transient error

    const outcome = await claimAndProcessOne({
      repos,
      sources: asSources(source),
      workerId: 'cron',
      maxRetries: 3,
    });

    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.jobId).toBe(jobId);
      expect(outcome.permanent).toBe(false);
    }
    expect((await repos.jobs.getById(jobId))!.status).toBe('queued');
  });

  it('reports a permanent failure for a not_found error', async () => {
    const repos = await freshRepos();
    const jobId = await createQueuedJob(repos, 'ghost');
    const notFoundSource = {
      collect: vi.fn(async () => {
        throw Object.assign(new Error('GitHub user not found'), { code: 'not_found' });
      }),
    };

    const outcome = await claimAndProcessOne({
      repos,
      sources: asSources(notFoundSource),
      workerId: 'cron',
      maxRetries: 3,
    });

    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') expect(outcome.permanent).toBe(true);
    expect((await repos.jobs.getById(jobId))!.status).toBe('failed');
  });
});
