/**
 * 指令式全网搜岗路由（design-websearch-job-discovery-20261008）。
 *
 * 用户面（全部要求登录 user，数据按 accountId 隔离）：
 *   POST   /agent/search              发起搜岗（直接输入 或 引用预设）
 *   GET    /agent/search/:id          任务状态 + 摘要
 *   GET    /agent/search/:id/results  本次入库的岗位列表
 *   GET    /agent/search-presets      我的筛选条件预设列表
 *   POST   /agent/search-presets      保存预设（同 query 幂等更新）
 *   DELETE /agent/search-presets/:id  删除预设（本人）
 * 内部面：
 *   GET    /internal/cron/search-tick  cron 认领并执行 queued 搜岗任务
 *
 * 意图解析：LLM fail-closed（parseSearchIntent 内部回落规则解析）；
 * P0 执行路径为确定性规则解析（LLM 增强留给 P1，注入点已预留）。
 */
import type { Context, Hono } from 'hono';
import {
  SearchPresetCreateSchema,
  SearchRunCreateSchema,
} from '@jobagent/shared';
import type { StoredSearchRun } from '@jobagent/storage';
import {
  TavilySearchClient,
  parseSearchIntent,
  runSearchTick,
} from '@jobagent/search-source';
import { describeError } from './helpers.js';
import { timeOrderedId } from '../ids.js';
import { toCsv } from '../csv.js';
import type { HonoEnv } from './types.js';
import type { RouteDeps } from './context.js';

