import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './migrator.js';
import { AnalysisJobsRepository, type NewAnalysisJob } from './analysis-jobs.js';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../db/migrations/sqlite',
);

function freshRepo(): { repo: AnalysisJobsRepository; db: Database.Database } {
  const db = new Database(':memory:');
  runMigrations(db, MIGRATIONS_DIR);
  const orm = drizzle(db);
  return { repo: new AnalysisJobsRepository(orm), db };
}

function newJob(id: string, login = 'dev-strong'): NewAnalysisJob {
  return { id, subjectLogin: login };
}

describe('AnalysisJobsRepository', () => {
  it('creates a job in queued status and retrieves it by id', () => {
    const { repo } = freshRepo();
    repo.create(newJob('job_001'));
    const job = repo.getById('job_001');
    expect(job).toBeDefined();
    expect(job!.id).toBe('job_001');
    expect(job!.status).toBe('queued');
    expect(job!.subjectLogin).toBe('dev-strong');
    expect(job!.subjectPlatform).toBe('github');
    expect(job!.attempts).toBe(0);
    expect(job!.stage).toBeNull();
    expect(job!.profileId).toBeNull();
    expect(job!.createdAt).toBeTruthy();
  });

  it('returns undefined for non-existent job id', () => {
    const { repo } = freshRepo();
    expect(repo.getById('nonexistent')).toBeUndefined();
  });

  it('claims the oldest queued job atomically', () => {
    const { repo } = freshRepo();
    // 插入两个任务，第二个更老（通过 id 排序不影响，created_at 是默认值，内存库中插入顺序即时间顺序）
    repo.create(newJob('job_old'));
    repo.create(newJob('job_new'));

    const claimed = repo.claimNext('worker-1');
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe('job_old');
    expect(claimed!.status).toBe('running');
    expect(claimed!.stage).toBe('L0');
    expect(claimed!.attempts).toBe(1);
    expect(claimed!.claimedBy).toBe('worker-1');
    expect(claimed!.startedAt).toBeTruthy();

    // 再认领应该拿到第二个
    const claimed2 = repo.claimNext('worker-1');
    expect(claimed2).not.toBeNull();
    expect(claimed2!.id).toBe('job_new');
    expect(claimed2!.status).toBe('running');

    // 没有 queued 任务了
    expect(repo.claimNext('worker-1')).toBeNull();
  });

  it('does not claim jobs with attempts >= 3', () => {
    const { repo } = freshRepo();
    repo.create(newJob('job_001'));
    // 认领 3 次（每次都会 attempts+1，但认领后状态是 running，不会被再次认领）
    // 直接手动设置 attempts=3 来测试边界
    const { db } = freshRepo();
    // 用 raw SQL 设置 attempts（测试用，不违反业务层约束）
    // 实际上 claimNext 会把 queued -> running，所以要测试 attempts>=3 不被认领，
    // 需要先把任务重置为 queued 但 attempts=3。这里用直接插入的方式。
    const orm = drizzle(db);
    const repo2 = new AnalysisJobsRepository(orm);
    repo2.create(newJob('job_high_attempts'));
    // 手动更新 attempts=3（模拟重试耗尽）
    db.prepare('UPDATE analysis_jobs SET attempts = 3, status = ? WHERE id = ?').run('queued', 'job_high_attempts');
    expect(repo2.claimNext('worker-1')).toBeNull();
  });

  it('updates job stage from L0 to L1 to complete', () => {
    const { repo } = freshRepo();
    repo.create(newJob('job_001'));
    const job = repo.claimNext('worker-1')!;
    expect(job.stage).toBe('L0');

    repo.updateStage('job_001', 'L1');
    expect(repo.getById('job_001')!.stage).toBe('L1');

    repo.updateStage('job_001', 'complete');
    expect(repo.getById('job_001')!.stage).toBe('complete');
  });

  it('marks job as succeeded with profileId, budget and missing layers', () => {
    const { repo } = freshRepo();
    repo.create(newJob('job_001'));
    repo.claimNext('worker-1');

    repo.succeed('job_001', 'prof_001', { graphqlPoints: 42, restCalls: 3 }, ['pull_requests']);

    const job = repo.getById('job_001')!;
    expect(job.status).toBe('succeeded');
    expect(job.stage).toBe('complete');
    expect(job.profileId).toBe('prof_001');
    expect(job.budgetUsed).toEqual({ graphqlPoints: 42, restCalls: 3 });
    expect(job.missing).toEqual(['pull_requests']);
    expect(job.finishedAt).toBeTruthy();
  });

  it('marks job as failed with error message', () => {
    const { repo } = freshRepo();
    repo.create(newJob('job_001'));
    repo.claimNext('worker-1');

    repo.fail('job_001', 'GitHub API rate limit exceeded');

    const job = repo.getById('job_001')!;
    expect(job.status).toBe('failed');
    expect(job.errorMessage).toBe('GitHub API rate limit exceeded');
    expect(job.finishedAt).toBeTruthy();
  });

  it('lists jobs by subject in recency order', () => {
    const { repo, db } = freshRepo();
    repo.create(newJob('job_001', 'user-a'));
    repo.create(newJob('job_002', 'user-a'));
    repo.create(newJob('job_003', 'user-b'));

    // 手动设置 created_at 确保顺序（内存库中同一毫秒插入可能相同）
    db.prepare('UPDATE analysis_jobs SET created_at = ? WHERE id = ?').run('2026-09-10T00:00:00.000Z', 'job_001');
    db.prepare('UPDATE analysis_jobs SET created_at = ? WHERE id = ?').run('2026-09-10T01:00:00.000Z', 'job_002');

    const jobs = repo.listBySubject('github', 'user-a');
    expect(jobs).toHaveLength(2);
    expect(jobs[0]!.id).toBe('job_002'); // 最新的在前
    expect(jobs[1]!.id).toBe('job_001');
  });

  it('finds latest active (queued/running) job by subject for dedup', () => {
    const { repo } = freshRepo();
    repo.create(newJob('job_queued', 'user-a'));
    const active = repo.latestActiveBySubject('github', 'user-a');
    expect(active).toBeDefined();
    expect(active!.id).toBe('job_queued');
    expect(active!.status).toBe('queued');

    // 认领后变成 running，仍然是 active
    repo.claimNext('worker-1');
    expect(repo.latestActiveBySubject('github', 'user-a')!.status).toBe('running');

    // 成功后不再是 active
    repo.succeed('job_queued', 'prof_001');
    expect(repo.latestActiveBySubject('github', 'user-a')).toBeUndefined();
  });

  it('lists queued jobs in FIFO order', () => {
    const { repo } = freshRepo();
    repo.create(newJob('job_003'));
    repo.create(newJob('job_001'));
    repo.create(newJob('job_002'));

    const queued = repo.listQueued();
    expect(queued).toHaveLength(3);
    expect(queued.map((j) => j.id)).toEqual(['job_003', 'job_001', 'job_002']);
  });

  it('counts jobs by status', () => {
    const { repo } = freshRepo();
    repo.create(newJob('job_001'));
    repo.create(newJob('job_002'));
    repo.create(newJob('job_003'));

    // 认领一个（running），成功一个，失败一个
    repo.claimNext('worker-1'); // job_001 -> running
    repo.succeed('job_001', 'prof_001'); // job_001 -> succeeded
    repo.claimNext('worker-1'); // job_002 -> running
    repo.fail('job_002', 'error'); // job_002 -> failed
    // job_003 仍然 queued

    const counts = repo.countByStatus();
    expect(counts.queued).toBe(1);
    expect(counts.running).toBe(0);
    expect(counts.succeeded).toBe(1);
    expect(counts.failed).toBe(1);
  });

  it('migration 002 creates analysis_jobs table with expected columns', () => {
    const db = new Database(':memory:');
    runMigrations(db, MIGRATIONS_DIR);

    const columns = db
      .prepare("PRAGMA table_info(analysis_jobs)")
      .all() as Array<{ name: string; type: string; notnull: number; dflt_value: string | null }>;
    const colNames = columns.map((c) => c.name);

    expect(colNames).toContain('id');
    expect(colNames).toContain('subject_platform');
    expect(colNames).toContain('subject_login');
    expect(colNames).toContain('status');
    expect(colNames).toContain('stage');
    expect(colNames).toContain('attempts');
    expect(colNames).toContain('profile_id');
    expect(colNames).toContain('error_message');
    expect(colNames).toContain('budget_used');
    expect(colNames).toContain('missing');
    expect(colNames).toContain('claimed_by');
    expect(colNames).toContain('created_at');
    expect(colNames).toContain('updated_at');
    expect(colNames).toContain('started_at');
    expect(colNames).toContain('finished_at');

    // 检查默认值
    const statusCol = columns.find((c) => c.name === 'status')!;
    expect(statusCol.dflt_value).toContain('queued');
    const attemptsCol = columns.find((c) => c.name === 'attempts')!;
    expect(attemptsCol.dflt_value).toContain('0');

    db.close();
  });
});
