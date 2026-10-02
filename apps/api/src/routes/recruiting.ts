/**
 * 招聘 / 投递管道路由（Q1 单文件拆分）：
 * 企业侧人才检索（GET /candidates）、投递记录（applications）、面试计划（interviews）。
 */
import type { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import {
  AUTHENTICITY_STATUSES,
  InterviewCreateSchema,
  InterviewListQuerySchema,
  InterviewPatchSchema,
  type AuthenticityStatus,
} from '@jobagent/shared';
import type { ApplicationStatus } from '@jobagent/storage';
import {
  publicApplication,
  requireProfileOwner,
  requireRecruiter,
} from './helpers.js';
import {
  ApplicationCreateSchema,
  ApplicationPatchSchema,
  CandidateSearchQuerySchema,
  ProfileIdParamSchema,
} from './schemas.js';
import type { HonoEnv } from './types.js';
import type { RouteDeps } from './context.js';

export function registerRecruiting(app: Hono<HonoEnv>, d: RouteDeps): void {
  const { repos, now } = d;

  // ── 企业侧人才检索（筛选工作台 P-A/P-B）：只读已生成画像，不触发新采集 ──
  app.get('/candidates', async (c) => {
    // F10（#17 第一期）：人才批量检索只对已声明招聘方开放——anonymous/demo 401、
    // 已登录未声明 403；单张画像公开口径（/profiles/:id 等）不变。
    const recruiter = await requireRecruiter(c, repos.accounts);
    if (recruiter instanceof Response) return recruiter;
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
  // 隐私边界（#17-F11 / handoff item60 T03）：**认领即隐私开关**——画像一旦经本人
  // OAuth 认领，它的投递管道只对本人开放；未认领画像本身就没有可授权的主体，
  // 其结论与报告按决策 #1-A 本就是公开的，投递列表沿用公开可读，不破坏匿名链路。
  app.get('/profiles/:id/applications', async (c) => {
    const param = ProfileIdParamSchema.safeParse(c.req.param());
    if (!param.success) return c.json({ error: 'invalid profile id' }, 400);
    const profile = await repos.profiles.getById(param.data.id);
    if (!profile) return c.json({ error: 'profile not found' }, 404);
    const gate = requireProfileOwner(c, profile);
    if (gate) return gate;
    const items = await repos.applications.listByProfile(param.data.id);
    return c.json({ items: items.map(publicApplication) });
  });

  // ── 投递记录：新增（求职者在报告页/扩展记录投递动作）──
  app.post('/profiles/:id/applications', async (c) => {
    const param = ProfileIdParamSchema.safeParse(c.req.param());
    if (!param.success) return c.json({ error: 'invalid profile id' }, 400);
    const profile = await repos.profiles.getById(param.data.id);
    if (!profile) return c.json({ error: 'profile not found' }, 404);
    const gate = requireProfileOwner(c, profile);
    if (gate) return gate;

    const parsed = ApplicationCreateSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: 'invalid application', details: parsed.error.flatten() }, 400);
    }
    const data = parsed.data;
    const id = `app-${randomUUID()}`;
    const principal = c.get('principal');
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
      // 登录写入才落归属；匿名一律 null（不回改历史行，见迁移 013）
      createdByAccountId: principal.kind === 'user' ? principal.accountId : null,
    });
    const stored = await repos.applications.getById(id);
    return c.json(stored, 201);
  });

  // ── 投递记录：局部更新状态/备注/投递时间/链接（撤回用 status=withdrawn，不物理删除）──
  // 行级归属在仓储层校验：有主行只有主能改，非主返回 undefined，这里与"不存在"
  // 同形回 404（对齐 PATCH /interviews/:id 的"不泄露存在"约定）。无主行沿用现状。
  app.patch('/applications/:id', async (c) => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'invalid application id' }, 400);
    const parsed = ApplicationPatchSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: 'invalid patch', details: parsed.error.flatten() }, 400);
    }
    const principal = c.get('principal');
    const updated = await repos.applications.update(
      id,
      parsed.data,
      principal.kind === 'user' ? principal.accountId : null,
    );
    if (!updated) return c.json({ error: 'application not found' }, 404);
    return c.json(updated);
  });

  // ── 面试计划（interviews，handoff item45）：招聘方排期/流转/结果，全部要求登录、行级归属 ──

  // POST /interviews：为候选人安排面试（可关联一条投递；关联后把早期阶段投递推进到 interview）
  app.post('/interviews', async (c) => {
    // F10（#17 第一期）：面试计划写侧只对已声明招聘方开放（§8 子问题 1 已决策收紧）。
    const recruiter = await requireRecruiter(c, repos.accounts);
    if (recruiter instanceof Response) return recruiter;
    const principal = recruiter.principal;
    const parsed = InterviewCreateSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: 'invalid interview', details: parsed.error.flatten() }, 400);
    }
    const data = parsed.data;

    const profile = await repos.profiles.getById(data.profileId);
    if (!profile) return c.json({ error: 'profile not found' }, 404);

    if (data.applicationId) {
      const application = await repos.applications.getById(data.applicationId);
      if (!application) return c.json({ error: 'application not found' }, 404);
      if (application.profileId !== data.profileId) {
        return c.json({ error: 'application does not belong to the given profile' }, 400);
      }
      // 仅在投递尚处早期阶段时推进到 interview；offer/rejected/withdrawn 等终态不回退。
      // 必须传 principal.accountId 启用行级归属校验（audit S2）：已认领画像的投递归候选人
      // 本人，招聘方不跨主体改写（有主行非主时仓储返回 undefined，此处静默 no-op，面试照常
      // 创建）；只有无主行（匿名/历史写入）才被推进。
      const earlyStages: ApplicationStatus[] = ['saved', 'applied', 'viewed'];
      if (earlyStages.includes(application.status)) {
        await repos.applications.update(
          application.id,
          { status: 'interview' },
          principal.accountId,
        );
      }
    }

    const id = `int-${randomUUID()}`;
    await repos.interviews.insert({
      id,
      profileId: data.profileId,
      applicationId: data.applicationId ?? null,
      targetTitle: data.targetTitle,
      targetCompany: data.targetCompany ?? null,
      scheduledStart: data.scheduledStart,
      scheduledEnd: data.scheduledEnd,
      format: data.format,
      roundLabel: data.roundLabel,
      interviewerName: data.interviewerName ?? null,
      interviewerEmail: data.interviewerEmail ?? null,
      createdByAccountId: principal.accountId,
    });
    const stored = await repos.interviews.getById(id);
    return c.json(stored, 201);
  });

  // GET /interviews：列出当前登录账号创建的面试（可按 profileId/status 过滤，强制本人作用域）
  app.get('/interviews', async (c) => {
    // F10（#17 第一期）：面试计划读侧同样只对已声明招聘方开放。
    const recruiter = await requireRecruiter(c, repos.accounts);
    if (recruiter instanceof Response) return recruiter;
    const principal = recruiter.principal;
    const parsed = InterviewListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: 'invalid query', details: parsed.error.flatten() }, 400);
    }
    const items = await repos.interviews.listByOwner(principal.accountId, {
      ...(parsed.data.profileId ? { profileId: parsed.data.profileId } : {}),
      ...(parsed.data.status ? { status: parsed.data.status } : {}),
    });
    return c.json({ items });
  });

  // PATCH /interviews/:id：改期/状态流转/结果录入；非本人资源一律 404（不泄露存在），不物理删除
  app.patch('/interviews/:id', async (c) => {
    // F10（#17 第一期）：面试计划改期/结果录入只对已声明招聘方开放；行级 404 归属不变。
    const recruiter = await requireRecruiter(c, repos.accounts);
    if (recruiter instanceof Response) return recruiter;
    const principal = recruiter.principal;
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'invalid interview id' }, 400);
    const parsed = InterviewPatchSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: 'invalid patch', details: parsed.error.flatten() }, 400);
    }
    const existing = await repos.interviews.getById(id);
    if (!existing || existing.createdByAccountId !== principal.accountId) {
      return c.json({ error: 'interview not found' }, 404);
    }
    // 单边改期也要保证合并后的时间窗 end > start
    const nextStart = parsed.data.scheduledStart ?? existing.scheduledStart;
    const nextEnd = parsed.data.scheduledEnd ?? existing.scheduledEnd;
    if (nextEnd <= nextStart) {
      return c.json({ error: 'scheduledEnd must be after scheduledStart' }, 400);
    }
    const updated = await repos.interviews.update(id, parsed.data);
    if (!updated) return c.json({ error: 'interview not found' }, 404);
    return c.json(updated);
  });
}