export function registerSearch(app: Hono<HonoEnv>, d: RouteDeps): void {
  const { repos, now, cronAuthorized } = d;

  const requireUser = (c: Context): { accountId: string } | Response => {
    const principal = c.get('principal');
    if (principal.kind !== 'user') {
      return c.json({ error: 'authentication required', code: 'auth_required' }, 401);
    }
    return principal;
  };

  const requireOwnedPreset = async (c: Context, id: string) => {
    const user = requireUser(c);
    if (user instanceof Response) return user;
    const preset = await repos.searchPresets.getById(id);
    if (!preset || preset.accountId !== user.accountId) {
      return c.json({ error: 'search preset not found', code: 'search_preset_not_found' }, 404);
    }
    return preset;
  };

  const requireOwnedRun = async (c: Context, id: string): Promise<StoredSearchRun | Response> => {
    const user = requireUser(c);
    if (user instanceof Response) return user;
    const run = await repos.searchRuns.getById(id);
    if (!run || run.accountId !== user.accountId) {
      return c.json({ error: 'search run not found', code: 'search_run_not_found' }, 404);
    }
    return run;
  };

  /** 当日 UTC 0 点（每日配额窗口固定按 UTC，避免时区漂移）。 */
  const startOfTodayUtc = (): string => {
    const d = new Date();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
  };
  const dailyLimit = Number(process.env.SEARCH_DAILY_LIMIT ?? 10);

  // POST /agent/search：发起一次指令式全网搜岗（直接输入 或 引用预设）
  app.post('/agent/search', async (c) => {
    const user = requireUser(c);
    if (user instanceof Response) return user;
    const parsed = SearchRunCreateSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: 'invalid search request', details: parsed.error.flatten() }, 400);
    }
    const body = parsed.data;

    // T2-9 每日配额护栏：按账号统计 UTC 当日已创建的 run（含失败，防刷优先），
    // 超限 429；SEARCH_DAILY_LIMIT=0 显式关闭护栏（默认 10）。
    if (dailyLimit > 0) {
      const usedToday = await repos.searchRuns.countByAccountSince(
        user.accountId,
        startOfTodayUtc(),
      );
      if (usedToday >= dailyLimit) {
        return c.json(
          {
            error: 'daily search limit reached',
            code: 'search_daily_limit',
            limit: dailyLimit,
          },
          429,
        );
      }
    }

    let query: string;
    let conditions;
    if (body.presetId) {
      const preset = await repos.searchPresets.getById(body.presetId);
      if (!preset || preset.accountId !== user.accountId) {
        return c.json({ error: 'search preset not found', code: 'search_preset_not_found' }, 404);
      }
      query = preset.query;
      conditions = preset.conditions;
    } else {
      query = body.query as string;
      // 未显式给结构化条件 → 意图解析（LLM fail-closed 回落规则；P0 即规则路径）
      conditions = body.conditions ?? (await parseSearchIntent(query));
    }

    const runId = timeOrderedId('srun');
    const nowIso = now();
    await repos.searchRuns.insert({
      runId,
      accountId: user.accountId,
      presetId: body.presetId ?? null,
      query,
      conditions,
      status: 'queued',
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    return c.json({ runId, status: 'queued' }, 201);
  });

  // GET /agent/search/:id：任务状态 + 摘要
  app.get('/agent/search/:id', async (c) => {
    const run = await requireOwnedRun(c, c.req.param('id'));
    if (run instanceof Response) return run;
    return c.json({
      run: {
        runId: run.runId,
        query: run.query,
        status: run.status,
        resultsCount: run.resultsCount,
        newCount: run.newCount,
        matchedCount: run.matchedCount,
        error: run.error,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
      },
    });
  });

  // GET /agent/search/:id/results：本次入库的岗位列表（run 关联列精确查询）。
  // ?format=csv 返回 CSV 下载（T1-2 导出），默认 JSON。
  app.get('/agent/search/:id/results', async (c) => {
    const run = await requireOwnedRun(c, c.req.param('id'));
    if (run instanceof Response) return run;
    const postings = await repos.jobPostings.listBySearchRun(run.runId);
    if (c.req.query('format') === 'csv') {
      const csv = toCsv(
        ['title', 'company', 'location', 'remote', 'salaryMin', 'salaryMax', 'tags', 'sourceUrl', 'applyUrl'],
        postings.map((p) => [
          p.title,
          p.company,
          p.location,
          p.remote ? 'true' : 'false',
          p.salaryMin,
          p.salaryMax,
          p.tags.join('; '),
          p.sourceUrl,
          p.applyUrl ?? p.sourceUrl,
        ]),
      );
      return c.body(csv, 200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="search-${run.runId}.csv"`,
      });
    }
    return c.json({
      postings: postings.map((p) => ({
        id: p.id,
        title: p.title,
        company: p.company,
        location: p.location,
        remote: p.remote,
        salaryMin: p.salaryMin,
        salaryMax: p.salaryMax,
        tags: p.tags,
        sourceUrl: p.sourceUrl,
        applyUrl: p.applyUrl ?? p.sourceUrl,
        description: p.description,
        postedAt: p.postedAt,
      })),
    });
  });

  // GET /agent/search-presets：我的筛选条件预设列表
  app.get('/agent/search-presets', async (c) => {
    const user = requireUser(c);
    if (user instanceof Response) return user;
    const presets = await repos.searchPresets.listByAccount(user.accountId);
    return c.json({
      presets: presets.map((p) => ({
        presetId: p.presetId,
        title: p.title,
        query: p.query,
        conditions: p.conditions,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      })),
    });
  });

  // POST /agent/search-presets：保存预设（同 query 幂等更新）
  app.post('/agent/search-presets', async (c) => {
    const user = requireUser(c);
    if (user instanceof Response) return user;
    const parsed = SearchPresetCreateSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: 'invalid search preset', details: parsed.error.flatten() }, 400);
    }
    const body = parsed.data;
    const conditions = body.conditions ?? (await parseSearchIntent(body.query));
    const presetId = timeOrderedId('spre');
    const nowIso = now();
    await repos.searchPresets.upsert({
      presetId,
      accountId: user.accountId,
      title: body.title ?? null,
      query: body.query,
      conditions,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    const saved = await repos.searchPresets.getById(presetId);
    return c.json({ preset: saved }, 201);
  });

  // DELETE /agent/search-presets/:id：删除预设（本人）
  app.delete('/agent/search-presets/:id', async (c) => {
    const preset = await requireOwnedPreset(c, c.req.param('id'));
    if (preset instanceof Response) return preset;
    await repos.searchPresets.delete(preset.presetId);
    return c.json({ ok: true });
  });

  // GET /agent/search：我的搜岗历史列表（发起记录，倒序）
  app.get('/agent/search', async (c) => {
    const user = requireUser(c);
    if (user instanceof Response) return user;
    const runs = await repos.searchRuns.listByAccount(user.accountId);
    return c.json({
      runs: runs.map((r) => ({
        runId: r.runId,
        presetId: r.presetId,
        query: r.query,
        status: r.status,
        resultsCount: r.resultsCount,
        newCount: r.newCount,
        matchedCount: r.matchedCount,
        error: r.error,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
    });
  });

  // DELETE /agent/search-presets：清空我的全部预设（不带 id；带 id 走单删）
  app.delete('/agent/search-presets', async (c) => {
    const user = requireUser(c);
    if (user instanceof Response) return user;
    const deleted = await repos.searchPresets.deleteAllByAccount(user.accountId);
    return c.json({ ok: true, deleted });
  });

  // DELETE /agent/search-runs/:id：删除单条搜岗历史（本人；不删共享岗位池）
  app.delete('/agent/search-runs/:id', async (c) => {
    const run = await requireOwnedRun(c, c.req.param('id'));
    if (run instanceof Response) return run;
    await repos.searchRuns.delete(run.runId);
    return c.json({ ok: true });
  });

  // DELETE /agent/search-runs：清空我的全部搜岗历史（不删共享岗位池）
  app.delete('/agent/search-runs', async (c) => {
    const user = requireUser(c);
    if (user instanceof Response) return user;
    const deleted = await repos.searchRuns.deleteAllByAccount(user.accountId);
    return c.json({ ok: true, deleted });
  });

  // GET /internal/cron/search-tick：cron 认领并执行 queued 搜岗任务（serverless）
  app.get('/internal/cron/search-tick', async (c) => {
    if (!cronAuthorized(c)) return c.json({ error: 'unauthorized' }, 401);
    const started = now();
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) {
      await repos.cronHeartbeat.recordFailure(
        'search-tick',
        started,
        'TAVILY_API_KEY not configured',
      );
      return c.json({ ok: false, error: 'TAVILY_API_KEY not configured' }, 503);
    }
    try {
      const outcome = await runSearchTick({
        searchRuns: repos.searchRuns,
        jobPostings: repos.jobPostings,
        searchClient: new TavilySearchClient({ apiKey }),
        now,
      });
      await repos.cronHeartbeat.recordSuccess(
        'search-tick',
        started,
        `advanced=${outcome.advanced},failed=${outcome.failed}`,
      );
      return c.json({ ok: true, outcome });
    } catch (err) {
      console.error('[cron] search-tick failed:', JSON.stringify(describeError(err)));
      await repos.cronHeartbeat.recordFailure('search-tick', started, (err as Error).message);
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });
}
