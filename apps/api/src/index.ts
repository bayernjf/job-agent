/**
 * JobAgent API（M1·W3）：Hono HTTP 接口，触发分析、查询任务状态、查询画像快照。
 *
 * 架构（技术选型 6.5）：
 * - Hono + Zod：轻量 Web 框架 + 输入校验
 * - 接口收到用户名 → Zod 校验 → 命中未过期画像快照则直接返回 → 否则创建 analysis_jobs(queued)
 * - API 立即返回 jobId，Worker 异步消费
 * - 所有 DB 访问收敛到 storage 仓储层（业务模块禁裸 SQL、不感知 SQLite/Postgres 方言）
 *
 * 端点：
 *   POST /analyze        — 创建分析任务（去重：同一用户有 active job 则返回现有 jobId）
 *   GET  /jobs/:id       — 查询任务状态（queued/running/succeeded/failed + stage + profileId）
 *   GET  /profiles/:id   — 查询画像快照（完整 AbilityProfile JSON）
 *   GET  /health         — 健康检查
 *
 * 环境变量：
 *   DB_DRIVER   — sqlite（默认）| postgres
 *   DB_PATH     — SQLite 数据库路径（默认 data/job-agent.db）
 *   DATABASE_URL— Postgres 连接串（DB_DRIVER=postgres 时）
 *   PORT        — 监听端口（默认 3000）
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import type { AbilityProfile } from '@jobagent/shared';
import {
  createStorage,
  type IAnalysisJobsRepository,
  type IProfilesRepository,
  type StoredAnalysisJob,
  type StoredProfile,
} from '@jobagent/storage';

// ─── 类型 ───────────────────────────────────────────────────────────────

export interface ApiRepos {
  jobs: IAnalysisJobsRepository;
  profiles: IProfilesRepository;
}

export interface ApiDeps {
  /** 注入仓储（测试用内存库；生产默认 createStorage） */
  repos?: ApiRepos;
  /** 注入"现在"（测试确定性） */
  now?: () => string;
}

// ─── 输入校验 Schema ────────────────────────────────────────────────────

const AnalyzeRequestSchema = z.object({
  username: z
    .string()
    .min(1, 'username is required')
    .max(39, 'username too long') // GitHub username max 39 chars
    .regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9]))*$/, 'invalid GitHub username format'),
  platform: z.enum(['github']).default('github'),
});

const JobIdParamSchema = z.object({
  id: z.string().min(1, 'job id is required'),
});

const ProfileIdParamSchema = z.object({
  id: z.string().min(1, 'profile id is required'),
});

// ─── 响应格式化 ──────────────────────────────────────────────────────────

function formatJob(job: StoredAnalysisJob) {
  return {
    id: job.id,
    subject: {
      platform: job.subjectPlatform,
      login: job.subjectLogin,
    },
    status: job.status,
    stage: job.stage,
    attempts: job.attempts,
    profileId: job.profileId,
    error: job.errorMessage,
    budgetUsed: job.budgetUsed,
    missing: job.missing,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}

function formatProfile(profile: StoredProfile) {
  return {
    id: profile.id,
    analyzerVersion: profile.analyzerVersion,
    subject: {
      platform: profile.subjectPlatform,
      login: profile.subjectLogin,
      claimed: profile.subjectClaimed,
    },
    dataWindow: {
      since: profile.dataWindowSince,
      until: profile.dataWindowUntil,
    },
    analysisLayers: profile.analysisLayers,
    status: profile.status,
    snapshot: profile.snapshot as AbilityProfile | null,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

// ─── 应用创建 ────────────────────────────────────────────────────────────

/**
 * 创建 Hono 应用（可注入依赖，便于测试）。
 * 生产环境缺省走 createStorage（按 DB_DRIVER 选择方言），测试注入内存仓储。
 */
export async function createApp(deps: ApiDeps = {}): Promise<Hono> {
  const repos: ApiRepos = deps.repos ?? (await createStorage());
  const app = new Hono();

  // CORS：允许落地页跨域调用
  app.use('*', cors({
    origin: '*', // MVP 阶段开放；生产环境收紧为落地页域名
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type'],
  }));

  // 健康检查
  app.get('/health', (c) => {
    return c.json({ status: 'ok', service: 'jobagent-api', time: new Date().toISOString() });
  });

  // POST /analyze：创建分析任务
  app.post('/analyze', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    const parsed = AnalyzeRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'validation failed', details: parsed.error.flatten() }, 400);
    }

    const { username, platform } = parsed.data;

    // 去重：同一用户有 active（queued/running）任务则返回现有 jobId
    const existing = await repos.jobs.latestActiveBySubject(platform, username);
    if (existing) {
      return c.json({
        jobId: existing.id,
        status: existing.status,
        dedup: true,
        message: 'An active analysis job already exists for this user.',
      });
    }

    // 创建新任务
    const jobId = `job-${randomUUID()}`;
    await repos.jobs.create({ id: jobId, subjectPlatform: platform, subjectLogin: username });

    return c.json({
      jobId,
      status: 'queued',
      dedup: false,
      message: 'Analysis job created. Poll GET /jobs/:id for status.',
    }, 201);
  });

  // GET /jobs/:id：查询任务状态
  app.get('/jobs/:id', async (c) => {
    const parsed = JobIdParamSchema.safeParse(c.req.param());
    if (!parsed.success) {
      return c.json({ error: 'invalid job id' }, 400);
    }

    const job = await repos.jobs.getById(parsed.data.id);
    if (!job) {
      return c.json({ error: 'job not found' }, 404);
    }

    return c.json(formatJob(job));
  });

  // GET /profiles/:id：查询画像快照
  app.get('/profiles/:id', async (c) => {
    const parsed = ProfileIdParamSchema.safeParse(c.req.param());
    if (!parsed.success) {
      return c.json({ error: 'invalid profile id' }, 400);
    }

    const profile = await repos.profiles.getById(parsed.data.id);
    if (!profile) {
      return c.json({ error: 'profile not found' }, 404);
    }

    return c.json(formatProfile(profile));
  });

  // 404 兜底
  app.notFound((c) => {
    return c.json({ error: 'not found', path: c.req.path }, 404);
  });

  // 错误处理
  app.onError((err, c) => {
    console.error(`[api] unhandled error: ${err.message}`);
    return c.json({ error: 'internal server error' }, 500);
  });

  return app;
}

// ─── 入口 ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 3000);
  const app = await createApp();

  // Hono 自带 serve（Node.js）
  const { serve } = await import('@hono/node-server');
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`[api] JobAgent API listening on http://localhost:${info.port}`);
    console.log(`[api] Endpoints: POST /analyze, GET /jobs/:id, GET /profiles/:id, GET /health`);
  });
}

// 仅在直接运行时启动（被 import 时不启动）
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
