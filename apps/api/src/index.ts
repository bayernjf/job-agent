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
 *   POST /analyze        — 创建分析任务（演示模式配额闸；画像缓存先于身份、任何身份可读缓存）
 *   POST /demo/sessions  — 免注册创建/幂等获取演示会话（HttpOnly Cookie）
 *   GET  /demo/me        — 当前演示身份与配额状态
 *   GET  /demo/presets   — 预置示例账号就绪情况（公开只读）
 *   POST /demo/exit      — 退出演示、清 Cookie
 *   GET  /jobs/:id       — 查询任务状态（queued/running/succeeded/failed + stage + profileId）
 *   GET  /profiles/:id   — 查询画像快照（完整 AbilityProfile JSON）
 *   GET  /job-postings   — 岗位检索（P2-D 职位聚合消费侧）
 *   POST /job-postings/match — 按画像技能匹配岗位
 *   POST /resumes/build  — 岗位定向简历按需生成（P-R2，不入库；body: profileId+jobId+可选 local/locale/format）
 *   GET  /candidates     — 企业侧人才检索（公开只读，筛选工作台 P-A）
 *   GET  /profiles/:id/applications — 列出某画像的投递记录
 *   POST /profiles/:id/applications — 新增投递记录
 *   PATCH /applications/:id         — 更新投递状态/备注
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
import { randomBytes, randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { deleteCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import {
  toExportableProfile,
  JobSourceSchema,
  JobPostingSchema,
  LocalResumeFieldsSchema,
  ResumeLocaleSchema,
  AUTHENTICITY_STATUSES,
  DEMO_ERROR_CODES,
  type AbilityProfile,
  type AuthenticityStatus,
  type DemoMe,
  type DemoPreset,
  type JobSource,
  type LocalResumeFields,
  type Principal,
  type ResumeLocale,
  type SkillTag,
} from '@jobagent/shared';
import {
  createStorage,
  toEvidenceItems,
  APPLICATION_STATUSES,
  APPLICATION_ORIGINS,
  type IAnalysisJobsRepository,
  type IApplicationsRepository,
  type IDemoSessionsRepository,
  type IProfilesRepository,
  type IJobPostingsRepository,
  type IEvidenceRepository,
  type ApplicationOrigin,
  type ApplicationStatus,
  type StoredAnalysisJob,
  type StoredEvidence,
  type StoredProfile,
} from '@jobagent/storage';
import { matchJobs } from '@jobagent/job-source';
import {
  buildResume,
  renderHtml,
  renderMarkdown,
  fromJobMatch,
  polishResume,
  type ResumePolishProvider,
} from '@jobagent/resume-core';
import { createResumePolishProviderFromEnv } from '@jobagent/llm';
import { skillTagMap, buildSkillReasons, collectEvidence } from './match-explain.js';
import {
  loadDemoConfig,
  oneHourAgo,
  type DemoConfig,
} from './demo-config.js';
import {
  DEMO_COOKIE,
  clientIp,
  generateSessionId,
  hashIp,
  resolvePrincipal,
} from './principal.js';

// ─── 类型 ───────────────────────────────────────────────────────────────

export interface ApiRepos {
  jobs: IAnalysisJobsRepository;
  profiles: IProfilesRepository;
  jobPostings: IJobPostingsRepository;
  evidence: IEvidenceRepository;
  demoSessions: IDemoSessionsRepository;
  applications: IApplicationsRepository;
}

export interface ApiDeps {
  /** 注入仓储（测试用内存库；生产默认 createStorage） */
  repos?: ApiRepos;
  /** 注入"现在"（测试确定性） */
  now?: () => string;
  /** 注入演示配置（测试用；默认从环境变量加载） */
  demoConfig?: DemoConfig;
  /**
   * 简历 LLM 润色 provider（设计 §7/§10 #4）。
   * 不传（undefined）= 按服务端 LLM_* 环境变量自动构造（无 LLM_API_KEY 则为 null，默认关闭走规则版）；
   * 显式传 null = 强制关闭；测试注入 FakeLlmClient 包装的 provider。
   */
  resumePolish?: ResumePolishProvider | null;
}

// ─── 输入校验 Schema ────────────────────────────────────────────────────

const AnalyzeRequestSchema = z.object({
  username: z
    .string()
    .min(1, 'username is required')
    .max(39, 'username too long')
    // 兼容 GitHub（字母数字+中划线）与 Gitee（额外允许下划线）
    .regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9]|[-_](?=[a-zA-Z0-9]))*$/, 'invalid username format'),
  // all=一次作业同时采 GitHub+Gitee 并镜像去重融合成一张画像（见 design-cross-source-fusion §8）
  platform: z.enum(['github', 'gitee', 'all']).default('github'),
});

