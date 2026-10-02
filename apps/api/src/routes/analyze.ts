/**
 * 分析触发路由（Q1 单文件拆分）：POST /analyze + GET /jobs/:id。
 */
import type { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { DEMO_ERROR_CODES } from '@jobagent/shared';
import { oneHourAgo } from '../demo-config.js';
import { formatJob } from './helpers.js';
import { AnalyzeRequestSchema, JobIdParamSchema } from './schemas.js';
import type { HonoEnv } from './types.js';
import type { RouteDeps } from './context.js';

export function registerAnalyze(app: Hono<HonoEnv>, d: RouteDeps): void {
  const { repos, now, cfg, ipHashOf } = d;

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

    // 画像缓存：命中未过期的完整画像则直接返回，避免重复分析（PRD 运行架构第 1 步）
    const cacheTtlMs = Number(process.env.PROFILE_CACHE_TTL_MS ?? 24 * 60 * 60 * 1000);
    const latestProfile = await repos.profiles.latestBySubject(platform, username);
    // S3 软挂起：目标主体有未决移除申请（removal_requested_at 非空）时，禁止当作缓存命中、
    // 也禁止再触发新分析——该画像正处在「按主体撤回」处理中，不应继续分发。复核批准后会整行删除。
    if (latestProfile && latestProfile.removalRequestedAt) {
      console.info(`[analyze] result=blocked reason=removal_pending platform=${platform} login=${username}`);
      return c.json(
        {
          error: 'a profile removal request is pending for this subject',
          code: 'REMOVAL_PENDING',
        },
        409,
      );
    }
    if (
      latestProfile &&
      latestProfile.status === 'complete' &&
      Date.now() - Date.parse(latestProfile.updatedAt) < cacheTtlMs
    ) {
      // NFR-7 可观测：缓存命中（不扣配额），与下方 cache_miss 配对统计命中率。
      console.info(`[analyze] result=cache_hit platform=${platform} login=${username}`);
      return c.json({
        profileId: latestProfile.id,
        status: 'succeeded',
        cached: true,
        message: 'A recent complete profile already exists.',
      });
    }

    // 画像缓存命中已在上方直接返回（任何身份放行、不扣配额）。
    // 缓存未命中、需要触发新分析——这是唯一被演示身份限制的动作。
    const principal = c.get('principal');
    if (principal.kind === 'anonymous') {
      console.info(`[analyze] result=blocked reason=demo_required platform=${platform} login=${username}`);
      return c.json(
        {
          error: 'demo session required to start a new analysis',
          code: DEMO_ERROR_CODES.demoRequired,
          message: 'Create a demo session (POST /demo/sessions) then retry once.',
        },
        403,
      );
    }
    if (principal.kind === 'user') {
      // 登录用户（决策 #1-A 主脊）：不占演示会话配额，active 去重后直接建分析任务。
      const existingUserJob = await repos.jobs.latestActiveBySubject(platform, username);
      if (existingUserJob) {
        console.info(
          `[analyze] result=dedup requester=user platform=${platform} login=${username} job=${existingUserJob.id}`,
        );
        return c.json({
          jobId: existingUserJob.id,
          status: existingUserJob.status,
          dedup: true,
          message: 'An active analysis job already exists for this user.',
        });
      }
      const userJobId = `job-${randomUUID()}`;
      await repos.jobs.create({
        id: userJobId,
        subjectPlatform: platform,
        subjectLogin: username,
        requesterKind: 'user',
        demoSessionId: null,
      });
      console.info(`[analyze] result=queued requester=user platform=${platform} login=${username} job=${userJobId}`);
      return c.json(
        {
          jobId: userJobId,
          status: 'queued',
          dedup: false,
          message: 'Analysis job created. Poll GET /jobs/:id for status.',
        },
        201,
      );
    }

    const sessionId = principal.sessionId;
    const nowIso = now();

    // active 去重先于配额扣减：已有在跑任务直接复用，不白扣一次会话名额
    const existing = await repos.jobs.latestActiveBySubject(platform, username);
    if (existing) {
      console.info(
        `[analyze] result=dedup requester=demo platform=${platform} login=${username} job=${existing.id}`,
      );
      return c.json({
        jobId: existing.id,
        status: existing.status,
        dedup: true,
        message: 'An active analysis job already exists for this user.',
      });
    }

    // 第二道闸：IP 分析滑动窗口（防清 Cookie 重置）
    const ipHash = ipHashOf(c);
    if (ipHash) {
      const recent = await repos.demoSessions.countRateEvents(
        ipHash,
        'analyze',
        oneHourAgo(nowIso),
      );
      if (recent >= cfg.analyzeRatePerHour) {
        console.info(
          `[analyze] result=blocked reason=ip_rate_limited platform=${platform} login=${username}`,
        );
        return c.json(
          {
            error: 'demo analyze rate limit exceeded',
            code: DEMO_ERROR_CODES.rateLimited,
            bucket: 'analyze',
            retryAfterSeconds: 3600,
          },
          429,
        );
      }
    }

    // 第一道闸：会话级原子扣减（单条条件 UPDATE，严禁 select-then-update）。
    // platform=all 一次作业双源采集、约 2x 成本，按 fusionAnalyzeCost 扣减（默认 2）；单源扣 1。
    const analyzeCost = platform === 'all' ? cfg.fusionAnalyzeCost : 1;
    const slot = await repos.demoSessions.acquireAnalyzeSlot(
      sessionId,
      cfg.analyzeQuota,
      nowIso,
      analyzeCost,
    );
    if (!slot.granted) {
      if (slot.reason === 'quota_exceeded') {
        console.info(
          `[analyze] result=blocked reason=quota_exhausted platform=${platform} login=${username} used=${slot.used}`,
        );
        return c.json(
          {
            error: 'demo analyze quota exhausted',
            code: DEMO_ERROR_CODES.quotaExceeded,
            analyzeQuota: cfg.analyzeQuota,
            analyzeUsed: slot.used,
            analyzeRemaining: 0,
            resetAt: principal.expiresAt,
          },
          429,
        );
      }
      // 会话过期/退出/不存在：Cookie 已失效，回 DEMO_REQUIRED 让前端重建会话后重试
      return c.json(
        { error: 'demo session invalid or expired', code: DEMO_ERROR_CODES.demoRequired },
        403,
      );
    }
    if (ipHash) await repos.demoSessions.insertRateEvent(ipHash, 'analyze', nowIso);

    // 创建新任务；若落库失败必须补偿已扣名额
    const jobId = `job-${randomUUID()}`;
    try {
      await repos.jobs.create({
        id: jobId,
        subjectPlatform: platform,
        subjectLogin: username,
        requesterKind: 'demo',
        demoSessionId: sessionId,
      });
    } catch (err) {
      await repos.demoSessions.releaseAnalyzeSlot(sessionId, analyzeCost);
      throw err;
    }
    // all 融合作业主体在主源 GitHub，demo 观测的 analyzedLogins 平台仅接受 github/gitee，故归到 github。
    await repos.demoSessions.touch(sessionId, nowIso, {
      platform: platform === 'all' ? 'github' : platform,
      login: username,
    });

    console.info(
      `[analyze] result=queued requester=demo platform=${platform} login=${username} job=${jobId} remaining=${slot.remaining} cost=${analyzeCost}`,
    );
    return c.json(
      {
        jobId,
        status: 'queued',
        dedup: false,
        demo: { remaining: slot.remaining },
        message: 'Analysis job created. Poll GET /jobs/:id for status.',
      },
      201,
    );
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
}
