/**
 * JobAgent API 入口（Q1 单文件拆分后）。
 *
 * 本文件只负责：
 *   1. 组装依赖（仓储 / 配置 / OAuth & LLM providers / 密钥）；
 *   2. 注册全局中间件（CORS、Principal 解析）；
 *   3. 构造 RouteDeps，按域挂载各 sub-router（见 ./routes/*）；
 *   4. notFound / onError 兜底，以及 Node 进程入口 main()。
 *
 * 各业务端点的实现按域拆分到：
 *   routes/system.ts       — /health、/internal/cron/process-job、/internal/cron/watch-heartbeat、/internal/cron/cleanup
 *   routes/demo.ts         — /demo/*
 *   routes/auth.ts         — /auth/*（GitHub/Gitee OAuth、会话、招聘方声明）
 *   routes/analyze.ts      — POST /analyze、GET /jobs/:id
 *   routes/profiles.ts     — /profiles/*（主体解析、快照、认领/解绑/删除、撤回、岗位推荐）
 *   routes/job-postings.ts — /job-postings/*
 *   routes/resumes.ts      — POST /resumes/build
 *   routes/recruiting.ts   — /candidates、/applications、/interviews
 *   routes/agent.ts        — /agent/* 及 /internal/cron/agent-tick
 *
 * 所有 DB 访问收敛到 storage 仓储层（业务模块禁裸 SQL、不感知 SQLite/Postgres 方言）。
 *
 * 环境变量：
 *   DB_DRIVER   — sqlite（默认）| postgres
 *   DB_PATH     — SQLite 数据库路径（默认 data/job-agent.db）
 *   DATABASE_URL— Postgres 连接串（DB_DRIVER=postgres 时）
 *   PORT        — 监听端口（默认 3000）
 *   API_MOUNT_PREFIX — 同域挂载前缀（形态 C 设为 /api；影响对外 OAuth redirect_uri 与临时 Cookie Path）
 *   CRON_SECRET — serverless cron 端点共享密钥（未配则仅信任 x-vercel-cron 头）
 */

import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { createStorage } from '@jobagent/storage';
import {
  createCatalogCache,
  createCoverLetterProviderFromEnv,
  createResumePolishProviderFromEnv,
} from '@jobagent/llm';
import { loadDemoConfig } from './demo-config.js';
import { loadAuthConfig } from './auth-config.js';
import { GithubAuthProvider } from './github-auth.js';
import { GiteeAuthProvider } from './gitee-auth.js';
import { configureOutboundProxy } from './proxy-bootstrap.js';
import { runStartupSchemaCheck, formatSchemaWarning } from './startup-check.js';
import { loadAgentConfig } from './agent-config.js';
import {
  clientIp,
  hashIp,
  resolveApiTokenPrincipal,
  resolveAuthPrincipal,
  resolvePrincipal,
} from './principal.js';
import { API_TOKEN_TTL_MS } from '@jobagent/shared';
import { registerSystem, REQUIRED_COLUMNS } from './routes/system.js';
import { registerDemo } from './routes/demo.js';
import { registerAuth } from './routes/auth.js';
import { registerAnalyze } from './routes/analyze.js';
import { registerProfiles } from './routes/profiles.js';
import { registerJobPostings } from './routes/job-postings.js';
import { registerResumes } from './routes/resumes.js';
import { registerRecruiting } from './routes/recruiting.js';
import { registerAgent } from './routes/agent.js';
import { registerSearch } from './routes/search.js';
import { registerLlmRoutes } from './routes/llm.js';
import { registerClaimVerifications } from './routes/claim-verifications.js';
import { describeError } from './routes/helpers.js';
import type { RouteDeps } from './routes/context.js';
import type { ApiDeps, ApiRepos, HonoEnv } from './routes/types.js';

// 测试与外部模块仍从本文件导入这些类型，保持调用方不变。
export type { ApiDeps, ApiRepos, HonoEnv } from './routes/types.js';