const JobIdParamSchema = z.object({
  id: z.string().min(1, 'job id is required'),
});

const ProfileIdParamSchema = z.object({
  id: z.string().min(1, 'profile id is required'),
});

// 岗位搜索 query string 校验（全是字符串，需逐项转换）
const JobSearchQuerySchema = z.object({
  keyword: z.string().trim().min(1).optional(),
  remote: z.enum(['true', 'false']).optional(),
  sources: z.string().trim().min(1).optional(), // 逗号分隔，逐个用 JobSourceSchema 校验
  company: z.string().trim().min(1).optional(),
  tags: z.string().trim().min(1).optional(),
  salaryMinUsd: z.coerce.number().int().nonnegative().optional(),
  postedAfter: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
  orderBy: z.enum(['posted_desc', 'posted_asc', 'salary_desc']).optional(),
});

// 画像匹配请求体：skills 与 profileId 二选一（profileId 优先，从画像快照取 skillTags.name）
const JobMatchRequestSchema = z.object({
  skills: z.array(z.string().trim().min(1)).optional(),
  profileId: z.string().trim().min(1).optional(),
  remote: z.boolean().optional(),
  salaryMinUsd: z.number().int().nonnegative().optional(),
  sources: z.array(JobSourceSchema).optional(),
  keyword: z.string().trim().min(1).optional(),
  tags: z.array(z.string().trim().min(1)).optional(),
  company: z.string().trim().min(1).optional(),
  postedAfter: z.string().trim().min(1).optional(),
  candidateLimit: z.number().int().positive().max(500).optional(),
  limit: z.number().int().positive().max(500).optional(),
}).refine((d) => (d.skills && d.skills.length > 0) || !!d.profileId, {
  message: 'either non-empty skills or profileId is required',
  path: ['skills'],
});

// 岗位定向简历生成请求体（P-R2）：画像 + 岗位 + 可选本地补填；服务端不持久化、不记日志。
const ResumeBuildRequestSchema = z.object({
  profileId: z.string().min(1, 'profileId is required'),
  jobId: z.string().min(1, 'jobId is required'),
  // 画像不提供的教育/工作经历/联系方式；仅用于本次渲染，绝不入库或落日志（设计 §5.4）
  local: LocalResumeFieldsSchema.optional(),
  locale: ResumeLocaleSchema.optional(),
  format: z.enum(['json', 'md', 'html']).optional(), // 默认 json（仅结构化草稿）
  highlightLimit: z.number().int().positive().max(50).optional(),
  // 是否请求 B 档 LLM 措辞润色（设计 §7）：默认 false 走纯规则版；true 且服务端未配置/润色被安全层拒绝时，
  // 静默回退规则版，并在响应 polish.applied=false + reason 中如实标注，绝不臆造、绝不因润色失败而报错。
  polish: z.boolean().optional(),
});

