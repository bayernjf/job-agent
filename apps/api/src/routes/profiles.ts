/**
 * 画像路由（Q1 单文件拆分）：主体解析、快照查询、认领/解绑/删除、按主体撤回、岗位推荐。
 * 注册顺序关键：by-subject 必须在 :id 前；各 :id 子路由按原顺序。
 */
import type { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AUTH_ERROR_CODES,
  DEMO_ERROR_CODES,
  JobSourceSchema,
  toExportableProfile,
  type ClaimResult,
  type JobSource,
  type SkillTag,
  type UnclaimResult,
} from '@jobagent/shared';
import type { StoredEvidence } from '@jobagent/storage';
import { excludeAndMergeMatches, matchJobs } from '@jobagent/job-source';
import { oneHourAgo } from '../demo-config.js';
import {
  buildSkillReasons,
  collectEvidence,
  skillTagMap,
} from '../match-explain.js';
import { formatProfile, requireProfileOwner } from './helpers.js';
import {
  ProfileIdParamSchema,
  RemovalRequestBodySchema,
  SubjectLookupParamSchema,
} from './schemas.js';
import type { HonoEnv } from './types.js';
import type { RouteDeps } from './context.js';

export function registerProfiles(app: Hono<HonoEnv>, d: RouteDeps): void {
  const { repos, now, cfg, ipHashOf } = d;

  // GET /profiles/by-subject/:platform/:login：公开只读解析某主体最新 complete 画像。
  // 与 POST /analyze 的缓存命中不同，这里不看 24h TTL、不扣配额、不触发新分析、任何身份放行——
  // 画像快照本就永久可分享（GET /profiles/:id 与 /exportable 公开）。仅返回 profileId 指针，
  // 扩展据此再走公开 exportable 投影，避免在登录名维度重复暴露画像内容。
  // 必须注册在 GET /profiles/:id 之前，否则 'by-subject' 会被当作 :id。
  app.get('/profiles/by-subject/:platform/:login', async (c) => {
    const parsed = SubjectLookupParamSchema.safeParse(c.req.param());
    if (!parsed.success) {
      return c.json({ error: 'invalid platform or login' }, 400);
    }
    const { platform, login } = parsed.data;
    // IP 滑窗兜底：端点任何身份放行，唯一风险是拿不同 login 做字典枚举（探测哪些
    // 主体已有画像）。与 demo 限流同机制（不设会话硬配额，只按 IP 计数防刷）。
    const subjectNow = now();
    const subjectIpHash = ipHashOf(c);
    if (subjectIpHash) {
      const recentSubject = await repos.demoSessions.countRateEvents(
        subjectIpHash,
        'subject',
        oneHourAgo(subjectNow),
      );
      if (recentSubject >= cfg.subjectRatePerHour) {
        console.info(`[subject] result=blocked reason=ip_rate_limited platform=${platform}`);
        return c.json(
          {
            error: 'subject lookup rate limit exceeded',
            code: DEMO_ERROR_CODES.rateLimited,
            bucket: 'subject',
            retryAfterSeconds: 3600,
          },
          429,
        );
      }
      await repos.demoSessions.insertRateEvent(subjectIpHash, 'subject', subjectNow);
    }
    const latest = await repos.profiles.latestBySubject(platform, login);
    // T25：partial 也视为可用（L1 失败/限频降级的 L0-only 画像仍可看报告页，
    // 扩展一键填充依赖此解析；页面会标注"部分数据"）。只有 error/不存在/已挂起才 404。
    // S3 软挂起：有未决移除申请的画像不再被主体解析分发（按主体撤回处理中）。
    if (
      latest &&
      (latest.status === 'complete' || latest.status === 'partial') &&
      !latest.removalRequestedAt
    ) {
      return c.json({
        profileId: latest.id,
        status: latest.status,
        cached: true,
        analyzerVersion: latest.analyzerVersion,
        updatedAt: latest.updatedAt,
      });
    }
    return c.json({ error: 'no complete or partial profile for subject', code: 'PROFILE_NOT_FOUND' }, 404);
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

  // POST /profiles/:id/claim：登录用户认领"平台登录名与自己一致"的画像（决策 #1-A/#6-A）
  app.post('/profiles/:id/claim', async (c) => {
    const principal = c.get('principal');
    if (principal.kind !== 'user') {
      return c.json(
        { error: 'authentication required', code: AUTH_ERROR_CODES.authRequired },
        401,
      );
    }
    const parsed = ProfileIdParamSchema.safeParse(c.req.param());
    if (!parsed.success) return c.json({ error: 'invalid profile id' }, 400);

    const profile = await repos.profiles.getById(parsed.data.id);
    if (!profile) {
      return c.json({ error: 'profile not found', code: AUTH_ERROR_CODES.profileNotFound }, 404);
    }
    // 融合画像（subjectPlatform='all'，按同一 login 双采 GitHub/Gitee）：
    // 任一源命中即可认领——GitHub 或 Gitee 登录用户，login 与主源一致即放行。
    const subjectMatches =
      profile.subjectPlatform === 'all'
        ? profile.subjectLogin === principal.login
        : profile.subjectPlatform === principal.platform && profile.subjectLogin === principal.login;
    if (!subjectMatches) {
      return c.json(
        {
          error: 'profile does not belong to the authenticated account',
          code: AUTH_ERROR_CODES.notProfileOwner,
          subject: { platform: profile.subjectPlatform, login: profile.subjectLogin },
        },
        403,
      );
    }

    await repos.profiles.markClaimed(profile.id);
    const account = await repos.accounts.setClaimedProfile(principal.accountId, profile.id);
    // subjectPlatform 存储层为 string；语义上只可能是 github/gitee/all，此处收窄供契约使用
    const subjectPlatform = profile.subjectPlatform as 'github' | 'gitee' | 'all';
    const result: ClaimResult = {
      profileId: profile.id,
      claimed: true,
      subject: { platform: subjectPlatform, login: profile.subjectLogin },
      claimedProfileId: account?.claimedProfileId ?? profile.id,
    };
    return c.json(result);
  });

  // POST /profiles/:id/unclaim：登录用户解除本人画像认领（PRD F8「可解绑」的非破坏版本）。
  // 与 DELETE 不同：只把 subject_claimed 翻回 false、清空账号 claimed_profile_id，
  // 画像/证据/投递/面试与分享链接全部保留，画像退回公开只读态；再次 claim 即可恢复。
  // 归属判定与 claim 同口径：融合画像任一源 login 一致即放行。
  app.post('/profiles/:id/unclaim', async (c) => {
    const principal = c.get('principal');
    if (principal.kind !== 'user') {
      return c.json(
        { error: 'authentication required', code: AUTH_ERROR_CODES.authRequired },
        401,
      );
    }
    const parsed = ProfileIdParamSchema.safeParse(c.req.param());
    if (!parsed.success) return c.json({ error: 'invalid profile id' }, 400);

    const profile = await repos.profiles.getById(parsed.data.id);
    if (!profile) {
      return c.json({ error: 'profile not found', code: AUTH_ERROR_CODES.profileNotFound }, 404);
    }
    const subjectMatches =
      profile.subjectPlatform === 'all'
        ? profile.subjectLogin === principal.login
        : profile.subjectPlatform === principal.platform && profile.subjectLogin === principal.login;
    if (!subjectMatches) {
      return c.json(
        {
          error: 'profile does not belong to the authenticated account',
          code: AUTH_ERROR_CODES.notProfileOwner,
          subject: { platform: profile.subjectPlatform, login: profile.subjectLogin },
        },
        403,
      );
    }

    // 幂等：未认领也允许调用（结果即解绑态），不报错。
    await repos.profiles.unmarkClaimed(profile.id);
    // 只有账号当前确实指向该画像时才清空，避免解绑别人/旧归属时误清当前指针。
    const account = await repos.accounts.getById(principal.accountId);
    let claimedProfileId: string | null = account?.claimedProfileId ?? null;
    if (account && account.claimedProfileId === profile.id) {
      const cleared = await repos.accounts.clearClaimedProfile(principal.accountId);
      claimedProfileId = cleared?.claimedProfileId ?? null;
    }
    const subjectPlatform = profile.subjectPlatform as 'github' | 'gitee' | 'all';
    const result: UnclaimResult = {
      profileId: profile.id,
      claimed: false,
      subject: { platform: subjectPlatform, login: profile.subjectLogin },
      claimedProfileId,
    };
    return c.json(result);
  });

  // DELETE /profiles/:id：登录本人删除自己已认领的画像（B2 自助解绑，兑现 PRD:230「可解绑」）。
  // 仅已认领且平台登录名与本人一致的画像可删；未认领（无归属关系）一律 403，未登录 401。
  // 级联：evidence → applications → interviews → 撤销认领（accounts.claimed_profile_id 置空）→ 删画像行；
  // 删除后分享链指向 /report/<id> 自然 404，账号本身保留（仍可登录）。
  app.delete('/profiles/:id', async (c) => {
    const principal = c.get('principal');
    if (principal.kind !== 'user') {
      return c.json(
        { error: 'authentication required', code: AUTH_ERROR_CODES.authRequired },
        401,
      );
    }
    const parsed = ProfileIdParamSchema.safeParse(c.req.param());
    if (!parsed.success) return c.json({ error: 'invalid profile id' }, 400);

    const profile = await repos.profiles.getById(parsed.data.id);
    if (!profile) {
      return c.json({ error: 'profile not found', code: AUTH_ERROR_CODES.profileNotFound }, 404);
    }
    if (!profile.subjectClaimed) {
      // 未认领画像没有「本人」可验证：不允许自助删除（也不区分 403/404 语义，统一拒）。
      // 数据主体如需撤回，走公开申请通道 POST /profiles/:id/removal-request（S3 按主体撤回）。
      return c.json(
        {
          error: 'profile is not claimed; claim it first, or file a removal request via POST /profiles/:id/removal-request',
          code: AUTH_ERROR_CODES.notProfileOwner,
        },
        403,
      );
    }
    // 归属判定与 claim 端点同口径：融合画像任一源 login 一致即放行
    const subjectMatches =
      profile.subjectPlatform === 'all'
        ? profile.subjectLogin === principal.login
        : profile.subjectPlatform === principal.platform && profile.subjectLogin === principal.login;
    if (!subjectMatches) {
      return c.json(
        {
          error: 'not the profile owner',
          code: AUTH_ERROR_CODES.notProfileOwner,
          subject: { platform: profile.subjectPlatform, login: profile.subjectLogin },
        },
        403,
      );
    }

    // 先删子表（证据/投递/面试），再撤销认领，最后删主表——分享链与「我的」页归属一并失效
    await repos.evidence.deleteByProfile(profile.id);
    await repos.applications.deleteByProfile(profile.id);
    await repos.interviews.deleteByProfile(profile.id);
    await repos.accounts.clearClaimedProfile(principal.accountId);
    const existed = await repos.profiles.deleteById(profile.id);
    return c.json({ deleted: existed, profileId: profile.id });
  });

  // POST /profiles/:id/removal-request：按主体撤回的公开申请通道（审计 S3）。
  // 未认领画像分享链无法由本人自助撤销（DELETE 只对认领本人开放），数据主体又不可被服务端
  // 证明身份，故开放「提交申请 + 人工复核」：申请只留痕（理由/联系方式/IP 哈希），由运营在
  // CLI 复核后批准（级联删除）或驳回。提交即把画像置软挂起（removal_requested_at），
  // 不再被 by-subject 解析与人才库分发；复核批准后才整行删除。幂等：已有 pending 申请直接返回。
  // 端点任何身份放行（匿名即可提交），唯一约束是 IP 滑窗防刷。
  app.post('/profiles/:id/removal-request', async (c) => {
    const parsedId = ProfileIdParamSchema.safeParse(c.req.param());
    if (!parsedId.success) return c.json({ error: 'invalid profile id' }, 400);
    const profileId = parsedId.data.id;

    const profile = await repos.profiles.getById(profileId);
    if (!profile) {
      return c.json({ error: 'profile not found', code: 'PROFILE_NOT_FOUND' }, 404);
    }

    // 幂等：已有 pending 申请则直接返回，不重复提单、不重复计数
    const existing = await repos.profileRemovalRequests.latestPendingByProfile(profileId);
    if (existing) {
      return c.json(
        { requestId: existing.id, profileId, status: 'pending', idempotent: true },
        200,
      );
    }

    // IP 滑窗防刷（与 demo 限流同机制，不设会话硬配额，只按 IP 计数）
    const nowIso = now();
    const ipHash = ipHashOf(c);
    if (ipHash) {
      const recent = await repos.demoSessions.countRateEvents(
        ipHash,
        'removal',
        oneHourAgo(nowIso),
      );
      if (recent >= cfg.removalRatePerHour) {
        console.info(`[removal-request] result=blocked reason=ip_rate_limited profile=${profileId}`);
        return c.json(
          {
            error: 'removal request rate limit exceeded',
            code: DEMO_ERROR_CODES.rateLimited,
            bucket: 'removal',
            retryAfterSeconds: 3600,
          },
          429,
        );
      }
    }

    let body: z.infer<typeof RemovalRequestBodySchema> = {};
    try {
      const raw = await c.req.json().catch(() => ({}));
      const parsed = RemovalRequestBodySchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid request body', details: parsed.error.flatten() }, 400);
      }
      body = parsed.data;
    } catch {
      // 无 body 视为空申请，仍接受
    }

    const requestId = `rem-${randomUUID()}`;
    await repos.profileRemovalRequests.insert({
      id: requestId,
      profileId,
      status: 'pending',
      reason: body.reason ?? null,
      contact: body.contact ?? null,
      ipHash,
      createdAt: nowIso,
    });
    // 置软挂起（仅当尚未置位，避免覆盖更早时间）
    if (!profile.removalRequestedAt) {
      await repos.profiles.setRemovalRequestedAt(profileId, nowIso);
    }
    if (ipHash) await repos.demoSessions.insertRateEvent(ipHash, 'removal', nowIso);

    console.info(`[removal-request] result=queued profile=${profileId} request=${requestId}`);
    return c.json({ requestId, profileId, status: 'pending' }, 202);
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
    // T20 翻页：跳过前 offset 条去重后的匹配
    let offset = 0;
    if (q.offset !== undefined) {
      const n = Number(q.offset);
      if (!Number.isInteger(n) || n < 0) return c.json({ error: 'offset must be a non-negative integer' }, 400);
      offset = n;
    }
    // T20 关键词：title/tags/description 任一包含（子串，归一化后比较）
    let keyword: string | undefined;
    if (q.keyword !== undefined) {
      keyword = String(q.keyword).trim();
      if (keyword.length === 0) keyword = undefined;
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
    // limit 只控制分页（slice），不截断匹配——否则 total 会随页大小变化
    const matches = matchJobs(candidates, {
      skills,
      remote,
      salaryMinUsd,
      sources,
      keyword,
    });
    // T20：剔除已保存/已投（仅画像属主登录时能读投递；匿名无本人上下文不剔除），
    // 跨源同岗位合并（同 company+title 只留 score 最高者）。
    const principal = c.get('principal');
    let excludeJobIds: Set<string> | undefined;
    if (principal.kind === 'user') {
      const owner = requireProfileOwner(c, profile);
      if (!owner) {
        const apps = await repos.applications.listByProfile(parsed.data.id);
        const ids = new Set<string>();
        for (const a of apps) if (a.jobId) ids.add(a.jobId);
        if (ids.size > 0) excludeJobIds = ids;
      }
    }
    const deduped = excludeAndMergeMatches(matches, { excludeJobIds });
    const page = deduped.items.slice(offset, offset + limit);
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
    return c.json({
      profileId: parsed.data.id,
      profileSkills: skills,
      matches: serialized,
      evidence: collectEvidence(allReasons, evidenceRows),
      total: deduped.items.length,
      excludedCount: deduped.excludedCount,
      mergedCount: deduped.mergedCount,
      offset,
      candidatePool: candidates.length,
    });
  });
}
