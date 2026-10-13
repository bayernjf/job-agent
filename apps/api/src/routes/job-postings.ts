/**
 * 职位聚合路由（Q1 单文件拆分，P2-D）：检索 / 统计 / 单条 / 画像匹配。
 * 注册顺序关键：stats 必须在 :id 前。
 * 注意：/jobs/:id 已被分析任务占用，岗位端点统一用 /job-postings。
 */
import type { Hono } from 'hono';
import {
  DEMO_ERROR_CODES,
  JobSourceSchema,
  type JobSource,
  type SkillTag,
} from '@jobagent/shared';
import type { StoredEvidence } from '@jobagent/storage';
import { excludeAndMergeMatches, matchJobs, parseStaleDays, staleCutoffIso } from '@jobagent/job-source';
import { oneHourAgo } from '../demo-config.js';
import {
  buildSkillReasons,
  collectEvidence,
  skillTagMap,
} from '../match-explain.js';
import { isProfileOwner, requireRecruiter } from './helpers.js';
import {
  JobMatchRequestSchema,
  JobSearchQuerySchema,
  RecruiterPostingInputSchema,
} from './schemas.js';
import type { HonoEnv } from './types.js';
import type { RouteDeps } from './context.js';

/** 单个招聘方同时在册的自建 JD 上限（写侧唯一的数量闸）。 */
const RECRUITER_MAX_ACTIVE_POSTINGS = 50;

