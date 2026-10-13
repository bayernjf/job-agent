/**
 * 用量计量读侧路由（决策 #25 ④ 成本回采 Wave D，design-cost-metering-20261014 §7）。
 *
 * 两个面：
 * - `GET /account/usage`：登录用户看自己的窗口聚合，accountId 强制=当次账号，
 *   绝不接受 query 里的 accountId（anonymous/demo → 401，与 llm 路由同一闸）。
 * - `GET /admin/usage`：admin 看全平台，可按 accountId/category 再过滤
 *   （匿名 → 401，非 admin → 403，与 `/admin/llm-catalog` 同一闸）。
 *
 * 窗口护栏：sinceIso 距今不得早于 MAX_WINDOW_DAYS 天（代码常量，不加 env），
 * 超过 / 时间串不可解析一律 400。读侧只调仓储聚合口，绝无裸 SQL。
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import {
  UsageDailyRowSchema,
  UsageSummaryQuerySchema,
  UsageSummaryRowSchema,
} from '@jobagent/shared';
import type { RouteDeps } from './context.js';
import type { HonoEnv } from './types.js';
import { requireAdmin, requireUser } from './llm.js';

const BAD_REQUEST = 'BAD_REQUEST';

/** 查询窗口上限（天）：读侧护栏，防止全表扫描式拉取。 */
const MAX_WINDOW_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;

/** `/account/usage` 的 query 契约：结构上不承认 accountId（强制=当次账号）。 */
const AccountUsageQuerySchema = UsageSummaryQuerySchema.omit({ accountId: true });

const UsageResponseSchema = z.object({
  summary: z.array(UsageSummaryRowSchema),
  daily: z.array(UsageDailyRowSchema),
});

/** admin 面在按 accountId 过滤时回显过滤条件（从简，仅回显该字段）。 */
const AdminUsageResponseSchema = UsageResponseSchema.extend({
  accountId: z.string().min(1).optional(),
});

/** 可解析性 + 窗口上限校验；不合法时返回已写好的 400 Response，合法返回 null。 */
function validateWindow(
  c: Context,
  d: RouteDeps,
  query: { sinceIso: string; untilIso?: string | undefined },
): Response | null {
  const sinceMs = Date.parse(query.sinceIso);
  if (Number.isNaN(sinceMs)) {
    return c.json({ error: 'sinceIso is not a valid ISO timestamp', code: BAD_REQUEST }, 400);
  }
  if (query.untilIso !== undefined && Number.isNaN(Date.parse(query.untilIso))) {
    return c.json({ error: 'untilIso is not a valid ISO timestamp', code: BAD_REQUEST }, 400);
  }
  const earliestMs = Date.parse(d.now()) - MAX_WINDOW_DAYS * DAY_MS;
  if (sinceMs < earliestMs) {
    return c.json(
      {
        error: `sinceIso is older than the ${MAX_WINDOW_DAYS}-day window limit`,
        code: BAD_REQUEST,
      },
      400,
    );
  }
  return null;
}

export function registerUsage(app: Hono<HonoEnv>, d: RouteDeps): void {
  // 本人面：只看自己（accountId 不来自 query，强制=当次账号）
  app.get('/account/usage', async (c) => {
    const guard = await requireUser(c, d);
    if (!guard.ok) return guard.response;
    const parsed = AccountUsageQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: 'validation failed', details: parsed.error.flatten() }, 400);
    }
    const windowError = validateWindow(c, d, parsed.data);
    if (windowError) return windowError;
    const query = { ...parsed.data, accountId: guard.accountId };
    const [summary, daily] = await Promise.all([
      d.repos.usageEvents.summarize(query),
      d.repos.usageEvents.summarizeDaily(query),
    ]);
    return c.json(UsageResponseSchema.parse({ summary, daily }));
  });

  // admin 面：全平台口径，可按 accountId/category 过滤；过滤条件回显
  app.get('/admin/usage', async (c) => {
    const guard = await requireAdmin(c, d);
    if (!guard.ok) return guard.response;
    const parsed = UsageSummaryQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: 'validation failed', details: parsed.error.flatten() }, 400);
    }
    const windowError = validateWindow(c, d, parsed.data);
    if (windowError) return windowError;
    const [summary, daily] = await Promise.all([
      d.repos.usageEvents.summarize(parsed.data),
      d.repos.usageEvents.summarizeDaily(parsed.data),
    ]);
    return c.json(
      AdminUsageResponseSchema.parse({
        summary,
        daily,
        ...(parsed.data.accountId ? { accountId: parsed.data.accountId } : {}),
      }),
    );
  });
}
