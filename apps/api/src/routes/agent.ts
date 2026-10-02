/**
 * 求职 Agent 工作台路由（Q1 单文件拆分，阶段 1「求职工作台」）。
 * 全部端点要求登录 user：偏好/任务为私有数据，画像须本人认领。
 * 阶段 1 只准备、不投递：approve 只置 approved（用户自己去 ATS 投），无对外写动作。
 * agent-tick cron 紧随其后注册（保持原 index.ts 的最后注册顺序）。
 */
import type { Context, Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import {
  AGENT_ERROR_CODES,
  AUTH_ERROR_CODES,
  JobPreferencesCreateSchema,
  JobPreferencesPatchSchema,
  JobRunApproveSchema,
  JobRunCreateSchema,
  JobRunRejectSchema,
  ResumeLocaleSchema,
  type JobSource,
  type SupportedPlatform,
} from '@jobagent/shared';
import type { StoredJobRun, StoredSubmitIntent } from '@jobagent/storage';
import {
  DEFAULT_DAILY_SUBMIT_LIMIT,
  canCancel,
  isTerminalStatus,
  remainingDailyQuota,
} from '@jobagent/agent-core';
import {
  advanceRunOnce,
  applyRunEvent,
  loadRunView,
  renderIntentCoverLetter,
  renderIntentResume,
  runAgentTickOnce,
} from '../agent-runner.js';
import {
  toIntentView,
  toPreferenceView,
  toRunView,
  toRunViewData,
} from '../agent-view.js';
import { renderHtml } from '@jobagent/resume-core';
import { describeError } from './helpers.js';
import type { HonoEnv } from './types.js';
import type { RouteDeps } from './context.js';

export function registerAgent(app: Hono<HonoEnv>, d: RouteDeps): void {
  const { repos, now, agentConfig, agentRepos, cronAuthorized } = d;

  const requireAgentUser = (
    c: Context,
  ): { accountId: string; platform: SupportedPlatform; login: string } | Response => {
    const principal = c.get('principal');
    if (principal.kind !== 'user') {
      return c.json({ error: 'authentication required', code: AUTH_ERROR_CODES.authRequired }, 401);
    }
    return principal;
  };

  /** 本人偏好：不存在与不属于本人同形 404（不泄露存在性）。 */
  const requireOwnedPreference = async (c: Context, id: string) => {
    const user = requireAgentUser(c);
    if (user instanceof Response) return user;
    const preference = await repos.jobPreferences.getById(id);
    if (!preference || preference.accountId !== user.accountId) {
      return c.json(
        { error: 'preference not found', code: AGENT_ERROR_CODES.preferenceNotFound },
        404,
      );
    }
    return preference;
  };

  const requireOwnedRun = async (c: Context, id: string): Promise<StoredJobRun | Response> => {
    const user = requireAgentUser(c);
    if (user instanceof Response) return user;
    const run = await repos.jobRuns.getById(id);
    if (!run || run.accountId !== user.accountId) {
      return c.json({ error: 'job run not found', code: AGENT_ERROR_CODES.runNotFound }, 404);
    }
    return run;
  };

  const requireOwnedIntent = async (
    c: Context,
    id: string,
  ): Promise<StoredSubmitIntent | Response> => {
    const user = requireAgentUser(c);
    if (user instanceof Response) return user;
    const intent = await repos.submitIntents.getById(id);
    if (!intent || intent.accountId !== user.accountId) {
      return c.json({ error: 'submit intent not found', code: AGENT_ERROR_CODES.intentNotFound }, 404);
    }
    return intent;
  };

  // GET /agent/preferences：本人的求职偏好集（多套）
  app.get('/agent/preferences', async (c) => {
    const user = requireAgentUser(c);
    if (user instanceof Response) return user;
    const preferences = await repos.jobPreferences.listByAccount(user.accountId);
    return c.json({ preferences: preferences.map(toPreferenceView) });
  });

  // POST /agent/preferences：新建一套偏好（目标岗位关键词至少一个）
  app.post('/agent/preferences', async (c) => {
    const user = requireAgentUser(c);
    if (user instanceof Response) return user;
    const parsed = JobPreferencesCreateSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: 'invalid preference', details: parsed.error.flatten() }, 400);
    }
    const data = parsed.data;
    const id = `pref-${randomUUID()}`;
    const nowIso = now();
    await repos.jobPreferences.insert({
      id,
      accountId: user.accountId,
      label: data.label,
      targetTitles: data.targetTitles,
      skills: data.skills ?? [],
      locations: data.locations ?? [],
      remoteOnly: data.remoteOnly ?? false,
      salaryMinUsd: data.salaryMinUsd ?? null,
      sources: data.sources ?? [],
      companyWhitelist: data.companyWhitelist ?? [],
      companyBlacklist: data.companyBlacklist ?? [],
      minTier: data.minTier ?? 'mid',
      dailySubmitLimit: data.dailySubmitLimit ?? DEFAULT_DAILY_SUBMIT_LIMIT,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    const stored = await repos.jobPreferences.getById(id);
    if (!stored) return c.json({ error: 'preference write failed' }, 500);
    return c.json({ preference: toPreferenceView(stored) }, 201);
  });

  // GET /agent/preferences/:id：单套偏好（仅本人）
  app.get('/agent/preferences/:id', async (c) => {
    const preference = await requireOwnedPreference(c, c.req.param('id') ?? '');
    if (preference instanceof Response) return preference;
    return c.json({ preference: toPreferenceView(preference) });
  });

  // PUT /agent/preferences/:id：整体替换提供的字段（至少一个）
  app.put('/agent/preferences/:id', async (c) => {
    const preference = await requireOwnedPreference(c, c.req.param('id') ?? '');
    if (preference instanceof Response) return preference;
    const parsed = JobPreferencesPatchSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: 'invalid preference patch', details: parsed.error.flatten() }, 400);
    }
    const updated = await repos.jobPreferences.update(preference.id, parsed.data, now());
    if (!updated) {
      return c.json(
        { error: 'preference not found', code: AGENT_ERROR_CODES.preferenceNotFound },
        404,
      );
    }
    return c.json({ preference: toPreferenceView(updated) });
  });

  // DELETE /agent/preferences/:id：删除偏好；仍被未结束的求职任务引用时拒绝（先取消任务）
  app.delete('/agent/preferences/:id', async (c) => {
    const preference = await requireOwnedPreference(c, c.req.param('id') ?? '');
    if (preference instanceof Response) return preference;
    const runs = await repos.jobRuns.listByAccount(preference.accountId, 200);
    const active = runs.filter(
      (run) => run.preferenceId === preference.id && !isTerminalStatus(run.status),
    );
    if (active.length > 0) {
      return c.json(
        {
          error: 'preference is used by an active job run',
          code: AGENT_ERROR_CODES.preferenceInUse,
          runIds: active.map((run) => run.id),
        },
        409,
      );
    }
    await repos.jobPreferences.delete(preference.id);
    return c.json({ ok: true });
  });

  // GET /agent/runs：本人的求职任务列表
  app.get('/agent/runs', async (c) => {
    const user = requireAgentUser(c);
    if (user instanceof Response) return user;
    const runs = await repos.jobRuns.listByAccount(user.accountId);
    return c.json({ runs: runs.map(toRunView) });
  });

  // POST /agent/runs：新建求职任务并立刻扫一轮（纯本地计算，创建即可看待投清单）
  app.post('/agent/runs', async (c) => {
    const user = requireAgentUser(c);
    if (user instanceof Response) return user;
    const parsed = JobRunCreateSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: 'invalid job run', details: parsed.error.flatten() }, 400);
    }
    const preference = await repos.jobPreferences.getById(parsed.data.preferenceId);
    if (!preference || preference.accountId !== user.accountId) {
      return c.json(
        { error: 'preference not found', code: AGENT_ERROR_CODES.preferenceNotFound },
        404,
      );
    }
    const profile = await repos.profiles.getById(parsed.data.profileId);
    if (!profile) return c.json({ error: 'profile not found' }, 404);
    // 求职任务必须挂在**本人已认领**的画像上：Agent 会读写该画像的证据与简历
    if (
      !profile.subjectClaimed ||
      profile.subjectPlatform !== user.platform ||
      profile.subjectLogin !== user.login
    ) {
      return c.json(
        {
          error: 'profile must be claimed by the signed-in account',
          code: AGENT_ERROR_CODES.profileNotOwned,
        },
        403,
      );
    }
    const id = `run-${randomUUID()}`;
    await repos.jobRuns.insert({
      id,
      accountId: user.accountId,
      profileId: parsed.data.profileId,
      preferenceId: preference.id,
      createdAt: now(),
    });
    const outcome = await advanceRunOnce({ repos: agentRepos, now, config: agentConfig }, id, 'user');
    if (!outcome.ok) {
      return c.json({ error: outcome.message, code: outcome.code }, outcome.status);
    }
    return c.json(
      { ...toRunViewData(outcome.view), ...(outcome.scan ? { scan: outcome.scan } : {}) },
      201,
    );
  });

  // GET /agent/runs/:id：任务状态 + 事件流（可回放）+ 全部票据
  app.get('/agent/runs/:id', async (c) => {
    const run = await requireOwnedRun(c, c.req.param('id') ?? '');
    if (run instanceof Response) return run;
    return c.json(toRunViewData(await loadRunView(repos, run)));
  });

  // POST /agent/runs/:id/scan：手动推进一轮（人在等工作台里不想等 cron 时用）
  app.post('/agent/runs/:id/scan', async (c) => {
    const run = await requireOwnedRun(c, c.req.param('id') ?? '');
    if (run instanceof Response) return run;
    if (isTerminalStatus(run.status)) {
      return c.json({ error: 'job run is not active', code: AGENT_ERROR_CODES.runNotActive }, 409);
    }
    const outcome = await advanceRunOnce({ repos: agentRepos, now, config: agentConfig }, run.id, 'user');
    if (!outcome.ok) {
      return c.json({ error: outcome.message, code: outcome.code }, outcome.status);
    }
    return c.json({ ...toRunViewData(outcome.view), ...(outcome.scan ? { scan: outcome.scan } : {}) });
  });

  // POST /agent/runs/:id/cancel：用户中止（非终态都可中止，审计日志留痕）
  app.post('/agent/runs/:id/cancel', async (c) => {
    const run = await requireOwnedRun(c, c.req.param('id') ?? '');
    if (run instanceof Response) return run;
    if (!canCancel(run.status)) {
      return c.json(
        { error: 'job run cannot be cancelled', code: AGENT_ERROR_CODES.invalidTransition },
        409,
      );
    }
    const cancelled = await applyRunEvent(repos, run, 'cancel', 'user', now());
    return c.json(toRunViewData(await loadRunView(repos, cancelled ?? run)));
  });

  // GET /agent/runs/:id/pending-approvals：待投清单（pending=待确认，approved=待用户自己投）
  app.get('/agent/runs/:id/pending-approvals', async (c) => {
    const run = await requireOwnedRun(c, c.req.param('id') ?? '');
    if (run instanceof Response) return run;
    const [pending, approved] = await Promise.all([
      repos.submitIntents.listByRunAndStatus(run.id, 'pending', 100),
      repos.submitIntents.listByRunAndStatus(run.id, 'approved', 100),
    ]);
    return c.json({
      runId: run.id,
      status: run.status,
      items: [...pending, ...approved].map(toIntentView),
    });
  });

  // POST /agent/runs/:id/approve：人机闸的「确认」——只把票据置 approved，投递动作由用户自己做
  app.post('/agent/runs/:id/approve', async (c) => {
    const run = await requireOwnedRun(c, c.req.param('id') ?? '');
    if (run instanceof Response) return run;
    const parsed = JobRunApproveSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: 'invalid approve request', details: parsed.error.flatten() }, 400);
    }
    if (run.status !== 'awaiting_approval') {
      return c.json(
        { error: 'job run is not awaiting approval', code: AGENT_ERROR_CODES.runNotActive },
        409,
      );
    }
    const pending = await repos.submitIntents.listByRunAndStatus(run.id, 'pending', 100);
    const byId = new Map(pending.map((intent) => [intent.id, intent]));
    const requested = parsed.data.intentIds
      .map((id) => byId.get(id))
      .filter((intent): intent is StoredSubmitIntent => Boolean(intent));
    if (requested.length === 0) {
      return c.json(
        { error: 'no pending intents to approve', code: AGENT_ERROR_CODES.nothingToApprove },
        409,
      );
    }

    // 限频闸（设计 §3.4）：按来源统计 24h 内「已确认 + 已投递」，额度不足则整批拒绝、绝不部分确认
    const preference = await repos.jobPreferences.getById(run.preferenceId);
    const limit = preference?.dailySubmitLimit ?? DEFAULT_DAILY_SUBMIT_LIMIT;
    const since = new Date(Date.parse(now()) - 24 * 60 * 60 * 1000).toISOString();
    const perSource = new Map<JobSource, number>();
    for (const intent of requested) {
      perSource.set(intent.jobSource, (perSource.get(intent.jobSource) ?? 0) + 1);
    }
    for (const [source, count] of perSource) {
      const committed = await repos.submitIntents.countCommittedBySourceSince(
        run.accountId,
        source,
        since,
      );
      if (remainingDailyQuota(committed, limit) < count) {
        return c.json(
          {
            error: 'daily submit limit reached for this source',
            code: AGENT_ERROR_CODES.dailyLimitReached,
            source,
            limit,
            committed,
            remaining: remainingDailyQuota(committed, limit),
          },
          429,
        );
      }
    }

    const approvedAt = now();
    const approved = await repos.submitIntents.approveMany(
      run.id,
      requested.map((intent) => intent.id),
      approvedAt,
    );
    const updatedRun = (await applyRunEvent(repos, run, 'approve', 'user', approvedAt)) ?? run;
    return c.json({ ...toRunViewData(await loadRunView(repos, updatedRun)), approved });
  });

  // POST /agent/runs/:id/reject：拒绝一个待投项（可带原因）；没有待办项时任务回 watching 等下一轮
  app.post('/agent/runs/:id/reject', async (c) => {
    const run = await requireOwnedRun(c, c.req.param('id') ?? '');
    if (run instanceof Response) return run;
    const parsed = JobRunRejectSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: 'invalid reject request', details: parsed.error.flatten() }, 400);
    }
    const intent = await repos.submitIntents.getById(parsed.data.intentId);
    if (!intent || intent.runId !== run.id) {
      return c.json({ error: 'submit intent not found', code: AGENT_ERROR_CODES.intentNotFound }, 404);
    }
    const rejectedAt = now();
    const rejected = await repos.submitIntents.reject(
      intent.id,
      parsed.data.reason ?? null,
      rejectedAt,
    );
    if (!rejected) {
      return c.json(
        { error: 'submit intent is not pending', code: AGENT_ERROR_CODES.nothingToApprove },
        409,
      );
    }
    const all = await repos.submitIntents.listByRun(run.id, 200);
    const open = all.filter((item) => item.status === 'pending' || item.status === 'approved');
    const nextRun =
      open.length === 0
        ? ((await applyRunEvent(repos, run, 'reject', 'user', rejectedAt)) ?? run)
        : run;
    return c.json(toRunViewData(await loadRunView(repos, nextRun)));
  });

  // POST /agent/intents/:id/mark-submitted：用户投完回来回填「已投」→ 写一条投递记录（origin=agent）并进入跟踪
  app.post('/agent/intents/:id/mark-submitted', async (c) => {
    const intent = await requireOwnedIntent(c, c.req.param('id') ?? '');
    if (intent instanceof Response) return intent;
    if (intent.status === 'submitted') {
      // 幂等：重复标记不重复写投递记录
      const run = await repos.jobRuns.getById(intent.runId);
      return c.json({
        intent: toIntentView(intent),
        applicationId: intent.applicationId,
        run: run ? toRunView(run) : null,
      });
    }
    if (intent.status !== 'pending' && intent.status !== 'approved') {
      return c.json(
        { error: 'submit intent cannot be marked submitted', code: AGENT_ERROR_CODES.invalidTransition },
        409,
      );
    }
    const submittedAt = now();
    const applicationId = `app-${randomUUID()}`;
    await repos.applications.insert({
      id: applicationId,
      profileId: intent.profileId,
      jobId: intent.jobId,
      source: intent.jobSource,
      targetTitle: intent.job.title,
      targetCompany: intent.job.company,
      targetUrl: intent.job.applyUrl ?? intent.job.sourceUrl,
      status: 'applied',
      note: null,
      origin: 'agent',
      appliedAt: submittedAt,
      createdByAccountId: intent.accountId,
      submitIntentId: intent.id,
    });
    const updated = await repos.submitIntents.markSubmitted(intent.id, submittedAt, applicationId);
    const runBefore = await repos.jobRuns.getById(intent.runId);
    let run = runBefore;
    if (runBefore) {
      const all = await repos.submitIntents.listByRun(runBefore.id, 200);
      const open = all.filter((item) => item.status === 'pending' || item.status === 'approved');
      if (open.length === 0) {
        // 待办清零 → tracking（「跟」：后续复用 applications/interviews 管道）
        run = (await applyRunEvent(repos, runBefore, 'submitted', 'user', submittedAt)) ?? runBefore;
      }
    }
    return c.json({
      intent: toIntentView(updated ?? intent),
      applicationId,
      run: run ? toRunView(run) : null,
    });
  });

  // GET /agent/intents/:id/resume：按需装配的岗位定向简历（服务端不含本地补填字段，
  // 浏览器端的下载按钮走 POST /resumes/build 带本机字段，两者同一套 render 代码）
  app.get('/agent/intents/:id/resume', async (c) => {
    const intent = await requireOwnedIntent(c, c.req.param('id') ?? '');
    if (intent instanceof Response) return intent;
    const locale = ResumeLocaleSchema.safeParse(c.req.query('locale') ?? 'zh-CN');
    if (!locale.success) return c.json({ error: 'invalid locale' }, 400);
    const format = c.req.query('format') ?? 'md';
    if (!['md', 'html', 'json'].includes(format)) {
      return c.json({ error: 'format must be one of md|html|json' }, 400);
    }
    const rendered = await renderIntentResume(repos, intent, locale.data);
    if (!rendered) {
      return c.json(
        { error: 'resume artifacts unavailable', code: AGENT_ERROR_CODES.artifactsUnavailable },
        409,
      );
    }
    if (format === 'json') {
      return c.json({ draft: rendered.draft, fromSnapshot: rendered.fromSnapshot });
    }
    if (format === 'html') {
      return c.text(renderHtml(rendered.draft, locale.data), 200, {
        'Content-Type': 'text/html; charset=utf-8',
      });
    }
    return c.text(rendered.markdown, 200, { 'Content-Type': 'text/markdown; charset=utf-8' });
  });

  // GET /agent/intents/:id/cover-letter：规则版求职信（no-fabrication，段落挂 evidenceRefs）
  app.get('/agent/intents/:id/cover-letter', async (c) => {
    const intent = await requireOwnedIntent(c, c.req.param('id') ?? '');
    if (intent instanceof Response) return intent;
    const locale = ResumeLocaleSchema.safeParse(c.req.query('locale') ?? 'zh-CN');
    if (!locale.success) return c.json({ error: 'invalid locale' }, 400);
    const format = c.req.query('format') ?? 'md';
    if (!['md', 'json'].includes(format)) {
      return c.json({ error: 'format must be one of md|json' }, 400);
    }
    const rendered = await renderIntentCoverLetter(repos, intent, locale.data);
    if (!rendered) {
      return c.json(
        { error: 'cover letter unavailable', code: AGENT_ERROR_CODES.artifactsUnavailable },
        409,
      );
    }
    if (format === 'json') {
      return c.json({ draft: rendered.draft, fromSnapshot: rendered.fromSnapshot });
    }
    return c.text(rendered.markdown, 200, { 'Content-Type': 'text/markdown; charset=utf-8' });
  });

  // GET /internal/cron/agent-tick：serverless 定时推进求职任务（工作台的主调度）
  app.get('/internal/cron/agent-tick', async (c) => {
    if (!cronAuthorized(c)) return c.json({ error: 'unauthorized' }, 401);
    try {
      const outcome = await runAgentTickOnce({ repos: agentRepos, now, config: agentConfig });
      return c.json({ ok: true, outcome });
    } catch (err) {
      console.error('[cron] agent-tick failed:', JSON.stringify(describeError(err)));
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });
}