export function registerJobPostings(app: Hono<HonoEnv>, d: RouteDeps): void {
  const { repos, now, cfg, ipHashOf, jobStaleDays } = d;

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

  // ── 招聘方自建 JD（决策 #25，B3-a 最小子集，2026-10-13）────────────────────
  // 私有岗位：归属列 created_by_account_id 非 NULL，仓储层的每次公开池读取都排除它
  // （见 packages/storage job-postings-repo 的 search/countBySource/markStale）。
  // 静态路径 /recruiter 必须注册在 /:id 之前，与 stats 同一条顺序纪律。

  // POST /job-postings/recruiter：发布一条自建 JD
  app.post('/job-postings/recruiter', async (c) => {
    const recruiter = await requireRecruiter(c, repos.accounts);
    if (recruiter instanceof Response) return recruiter;
    const accountId = recruiter.principal.accountId;
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const parsed = RecruiterPostingInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'validation failed', details: parsed.error.flatten() }, 400);
    }
    // 唯一的写侧节流：这条路径只对流量的已声明招聘方开放，没有别的配额闸，
    // 所以兜住单账号在册岗位数量，避免岗位表被一个账号灌满。
    const active = await repos.jobPostings.listOwned(accountId, {
      status: 'active',
      limit: RECRUITER_MAX_ACTIVE_POSTINGS + 1,
    });
    if (active.length >= RECRUITER_MAX_ACTIVE_POSTINGS) {
      return c.json(
        {
          error: `too many active postings (max ${RECRUITER_MAX_ACTIVE_POSTINGS})`,
          code: 'TOO_MANY_POSTINGS',
        },
        429,
      );
    }
    const stamp = now();
    const posting = await repos.jobPostings.insertOwned(
      {
        ...parsed.data,
        tags: [...new Set(parsed.data.tags)], // 归一：去空白差异后的重复标签不重复计分
        createdByAccountId: accountId,
        postedAt: stamp,
        fetchedAt: stamp,
      },
      stamp,
    );
    return c.json(posting, 201);
  });

  // GET /job-postings/recruiter：我的岗位（含已下线）
  app.get('/job-postings/recruiter', async (c) => {
    const recruiter = await requireRecruiter(c, repos.accounts);
    if (recruiter instanceof Response) return recruiter;
    const limitRaw = c.req.query('limit');
    const offsetRaw = c.req.query('offset');
    const limit = limitRaw ? Number(limitRaw) : undefined;
    const offset = offsetRaw ? Number(offsetRaw) : 0;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
      return c.json({ error: 'limit must be an integer between 1 and 100' }, 400);
    }
    if (!Number.isInteger(offset) || offset < 0) {
      return c.json({ error: 'offset must be a non-negative integer' }, 400);
    }
    const items = await repos.jobPostings.listOwned(recruiter.principal.accountId, {
      limit,
      offset,
    });
    return c.json({ items, limit: limit ?? 100, offset });
  });

  // DELETE /job-postings/recruiter/:id：下线自己发布的岗位（软下线为 inactive）
  app.delete('/job-postings/recruiter/:id', async (c) => {
    const recruiter = await requireRecruiter(c, repos.accounts);
    if (recruiter instanceof Response) return recruiter;
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'invalid job posting id' }, 400);
    const retired = await repos.jobPostings.retireOwned(
      id,
      recruiter.principal.accountId,
      now(),
    );
    // 非本人或不存在都是 404：不告诉调用方"这条岗位存在但属于别人"。
    if (!retired) return c.json({ error: 'job posting not found' }, 404);
    return c.json(retired);
  });

  // GET /job-postings/stats：按源统计（须在 :id 路由之前注册，避免 stats 被当成 id）
  app.get('/job-postings/stats', async (c) => {
    // T24①：active 只统计 last_seen_at 在新鲜窗口内的岗位（JOB_STALE_DAYS 默认 7），
    // 未跑 markStale 的过期行不再冒充 active——避免"active=2303/inactive=0"的假繁荣。
    // 窗口算法与推荐口/匹配口共用 job-source 的单一实现，两口径不会再分叉。
    const staleDays = parseStaleDays(process.env.JOB_STALE_DAYS, jobStaleDays);
    const cutoff = staleCutoffIso(staleDays, new Date(now()));
    const activeBySource = await repos.jobPostings.countActiveFresh(cutoff);
    // 保持 active 为数字（原契约形状）：只统计新鲜窗口内的 active 行
    const active = Object.values(activeBySource).reduce((sum, n) => sum + n, 0);
    const inactive = Object.values(await repos.jobPostings.countBySource('inactive')).reduce(
      (sum, n) => sum + n,
      0,
    );
    return c.json({ active, inactive, staleAfterDays: staleDays, cutoffIso: cutoff });
  });

  // GET /job-postings/:id：单条岗位
  app.get('/job-postings/:id', async (c) => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'invalid job posting id' }, 400);
    const posting = await repos.jobPostings.getById(id);
    if (!posting) return c.json({ error: 'job posting not found' }, 404);
    // 私有 JD 只对本人可读：别人的 id 命中也回 404。派生 id 不出现在任何公开列表，
    // 但"墙只画在页面上不等于访问控制"——单条读取口同样要收口。
    if (posting.createdByAccountId) {
      const principal = c.get('principal');
      if (principal.kind !== 'user' || principal.accountId !== posting.createdByAccountId) {
        return c.json({ error: 'job posting not found' }, 404);
      }
    }
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
      // 匹配口服务于"要不要投这一条"，已关闭的岗位不该参与打分
      seenAfter: staleCutoffIso(jobStaleDays, new Date(now())),
      limit: m.candidateLimit ?? 500,
      orderBy: 'posted_desc',
    });
    // limit 只控制分页（slice），不截断匹配——否则 total 会随页大小变化
    const matches = matchJobs(candidates, {
      skills,
      remote: m.remote,
      salaryMinUsd: m.salaryMinUsd,
      sources: m.sources,
      keyword: m.keyword,
    });
    // T20：剔除已保存/已投（画像属主登录时）、跨源同岗位合并、offset 翻页
    let excludeJobIds: Set<string> | undefined;
    if (m.profileId) {
      const matchPrincipal = c.get('principal');
      if (matchPrincipal.kind === 'user') {
        const profileForExclude = await repos.profiles.getById(m.profileId);
        if (profileForExclude && isProfileOwner(c, profileForExclude)) {
          const apps = await repos.applications.listByProfile(m.profileId);
          const ids = new Set<string>();
          for (const a of apps) if (a.jobId) ids.add(a.jobId);
          if (ids.size > 0) excludeJobIds = ids;
        }
      }
    }
    const deduped = excludeAndMergeMatches(matches, { excludeJobIds });
    const page = deduped.items.slice(m.offset ?? 0, (m.offset ?? 0) + (m.limit ?? 50));
    const serialized = page.map(({ match: x, alternateSources }) => {
      const skillReasons = buildSkillReasons(x, tags);
      const base = {
        score: x.score,
        matchedSkills: x.matchedSkills,
        fieldScores: x.fieldScores,
        skillHits: x.skillHits,
        posting: x.posting,
        alternateSources,
      };
      return skillReasons ? { ...base, skillReasons } : base;
    });
    const allReasons = serialized.flatMap((x) => ('skillReasons' in x ? x.skillReasons : []));
    // match 保持公开可用；demo 调用做 IP 滑窗限流 + 会话观测计数（T27：接上 matchRatePerHour 死旋钮）
    const matchPrincipal = c.get('principal');
    if (matchPrincipal.kind === 'demo') {
      const matchNow = now();
      const matchIpHash = ipHashOf(c);
      if (matchIpHash) {
        const recentMatch = await repos.demoSessions.countRateEvents(
          matchIpHash,
          'match',
          oneHourAgo(matchNow),
        );
        if (recentMatch >= cfg.matchRatePerHour) {
          console.info(`[match] result=blocked reason=ip_rate_limited`);
          return c.json(
            {
              error: 'demo match rate limit exceeded',
              code: DEMO_ERROR_CODES.rateLimited,
              bucket: 'match',
              retryAfterSeconds: 3600,
            },
            429,
          );
        }
      }
      await repos.demoSessions.incrementMatch(matchPrincipal.sessionId, now());
    }
    return c.json({
      matches: serialized,
      total: deduped.items.length,
      excludedCount: deduped.excludedCount,
      mergedCount: deduped.mergedCount,
      offset: m.offset ?? 0,
      ...(m.profileId ? { profileSkills: skills } : {}),
      ...(tags ? { evidence: collectEvidence(allReasons, evidenceRows) } : {}),
    });
  });
}
