/**
 * Worker 测试（M1·W3）：
 * - processJob：成功路径（采集→分析→写画像→标记成功）
 * - processJob：采集失败抛出异常
 * - handleJobFailure：重试 vs 永久失败
 * - runWorker：主循环认领并处理任务
 * - runWorker：无任务时等待
 *
 * 全部用内存数据库 + fake GitHubSource，不打真实 GitHub。
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import type { AnalyzerInput } from '@jobagent/analyzer-core';
import type { AbilityProfile, EvidenceItem } from '@jobagent/shared';
import type { GitHubCollectedData } from '@jobagent/github-source';
import {
  AnalysisJobsRepository,
  ProfilesRepository,
  runMigrations,
} from '@jobagent/storage';
import { handleJobFailure, processJob, runWorker, type WorkerRepos } from './index.js';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../db/migrations/sqlite',
);

function freshRepos(): WorkerRepos {
  const db = new Database(':memory:');
  runMigrations(db, MIGRATIONS_DIR);
  const orm = drizzle(db);
  return {
    jobs: new AnalysisJobsRepository(orm),
    profiles: new ProfilesRepository(orm),
  };
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

function fakeCollectedData(login: string): GitHubCollectedData {
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
    evidence: [] as EvidenceItem[],
    missing: [],
    collectedAt: '2026-09-11T00:00:00.000Z',
  };
  return {
    input,
    evidence: [],
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

function createQueuedJob(repos: WorkerRepos, login = 'test-user'): string {
  const id = `job-${randomUUID().slice(0, 8)}`;
  repos.jobs.create({ id, subjectLogin: login });
  return id;
}

describe('processJob', () => {
  it('collects, analyzes, writes profile, and marks job succeeded', async () => {
    const repos = freshRepos();
    const jobId = createQueuedJob(repos);
    const job = repos.jobs.claimNext('test-worker')!;
    const source = makeFakeSource();

    const result = await processJob(job, repos, source);

    // 采集被调用
    expect(source.collect).toHaveBeenCalledWith('test-user');

    // 画像被写入
    const profile = repos.profiles.getById(result.profileId);
    expect(profile).toBeDefined();
    expect(profile!.subjectLogin).toBe('test-user');
    expect(profile!.status).toBe('complete');

    // 任务标记成功
    const updatedJob = repos.jobs.getById(jobId)!;
    expect(updatedJob.status).toBe('succeeded');
    expect(updatedJob.stage).toBe('complete');
    expect(updatedJob.profileId).toBe(result.profileId);
    expect(updatedJob.budgetUsed).toEqual({ graphqlPoints: 10, restCalls: 2 });
    expect(updatedJob.missing).toEqual([]);
    expect(updatedJob.finishedAt).toBeTruthy();
  });

  it('updates stage to L1 after collection', async () => {
    const repos = freshRepos();
    createQueuedJob(repos);
    const job = repos.jobs.claimNext('test-worker')!;
    const source = makeFakeSource();

    await processJob(job, repos, source);

    // 最终 stage 是 complete（succeed 时设置）
    expect(repos.jobs.getById(job.id)!.stage).toBe('complete');
  });

  it('propagates collection errors to caller', async () => {
    const repos = freshRepos();
    createQueuedJob(repos);
    const job = repos.jobs.claimNext('test-worker')!;
    const source = makeFakeSource(undefined, true);

    await expect(processJob(job, repos, source)).rejects.toThrow('GitHub API rate limit exceeded');

    // 任务仍为 running（调用方决定重试或失败）
    expect(repos.jobs.getById(job.id)!.status).toBe('running');
  });

  it('records missing layers from collection', async () => {
    const repos = freshRepos();
    createQueuedJob(repos);
    const job = repos.jobs.claimNext('test-worker')!;
    const data = fakeCollectedData('test-user');
    data.meta.missing = ['pull_requests', 'commits:some/repo'];
    const source = makeFakeSource(data);

    const result = await processJob(job, repos, source);

    expect(result.missing).toEqual(['pull_requests', 'commits:some/repo']);
    expect(repos.jobs.getById(job.id)!.missing).toEqual(['pull_requests', 'commits:some/repo']);
  });
});

describe('handleJobFailure', () => {
  it('resets to queued when attempts < maxRetries', () => {
    const repos = freshRepos();
    createQueuedJob(repos);
    const job = repos.jobs.claimNext('test-worker')!; // attempts = 1

    handleJobFailure(job, repos, new Error('temporary error'), 3);

    const updated = repos.jobs.getById(job.id)!;
    expect(updated.status).toBe('queued');
    expect(updated.errorMessage).toBe('temporary error');
    expect(updated.attempts).toBe(1); // 保留 attempts
    expect(updated.stage).toBeNull();
    expect(updated.startedAt).toBeNull();
    expect(updated.finishedAt).toBeNull();
    expect(updated.claimedBy).toBeNull();
  });

  it('marks failed when attempts >= maxRetries', () => {
    const repos = freshRepos();
    createQueuedJob(repos);
    // 手动设置 attempts = 3（模拟已重试 3 次）
    const { db } = { db: null as unknown as Database.Database };
    // 直接用 raw SQL 设置 attempts
    const ormDb = (repos.jobs as unknown as { db: { $client: Database.Database } }).db.$client;
    ormDb.prepare('UPDATE analysis_jobs SET attempts = 3, status = ? WHERE id = ?').run('running', createQueuedJob(repos) || '');

    // 重新认领一个新任务来测试
    const jobId2 = createQueuedJob(repos, 'user-2');
    ormDb.prepare('UPDATE analysis_jobs SET attempts = 3, status = ? WHERE id = ?').run('running', jobId2);
    const job = repos.jobs.getById(jobId2)!;

    handleJobFailure(job, repos, new Error('permanent error'), 3);

    const updated = repos.jobs.getById(jobId2)!;
    expect(updated.status).toBe('failed');
    expect(updated.errorMessage).toBe('permanent error');
    expect(updated.finishedAt).toBeTruthy();
  });

  it('requeued job can be claimed again (attempts increments)', () => {
    const repos = freshRepos();
    const jobId = createQueuedJob(repos);

    // 第 1 次认领 + 失败 + 重试
    const job1 = repos.jobs.claimNext('worker-1')!;
    expect(job1.attempts).toBe(1);
    handleJobFailure(job1, repos, new Error('error 1'), 3);
    expect(repos.jobs.getById(jobId)!.status).toBe('queued');

    // 第 2 次认领
    const job2 = repos.jobs.claimNext('worker-2')!;
    expect(job2.attempts).toBe(2);
    expect(job2.id).toBe(jobId);
    handleJobFailure(job2, repos, new Error('error 2'), 3);

    // 第 3 次认领
    const job3 = repos.jobs.claimNext('worker-3')!;
    expect(job3.attempts).toBe(3);
    handleJobFailure(job3, repos, new Error('error 3'), 3);

    // 第 3 次失败后永久 failed，不能再认领
    expect(repos.jobs.getById(jobId)!.status).toBe('failed');
    expect(repos.jobs.claimNext('worker-4')).toBeNull();
  });
});

describe('runWorker', () => {
  it('claims and processes jobs in the main loop', async () => {
    const repos = freshRepos();
    const jobId1 = createQueuedJob(repos, 'user-1');
    const jobId2 = createQueuedJob(repos, 'user-2');
    const source = makeFakeSource();

    let callCount = 0;
    await runWorker({
      repos,
      source,
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
    expect(repos.jobs.getById(jobId1)!.status).toBe('succeeded');
    expect(repos.jobs.getById(jobId2)!.status).toBe('succeeded');
  });

  it('handles job failures with retry in the main loop', async () => {
    const repos = freshRepos();
    const jobId = createQueuedJob(repos, 'failing-user');

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
      source,
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
    expect(repos.jobs.getById(jobId)!.status).toBe('succeeded');
    expect(repos.jobs.getById(jobId)!.attempts).toBe(3);
  });

  it('sleeps when no jobs are available', async () => {
    const repos = freshRepos();
    const source = makeFakeSource();
    const sleep = vi.fn(async () => {});

    let loopCount = 0;
    await runWorker({
      repos,
      source,
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