/**
 * 创建 Hono 应用（可注入依赖，便于测试）。
 * 生产环境缺省走 createStorage（按 DB_DRIVER 选择方言），测试注入内存仓储。
 *
 * 注入点刻意只到 `ApiRepos`（`StorageContext` 的结构子集，直接赋值即可，不需要断言）；
 * **本函数不持有也不关闭连接**：serverless 温实例复用同一 app，关闭应在进程属主做
 * （见 `main()` 的信号处理）。
 */
export async function createApp(deps: ApiDeps = {}): Promise<Hono<HonoEnv>> {
  const repos: ApiRepos = deps.repos ?? (await createStorage());
  const now = deps.now ?? (() => new Date().toISOString());
  const cfg = deps.demoConfig ?? loadDemoConfig();
  // T27 生产启动闸：上线开关必须显式配置，缺了启动即失败（而不是运行时静默降级成 fail-open）。
  //  - CRON_SECRET 未配时 cron 端点会信任 x-vercel-cron 头（该端点能触发物理删除）；
  //  - TRUST_PROXY 未显式设置时 IP 限流基于直连地址（反向代理后全站同 IP，滑窗形同虚设）。
  if (cfg.isProduction) {
    if (!process.env.CRON_SECRET) {
      throw new Error('CRON_SECRET must be set in production (cron endpoints would otherwise trust spoofable x-vercel-cron headers)');
    }
    if (process.env.TRUST_PROXY === undefined) {
      throw new Error('TRUST_PROXY must be explicitly set in production (either true behind a reverse proxy or false)');
    }
  }
  // 简历 LLM 润色：默认按服务端 LLM_* env 构造，未配置 LLM_API_KEY 时为 null（规则版兜底，零费用）。
  const polishProvider =
    deps.resumePolish === undefined ? createResumePolishProviderFromEnv() : deps.resumePolish;
  // 求职信 LLM 生成（A 档）：同样默认关闭；未配置时端点如实返回 LLM_NOT_CONFIGURED。
  const coverLetterProvider =
    deps.coverLetter === undefined ? createCoverLetterProviderFromEnv() : deps.coverLetter;
  // DEMO_IP_SALT 缺省时进程内随机盐（重启后历史 IP 窗口失效，仅本地/实验可接受）
  const effectiveSalt = cfg.ipSalt || randomBytes(16).toString('hex');
  // 账号/OAuth（决策 #1-A/#6-A）：未配置 client id/secret 时该平台 provider=null，登录路由返回 501
  const authCfg = deps.authConfig ?? loadAuthConfig();
  const githubProvider =
    deps.githubAuthProvider === undefined
      ? authCfg.github.configured
        ? new GithubAuthProvider(authCfg.github.clientId, authCfg.github.clientSecret)
        : null
      : deps.githubAuthProvider;
  // Gitee OAuth（决策 #4 海内外同步）：与 GitHub 同构，env GITEE_OAUTH_* 缺省则 null（501）
  const giteeProvider =
    deps.giteeAuthProvider === undefined
      ? authCfg.gitee.configured
        ? new GiteeAuthProvider(authCfg.gitee.clientId, authCfg.gitee.clientSecret)
        : null
      : deps.giteeAuthProvider;
  // AUTH_STATE_SECRET 缺省时进程内随机（重启会使进行中的登录失效，仅本地/实验可接受，生产必须固定）
  const stateSecret = authCfg.stateSecret || randomBytes(32).toString('hex');

  const app = new Hono<HonoEnv>();

  // CORS：默认 '*' 保持现状（不发凭证 Cookie）；配置 CORS_ALLOW_ORIGINS 后回显具体 Origin 并允许凭证（形态 B）
  const allowOrigins = [...cfg.corsAllowOrigins];
  app.use(
    '*',
    cors({
      origin:
        allowOrigins.length > 0
          ? (origin) => (origin && allowOrigins.includes(origin) ? origin : null)
          : '*',
      // 形态 B（跨子域直连）时求职偏好用 PUT/DELETE、投递与面试用 PATCH：
      // 这三个方法原先不在允许列表里，只有同域（形态 C）能调到；这里一并放开。
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type'],
      ...(allowOrigins.length > 0 ? { credentials: true } : {}),
    }),
  );

  // Principal 全局解析：优先扩展 API Token（Authorization: Bearer <tkn->，决策 #22），
  // 其次登录用户（jobagent_session Cookie），再演示会话，再匿名；每个请求解析一次，
  // 下游 handler 只读 c.get('principal')。坏/过期 Cookie 静默降级；未知 token 回退后续解析。
  app.use('*', async (c, next) => {
    const cookieHeader = c.req.header('Cookie');
    const bearer = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
    const tokenUser = await resolveApiTokenPrincipal(
      bearer,
      repos.apiTokens,
      repos.accounts,
      now,
      API_TOKEN_TTL_MS,
    );
    if (tokenUser) {
      c.set('principal', tokenUser);
    } else {
      const user = await resolveAuthPrincipal(cookieHeader, repos.authSessions, repos.accounts, now);
      if (user) {
        c.set('principal', user);
      } else {
        c.set('principal', await resolvePrincipal(cookieHeader, repos.demoSessions, now));
      }
    }
    await next();
  });

  /** 计算当前请求的加盐 IP 哈希；无可信 IP 时返回 null（不做 IP 限流）。 */
  const ipHashOf = (c: Context): string | null => {
    const ip = clientIp(c, cfg.trustProxy);
    return ip ? hashIp(ip, effectiveSalt) : null;
  };

  // ── cron 鉴权（凭证为 CRON_SECRET，一律常量时间比较，**只认请求头**）──────────
  //   1. `Authorization: Bearer <CRON_SECRET>`——Vercel Cron 在项目配了 CRON_SECRET 时自动注入的
  //      请求头（故 vercel.json 的 cron path 无需、也不得内联 token），GitHub Actions 轮询
  //      也主动发这个头（见 .github/workflows/cron-poll.yml）；
  //   2. 未配置 CRON_SECRET：仅接受平台注入的 x-vercel-cron: 1 头（生产已由启动闸禁止）。
  //   历史形态 `?token=<CRON_SECRET>` 已于 2026-10-05 移除：URL 会把共享密钥留在访问日志、
  //   代理记录与命令行回显里。移除前两个调用方都已改发头（见 handoff item120/item121）。
  const constantTimeEquals = (value: string, expected: Buffer): boolean => {
    const got = Buffer.from(value);
    return got.length === expected.length && timingSafeEqual(got, expected);
  };
  const cronAuthorized = (c: Context): boolean => {
    const secret = process.env.CRON_SECRET;
    if (secret) {
      const expected = Buffer.from(secret);
      // 只认请求头：`?token=` 形态会把共享密钥留在 URL 里（访问日志、代理记录、
      // Actions 命令行回显），2026-10-05 起不再接受——两个调用方都已改发头。
      const bearer = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
      return constantTimeEquals(bearer, expected);
    }
    return c.req.header('x-vercel-cron') === '1';
  };

  const agentConfig = deps.agentConfig ?? loadAgentConfig();

  // LLM 供给（决策 #21）：内置目录缓存启动加载一次（表为空→代码默认目录），
  // admin 写入后显式刷新；BYOK 密钥加密钥来自 LLM_ENC_KEY（未配则 BYOK 保存 503）。
  const catalogCache = deps.llmCatalogCache ?? createCatalogCache();
  if (!deps.llmCatalogCache) {
    // 生产/未注入时从仓储预载（读库失败不致命：cache.get 走默认目录，admin refresh 可恢复）
    try {
      catalogCache.refresh(await repos.llmCatalog.listAll());
    } catch (err) {
      console.warn('[llm] catalog preload failed, using code defaults:', describeError(err));
    }
  }
  const llmEncKey = deps.llmEncKey ?? process.env.LLM_ENC_KEY ?? null;

  // 各域 router 共享的依赖包。
  const routeDeps: RouteDeps = {
    repos,
    now,
    cfg,
    authCfg,
    githubProvider,
    giteeProvider,
    catalogCache,
    llmEncKey,
    polishProvider,
    coverLetterProvider,
    stateSecret,
    agentConfig,
    agentRepos: repos,
    ipHashOf,
    cronAuthorized,
    deps,
  };

  // 按原 index.ts 的注册顺序挂载（顺序对 /profiles/by-subject、/job-postings/stats 等
  // 与参数路由的匹配优先级至关重要）。
  registerSystem(app, routeDeps);
  registerDemo(app, routeDeps);
  registerAuth(app, routeDeps);
  registerAnalyze(app, routeDeps);
  registerProfiles(app, routeDeps);
  registerJobPostings(app, routeDeps);
  registerResumes(app, routeDeps);
  registerRecruiting(app, routeDeps);
  registerAgent(app, routeDeps);
  registerSearch(app, routeDeps);
  registerLlmRoutes(app, routeDeps);
  registerClaimVerifications(app, routeDeps);

  // 404 兜底
  app.notFound((c) => {
    return c.json({ error: 'not found', path: c.req.path }, 404);
  });

  // 错误处理
  app.onError((err, c) => {
    console.error('[api] unhandled error:', JSON.stringify(describeError(err)));
    return c.json({ error: 'internal server error' }, 500);
  });

  return app;
}