// ── 企业侧人才检索（筛选工作台 P-A/P-B）──────────────────────────────────
// 全是 query string（字符串），枚举集合/数字在 handler 内逐项转换校验。
const CandidateSearchQuerySchema = z.object({
  keyword: z.string().trim().min(1).optional(),
  skills: z.string().trim().min(1).optional(), // 逗号分隔技能名
  skillMatch: z.enum(['any', 'all']).optional(),
  authenticity: z.string().trim().min(1).optional(), // 逗号分隔真实性状态
  minConfidence: z.coerce.number().min(0).max(1).optional(),
  platform: z.enum(['github', 'gitee']).optional(),
  sortBy: z.enum(['confidence_desc', 'skill_count_desc', 'recent']).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

// ── 投递记录（applications，痛点解决方案批次 2）────────────────────────────
const ApplicationStatusSchema = z.enum(
  APPLICATION_STATUSES as unknown as [ApplicationStatus, ...ApplicationStatus[]],
);
const ApplicationOriginSchema = z.enum(
  APPLICATION_ORIGINS as unknown as [ApplicationOrigin, ...ApplicationOrigin[]],
);

const ApplicationCreateSchema = z.object({
  jobId: z.string().min(1).nullish(),
  source: z.string().min(1).nullish(),
  targetTitle: z.string().min(1, 'targetTitle is required'),
  targetCompany: z.string().min(1, 'targetCompany is required'),
  targetUrl: z.string().url().nullish(),
  status: ApplicationStatusSchema.optional(),
  note: z.string().nullish(),
  origin: ApplicationOriginSchema.optional(),
  appliedAt: z.string().datetime().optional(),
});

const ApplicationPatchSchema = z
  .object({
    status: ApplicationStatusSchema.optional(),
    note: z.string().nullable().optional(),
    appliedAt: z.string().datetime().optional(),
    targetUrl: z.string().url().nullable().optional(),
  })
  .refine((d) => Object.keys(d).length > 0, {
    message: 'at least one field to update is required',
  });

// ─── 响应格式化 ──────────────────────────────────────────────────────────

function formatJob(job: StoredAnalysisJob) {
  return {
    id: job.id,
    subject: {
      platform: job.subjectPlatform,
      login: job.subjectLogin,
    },
    // 只回身份类，绝不回 demoSessionId（它等同会话凭证，见设计 §7.4）
    requester: { kind: job.requesterKind },
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

/** 把 Principal 序列化为 GET /demo/me 响应体（demo 带配额状态）。 */
function toDemoMe(principal: Principal, analyzeQuota: number): DemoMe {
  if (principal.kind !== 'demo') return { kind: 'anonymous' };
  return {
    kind: 'demo',
    sessionId: principal.sessionId,
    expiresAt: principal.expiresAt,
    analyzeQuota,
    analyzeUsed: principal.analyzeCount,
    analyzeRemaining: Math.max(0, analyzeQuota - principal.analyzeCount),
  };
}

/** 演示 Cookie 统一属性（设计 §7.6）；生产 HTTPS 才加 Secure。 */
function demoCookieOptions(cfg: DemoConfig, nowIso: string) {
  return {
    httpOnly: true,
    sameSite: 'Lax' as const,
    path: '/',
    secure: cfg.isProduction,
    maxAge: Math.floor(cfg.sessionTtlMs / 1000),
    expires: new Date(Date.parse(nowIso) + cfg.sessionTtlMs),
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
export async function createApp(deps: ApiDeps = {}): Promise<Hono<{
  Variables: { principal: Principal };
}>> {
  const repos: ApiRepos = deps.repos ?? ((await createStorage()) as unknown as ApiRepos);
  const now = deps.now ?? (() => new Date().toISOString());
  const cfg = deps.demoConfig ?? loadDemoConfig();
  // 简历 LLM 润色：默认按服务端 LLM_* env 构造，未配置 LLM_API_KEY 时为 null（规则版兜底，零费用）。
  const polishProvider: ResumePolishProvider | null =
    deps.resumePolish === undefined ? createResumePolishProviderFromEnv() : deps.resumePolish;
  // DEMO_IP_SALT 缺省时进程内随机盐（重启后历史 IP 窗口失效，仅本地/实验可接受）
  const effectiveSalt = cfg.ipSalt || randomBytes(16).toString('hex');

  const app = new Hono<{ Variables: { principal: Principal } }>();

  // CORS：默认 '*' 保持现状（不发凭证 Cookie）；配置 CORS_ALLOW_ORIGINS 后回显具体 Origin 并允许凭证（形态 B）
  const allowOrigins = [...cfg.corsAllowOrigins];
  app.use(
    '*',
    cors({
      origin:
        allowOrigins.length > 0
          ? (origin) => (origin && allowOrigins.includes(origin) ? origin : null)
          : '*',
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['Content-Type'],
      ...(allowOrigins.length > 0 ? { credentials: true } : {}),
    }),
  );

  // Principal 全局解析：每个请求解析一次演示身份，下游 handler 只读 c.get('principal')
  app.use('*', async (c, next) => {
    c.set(
      'principal',
      await resolvePrincipal(c.req.header('Cookie'), repos.demoSessions, now),
    );
    await next();
  });

  /** 计算当前请求的加盐 IP 哈希；无可信 IP 时返回 null（不做 IP 限流）。 */
  const ipHashOf = (c: Context): string | null => {
    const ip = clientIp(c, cfg.trustProxy);
    return ip ? hashIp(ip, effectiveSalt) : null;
  };

  // 健康检查
  app.get('/health', (c) => {
    return c.json({ status: 'ok', service: 'jobagent-api', time: new Date().toISOString() });
  });

  // ── 演示模式端点（必须注册在 /analyze 之前）────────────────────────────

  // POST /demo/sessions：免注册创建（或幂等返回）演示会话
  app.post('/demo/sessions', async (c) => {
    const principal = c.get('principal');
    const nowIso = now();
    if (principal.kind === 'demo') {
      return c.json(toDemoMe(principal, cfg.analyzeQuota), 200); // 幂等，不重复建/不占窗口
    }

    const ipHash = ipHashOf(c);
    if (ipHash) {
      const recent = await repos.demoSessions.countRateEvents(
        ipHash,
        'session',
        oneHourAgo(nowIso),
      );
      if (recent >= cfg.sessionRatePerHour) {
        return c.json(
          {
            error: 'demo session rate limit exceeded',
            code: DEMO_ERROR_CODES.rateLimited,
            bucket: 'session',
            retryAfterSeconds: 3600,
          },
          429,
        );
      }
    }

    const id = generateSessionId();
    const expiresAt = new Date(Date.parse(nowIso) + cfg.sessionTtlMs).toISOString();
    await repos.demoSessions.create({ id, expiresAt, ipHash });
    if (ipHash) await repos.demoSessions.insertRateEvent(ipHash, 'session', nowIso);
    setCookie(c, DEMO_COOKIE, id, demoCookieOptions(cfg, nowIso));

    return c.json(
      {
        kind: 'demo',
        sessionId: id,
        expiresAt,
        analyzeQuota: cfg.analyzeQuota,
        analyzeUsed: 0,
        analyzeRemaining: cfg.analyzeQuota,
      } satisfies DemoMe,
      201,
    );
  });

  // GET /demo/me：当前演示身份与配额状态
  app.get('/demo/me', (c) => {
    return c.json(toDemoMe(c.get('principal'), cfg.analyzeQuota));
  });

  // GET /demo/presets：预置示例账号的就绪情况（只读、公开）
  app.get('/demo/presets', async (c) => {
    const presets: DemoPreset[] = [];
    for (const preset of cfg.presetLogins) {
      const profile = await repos.profiles.latestBySubject(preset.platform, preset.login);
      const ready = !!profile && profile.status === 'complete' && !!profile.snapshot;
      const authenticity = ready
        ? ((profile!.snapshot as AbilityProfile).authenticity?.status ?? 'unknown')
        : 'unknown';
      presets.push({
        platform: preset.platform,
        login: preset.login,
        authenticity,
        profileId: ready ? profile!.id : null,
        ready,
      });
    }
    return c.json(presets);
  });

  // POST /demo/exit：退出演示（匿名调用为 no-op）
  app.post('/demo/exit', async (c) => {
    const principal = c.get('principal');
    if (principal.kind === 'demo') {
      await repos.demoSessions.exit(principal.sessionId, now());
    }
    deleteCookie(c, DEMO_COOKIE, { path: '/' });
    return c.json({ kind: 'anonymous' });
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

    // 画像缓存：命中未过期的完整画像则直接返回，避免重复分析（PRD 运行架构第 1 步）
    const cacheTtlMs = Number(process.env.PROFILE_CACHE_TTL_MS ?? 24 * 60 * 60 * 1000);
    const latestProfile = await repos.profiles.latestBySubject(platform, username);
    if (
      latestProfile &&
      latestProfile.status === 'complete' &&
      Date.now() - Date.parse(latestProfile.updatedAt) < cacheTtlMs
    ) {
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
      // 'user' 为账号里程碑预留，本期不会产生
      return c.json({ error: 'accounts are not available yet' }, 501);
    }

    const sessionId = principal.sessionId;
    const nowIso = now();

    // active 去重先于配额扣减：已有在跑任务直接复用，不白扣一次会话名额
    const existing = await repos.jobs.latestActiveBySubject(platform, username);
    if (existing) {
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

  // GET /profiles/:id/exportable：导出画像（P1 扩展消费，服务端投影单一事实源）
  app.get('/profiles/:id/exportable', async (c) => {
    const parsed = ProfileIdParamSchema.safeParse(c.req.param());
    if (!parsed.success) {
      return c.json({ error: 'invalid profile id' }, 400);
    }

    const profile = await repos.profiles.getById(parsed.data.id);
    if (!profile) {
      return c.json({ error: 'profile not found' }, 404);
    }
    if (!profile.snapshot) {
      return c.json({ error: 'profile has no snapshot' }, 404);
    }

    return c.json(toExportableProfile(profile.snapshot));
  });

  // GET /profiles/:id/job-recommendations：画像技能 → 岗位匹配推荐（第一档①，报告页消费）
  app.get('/profiles/:id/job-recommendations', async (c) => {
    const parsed = ProfileIdParamSchema.safeParse(c.req.param());
    if (!parsed.success) return c.json({ error: 'invalid profile id' }, 400);
    const profile = await repos.profiles.getById(parsed.data.id);
    if (!profile) return c.json({ error: 'profile not found' }, 404);
    if (!profile.snapshot) return c.json({ error: 'profile has no snapshot' }, 404);
    const skills = profile.snapshot.skillTags.map((tag) => tag.name);
    const tags = skillTagMap(profile.snapshot.skillTags);
    const evidenceRows = await repos.evidence.listByProfile(parsed.data.id);

    const q = c.req.query();
    let remote: boolean | undefined;
    if (q.remote !== undefined) remote = q.remote === 'true';
    let sources: JobSource[] | undefined;
    if (q.sources) {
      const picked = q.sources.split(',').map((s) => s.trim()).filter(Boolean);
      const bad = picked.filter((s) => !JobSourceSchema.safeParse(s).success);
      if (bad.length > 0) return c.json({ error: 'invalid source(s)', invalid: bad }, 400);
      sources = picked as JobSource[];
    }
    let salaryMinUsd: number | undefined;
    if (q.salary_min !== undefined) {
      const n = Number(q.salary_min);
      if (!Number.isInteger(n) || n < 0) return c.json({ error: 'salary_min must be a non-negative integer' }, 400);
      salaryMinUsd = n;
    }
    let limit = 20;
    if (q.limit !== undefined) {
      const n = Number(q.limit);
      if (!Number.isInteger(n) || n < 1 || n > 100) return c.json({ error: 'limit must be an integer between 1 and 100' }, 400);
      limit = n;
    }
    let candidateLimit = 500;
    if (q.candidate_limit !== undefined) {
      const n = Number(q.candidate_limit);
      if (!Number.isInteger(n) || n < 1 || n > 500) return c.json({ error: 'candidate_limit must be an integer between 1 and 500' }, 400);
      candidateLimit = n;
    }

    const candidates = await repos.jobPostings.search({
      sources,
      remote,
      salaryMinUsd,
      limit: candidateLimit,
      orderBy: 'posted_desc',
    });
    const matches = matchJobs(candidates, { skills, remote, salaryMinUsd, sources, limit });
    const serialized = matches.map((x) => {
      const skillReasons = buildSkillReasons(x, tags);
      const base = {
        score: x.score,
        matchedSkills: x.matchedSkills,
        fieldScores: x.fieldScores,
        skillHits: x.skillHits,
        posting: x.posting,
      };
      return skillReasons ? { ...base, skillReasons } : base;
    });
    const allReasons = serialized.flatMap((x) => ('skillReasons' in x ? x.skillReasons : []));
    return c.json({
      profileId: parsed.data.id,
      profileSkills: skills,
      matches: serialized,
      evidence: collectEvidence(allReasons, evidenceRows),
      total: matches.length,
      candidatePool: candidates.length,
    });
  });

  // ── 职位聚合（P2-D）：搜索 / 统计 / 单条 / 画像匹配 ────────────────
  // 注意：/jobs/:id 已被分析任务占用，岗位相关端点统一用 /job-postings。

  // GET /job-postings：岗位检索（薄封装仓储 search）
  app.get('/job-postings', async (c) => {
    const parsed = JobSearchQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: 'validation failed', details: parsed.error.flatten() }, 400);
    }
    const q = parsed.data;
    let sources: JobSource[] | undefined;
    if (q.sources) {
      const picked = q.sources.split(',').map((s) => s.trim()).filter(Boolean);
      const bad = picked.filter((s) => !JobSourceSchema.safeParse(s).success);
      if (bad.length > 0) return c.json({ error: 'invalid source(s)', invalid: bad }, 400);
      sources = picked as JobSource[];
    }
    const tags = q.tags ? q.tags.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
    const rows = await repos.jobPostings.search({
      keyword: q.keyword,
      remote: q.remote === undefined ? undefined : q.remote === 'true',
      sources,
      company: q.company,
      tags,
      salaryMinUsd: q.salaryMinUsd,
      postedAfter: q.postedAfter,
      limit: q.limit,
      offset: q.offset,
      orderBy: q.orderBy,
    });
    return c.json({ items: rows, limit: q.limit ?? 100, offset: q.offset ?? 0 });
  });

  // GET /job-postings/stats：按源统计（须在 :id 路由之前注册，避免 stats 被当成 id）
  app.get('/job-postings/stats', async (c) => {
    const active = await repos.jobPostings.countBySource('active');
    const inactive = await repos.jobPostings.countBySource('inactive');
    return c.json({ active, inactive });
  });

  // GET /job-postings/:id：单条岗位
  app.get('/job-postings/:id', async (c) => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'invalid job posting id' }, 400);
    const posting = await repos.jobPostings.getById(id);
    if (!posting) return c.json({ error: 'job posting not found' }, 404);
    return c.json(posting);
  });

  // POST /job-postings/match：先用结构化条件取候选池，再按画像技能打分排序
  app.post('/job-postings/match', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const parsed = JobMatchRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'validation failed', details: parsed.error.flatten() }, 400);
    }
    const m = parsed.data;

    // resolve skills: profileId takes precedence over explicit skills
    let skills: string[];
    let tags: Map<string, SkillTag> | undefined;
    let evidenceRows: StoredEvidence[] = [];
    if (m.profileId) {
      const profile = await repos.profiles.getById(m.profileId);
      if (!profile) return c.json({ error: 'profile not found' }, 404);
      if (!profile.snapshot) return c.json({ error: 'profile has no snapshot' }, 404);
      skills = profile.snapshot.skillTags.map((tag) => tag.name);
      tags = skillTagMap(profile.snapshot.skillTags);
      evidenceRows = await repos.evidence.listByProfile(m.profileId);
    } else {
      skills = m.skills!;
    }
    const candidates = await repos.jobPostings.search({
      keyword: m.keyword,
      sources: m.sources,
      remote: m.remote,
      company: m.company,
      tags: m.tags,
      salaryMinUsd: m.salaryMinUsd,
      postedAfter: m.postedAfter,
      limit: m.candidateLimit ?? 500,
      orderBy: 'posted_desc',
    });
    const matches = matchJobs(candidates, {
      skills,
      remote: m.remote,
      salaryMinUsd: m.salaryMinUsd,
      sources: m.sources,
      limit: m.limit ?? 50,
    });
    const serialized = matches.map((x) => {
      const skillReasons = buildSkillReasons(x, tags);
      const base = {
        score: x.score,
        matchedSkills: x.matchedSkills,
        fieldScores: x.fieldScores,
        skillHits: x.skillHits,
        posting: x.posting,
      };
      return skillReasons ? { ...base, skillReasons } : base;
    });
    const allReasons = serialized.flatMap((x) => ('skillReasons' in x ? x.skillReasons : []));
    // match 保持公开可用；demo 调用仅做会话观测计数（不设硬配额，设计 §7.4）
    const matchPrincipal = c.get('principal');
    if (matchPrincipal.kind === 'demo') {
      await repos.demoSessions.incrementMatch(matchPrincipal.sessionId, now());
    }
    return c.json({
      matches: serialized,
      total: matches.length,
      ...(m.profileId ? { profileSkills: skills } : {}),
      ...(tags ? { evidence: collectEvidence(allReasons, evidenceRows) } : {}),
    });
  });

  // ── 岗位定向简历（P-R2）：按需生成、不入库、不记日志（local 补填隐私最小化）──────
  // 纯计算只读端点：不触发新分析、不消耗平台采集配额，故与 GET 画像一样对所有身份公开。
  app.post('/resumes/build', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const parsed = ResumeBuildRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'validation failed', details: parsed.error.flatten() }, 400);
    }
    const req = parsed.data;

    const storedProfile = await repos.profiles.getById(req.profileId);
    if (!storedProfile) return c.json({ error: 'profile not found' }, 404);
    if (!storedProfile.snapshot) return c.json({ error: 'profile has no snapshot' }, 404);
    const profile: AbilityProfile = storedProfile.snapshot;

    const postingRow = await repos.jobPostings.getById(req.jobId);
    if (!postingRow) return c.json({ error: 'job posting not found' }, 404);
    const postingParse = JobPostingSchema.safeParse(postingRow);
    if (!postingParse.success) {
      return c.json({ error: 'stored job posting is invalid' }, 500);
    }
    const posting = postingParse.data;

    const evidenceRows = await repos.evidence.listByProfile(req.profileId);
    const evidence = toEvidenceItems(evidenceRows);

    // 匹配现算（单个岗位）；零命中 fromJobMatch(null) 走 low_match 降级（与 CLI 同路径）
    const skills = profile.skillTags.map((tag) => tag.name);
    const [matched] = matchJobs([posting], { skills, limit: 1 });
    const match = fromJobMatch(matched ?? null);

    const locale: ResumeLocale = req.locale ?? 'zh-CN';
    const ruleDraft = buildResume({
      profile,
      evidence,
      posting,
      match,
      local: req.local as LocalResumeFields | undefined,
      options: { locale, highlightLimit: req.highlightLimit, now: now() },
    });

    // 可选 B 档 LLM 措辞润色：只改措辞、安全层防臆造，任何失败/未配置都回退规则版（draft 引用不变）。
    let finalDraft = ruleDraft;
    let polish: { requested: boolean; applied: boolean; reason?: string } | undefined;
    if (req.polish === true) {
      polish = { requested: true, applied: false };
      if (!polishProvider) {
        polish.reason = 'not_configured';
      } else {
        const result = await polishResume(ruleDraft, posting, polishProvider, {
          locale,
          now: now(),
        });
        finalDraft = result.draft;
        polish.applied = result.applied;
        if (!result.applied && result.reason) polish.reason = result.reason;
      }
    }

    if (req.format === 'html') {
      return c.json({
        format: 'html' as const,
        draft: finalDraft,
        html: renderHtml(finalDraft, locale),
        ...(polish ? { polish } : {}),
      });
    }
    if (req.format === 'md') {
      return c.json({
        format: 'md' as const,
        draft: finalDraft,
        markdown: renderMarkdown(finalDraft, locale),
        ...(polish ? { polish } : {}),
      });
    }
    return c.json({ draft: finalDraft, ...(polish ? { polish } : {}) });
  });

  // ── 企业侧人才检索（筛选工作台 P-A/P-B）：只读已生成画像，不触发新采集 ──
  app.get('/candidates', async (c) => {
    const parsed = CandidateSearchQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: 'invalid query', details: parsed.error.flatten() }, 400);
    }
    const q = parsed.data;

    // 真实性状态是逗号分隔的枚举集合，逐个校验，拒绝未知值
    let authenticity: AuthenticityStatus[] | undefined;
    if (q.authenticity) {
      const picked = q.authenticity
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const invalid = picked.filter((s) => !AUTHENTICITY_STATUSES.includes(s as AuthenticityStatus));
      if (invalid.length > 0) {
        return c.json({ error: 'invalid authenticity value', values: invalid }, 400);
      }
      authenticity = picked as AuthenticityStatus[];
    }

    const skills = q.skills
      ? q.skills
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;

    const limit = q.limit ?? 20;
    const offset = q.offset ?? 0;
    const result = await repos.profiles.searchCandidates({
      ...(q.keyword ? { keyword: q.keyword } : {}),
      ...(skills && skills.length > 0 ? { skills } : {}),
      ...(q.skillMatch ? { skillMatch: q.skillMatch } : {}),
      ...(authenticity ? { authenticity } : {}),
      ...(q.minConfidence !== undefined ? { minConfidence: q.minConfidence } : {}),
      ...(q.platform ? { platform: q.platform } : {}),
      ...(q.sortBy ? { sortBy: q.sortBy } : {}),
      limit,
      offset,
    });
    return c.json({ items: result.items, total: result.total, limit, offset });
  });

  // ── 投递记录：列出某画像的投递（按 applied_at 倒序）──
  app.get('/profiles/:id/applications', async (c) => {
    const param = ProfileIdParamSchema.safeParse(c.req.param());
    if (!param.success) return c.json({ error: 'invalid profile id' }, 400);
    const profile = await repos.profiles.getById(param.data.id);
    if (!profile) return c.json({ error: 'profile not found' }, 404);
    const items = await repos.applications.listByProfile(param.data.id);
    return c.json({ items });
  });

  // ── 投递记录：新增（求职者在报告页/扩展记录投递动作）──
  app.post('/profiles/:id/applications', async (c) => {
    const param = ProfileIdParamSchema.safeParse(c.req.param());
    if (!param.success) return c.json({ error: 'invalid profile id' }, 400);
    const profile = await repos.profiles.getById(param.data.id);
    if (!profile) return c.json({ error: 'profile not found' }, 404);

    const parsed = ApplicationCreateSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: 'invalid application', details: parsed.error.flatten() }, 400);
    }
    const data = parsed.data;
    const id = `app-${randomUUID()}`;
    await repos.applications.insert({
      id,
      profileId: param.data.id,
      jobId: data.jobId ?? null,
      source: data.source ?? null,
      targetTitle: data.targetTitle,
      targetCompany: data.targetCompany,
      targetUrl: data.targetUrl ?? null,
      status: data.status ?? 'applied',
      note: data.note ?? null,
      origin: data.origin ?? 'manual',
      appliedAt: data.appliedAt ?? new Date().toISOString(),
    });
    const stored = await repos.applications.getById(id);
    return c.json(stored, 201);
  });

  // ── 投递记录：局部更新状态/备注/投递时间/链接（撤回用 status=withdrawn，不物理删除）──
  app.patch('/applications/:id', async (c) => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'invalid application id' }, 400);
    const parsed = ApplicationPatchSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: 'invalid patch', details: parsed.error.flatten() }, 400);
    }
    const updated = await repos.applications.update(id, parsed.data);
    if (!updated) return c.json({ error: 'application not found' }, 404);
    return c.json(updated);
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
    console.log(`[api] Endpoints: POST /analyze, POST /demo/sessions, GET /demo/me, GET /demo/presets, POST /demo/exit, GET /jobs/:id, GET /profiles/:id, GET /profiles/:id/exportable, GET /profiles/:id/job-recommendations, GET /job-postings, POST /job-postings/match, POST /resumes/build, GET /candidates, GET|POST /profiles/:id/applications, PATCH /applications/:id, GET /health`);
  });
}

// 仅在直接运行时启动（被 import 时不启动）
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
