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
import { randomUUID } from 'node:crypto';
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

  // POST /agent/search：发起一次指令式全网搜岗（直接输入 或 引用预设）
  app.post('/agent/search', async (c) => {
    const user = requireUser(c);
    if (user instanceof Response) return user;
    const parsed = SearchRunCreateSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: 'invalid search request', details: parsed.error.flatten() }, 400);
    }
    const body = parsed.data;

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

    const runId = `srun-${randomUUID()}`;
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

  // GET /agent/search/:id/results：本次入库的岗位列表（run 关联列精确查询）
  app.get('/agent/search/:id/results', async (c) => {
    const run = await requireOwnedRun(c, c.req.param('id'));
    if (run instanceof Response) return run;
    const postings = await repos.jobPostings.listBySearchRun(run.runId);
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
    const presetId = `spre-${randomUUID()}`;
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