// ─── 入口 ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // 服务端出站请求（GitHub OAuth token 交换/拉用户）在配置代理时走代理；未配置则无操作。
  const outboundProxy = configureOutboundProxy();
  if (outboundProxy) console.log(`[api] outbound proxy enabled: ${outboundProxy}`);
  const port = Number(process.env.PORT ?? 3000);
  // 常驻进程自己拥有连接：显式建库、显式关闭（审计 A2 —— 原先 createApp 内部建库后
  // 丢弃了 close()，独立部署的 api 进程退出时连接从不优雅释放）。
  const storage = await createStorage();
  const app = await createApp({ repos: storage });

  // T1-4 启动时 schema 自检（仅常驻进程；serverless 走 /health?deep=1）。
  // 默认只告警；SCHEMA_CHECK_STRICT=1 时缺失关键列阻断启动。
  const schemaCheck = await runStartupSchemaCheck(storage, REQUIRED_COLUMNS);
  if (!schemaCheck.ok) {
    console.error(formatSchemaWarning(schemaCheck.missing));
    if (process.env.SCHEMA_CHECK_STRICT === '1') {
      console.error('[api] SCHEMA_CHECK_STRICT=1: aborting startup; apply pending migrations first');
      await storage.close().catch(() => undefined);
      process.exit(1);
    }
  } else {
    console.log('[api] schema check: all required columns present');
  }

  // Hono 自带 serve（Node.js）
  const { serve } = await import('@hono/node-server');
  const server = serve({ fetch: app.fetch, port }, (info) => {
    console.log(`[api] JobAgent API listening on http://localhost:${info.port}`);
    console.log(`[api] Endpoints: POST /analyze, POST /demo/sessions, GET /demo/me, GET /demo/presets, POST /demo/exit, GET /auth/github/login, GET /auth/github/callback, GET /auth/gitee/login, GET /auth/gitee/callback, GET /auth/providers, POST /auth/logout, GET /auth/me, POST /profiles/:id/claim, POST /profiles/:id/unclaim, GET /jobs/:id, GET /profiles/by-subject/:platform/:login, GET /profiles/:id, GET /profiles/:id/exportable, GET /profiles/:id/job-recommendations, GET /job-postings, POST /job-postings/match, POST /resumes/build, GET /candidates, GET|POST /profiles/:id/applications, PATCH /applications/:id, POST|GET /interviews, PATCH /interviews/:id, POST|GET /profiles/:id/claim-verifications, DELETE /claim-verifications/:id, GET /health`);
  });

  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (closing) return;
      closing = true;
      console.log(`[api] ${signal} received, shutting down`);
      server.close();
      void storage
        .close()
        .catch((err: unknown) => console.error('[api] storage close failed:', JSON.stringify(describeError(err))))
        .finally(() => process.exit(0));
    });
  }
}

// 仅在直接运行时启动（被 import 时不启动）
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
