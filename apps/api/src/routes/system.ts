/**
 * 系统路由：健康检查 + 分析/清理 cron（Q1 单文件拆分）。
 * agent-tick 依赖求职 Agent 装配，放在 agent.ts 末尾以保持原注册顺序。
 */
import type { Hono } from 'hono';
import { runProcessJobOnce, runMaintenance, type MaintenanceTask } from '../cron-jobs.js';
import { describeError } from './helpers.js';
import type { HonoEnv } from './types.js';
import type { RouteDeps } from './context.js';

export function registerSystem(app: Hono<HonoEnv>, d: RouteDeps): void {
  const { repos, now, deps, cronAuthorized } = d;

  // 健康检查：浅检查（默认）不依赖 DB，恒定返回进程存活；
  // ?deep=1（或 ?deep=true）额外执行一次持久化层 SELECT 1 往返，DB 不可达时返回 503，
  // 供部署后 smoke / 监控探活区分"进程在但数据库挂了"。
  app.get('/health', async (c) => {
    const base = {
      status: 'ok' as const,
      service: 'jobagent-api',
      time: new Date().toISOString(),
    };
    const deep = c.req.query('deep');
    if (deep !== '1' && deep !== 'true') {
      return c.json(base);
    }
    const started = Date.now();
    try {
      await repos.ping();
      return c.json({ ...base, db: 'ok', dbLatencyMs: Date.now() - started });
    } catch (err) {
      return c.json(
        {
          status: 'error',
          service: 'jobagent-api',
          time: new Date().toISOString(),
          db: 'unreachable',
          error: (err as Error).message,
        },
        503,
      );
    }
  });

  // ── 内部定时任务（serverless 部署由 Vercel Cron 调用；常驻部署不用这两条）────────
  //
  // 鉴权（凭证为 CRON_SECRET，一律常量时间比较，**只认请求头**）：
  //   1. `Authorization: Bearer <CRON_SECRET>`——Vercel Cron 配了 CRON_SECRET 时自动注入，
  //      GitHub Actions 轮询也发这个头（见 .github/workflows/cron-poll.yml），故 vercel.json
  //      的 cron path 无需（也不得）内联 token；
  //   2. 未配置 CRON_SECRET：仅接受平台注入的 x-vercel-cron: 1 头（生产已由启动闸禁止）。
  //   历史形态 `?token=<CRON_SECRET>` 已于 2026-10-05 停用：URL 里的共享密钥会留在访问日志、
  //   代理记录与命令行回显里；停用前已实查两个调用方都改发请求头（默认分支那份 workflow 里
  //   `?token=` 命中 0 处，并手动派发一次 run 在生产读到 `Queue idle`）。

  // GET /internal/cron/process-job：认领并处理至多一个分析任务（含僵尸回收/demo 并发闸）
  app.get('/internal/cron/process-job', async (c) => {
    if (!cronAuthorized(c)) return c.json({ error: 'unauthorized' }, 401);
    try {
      const processOnce = deps.processJobOnce ?? (() => runProcessJobOnce());
      const outcome = await processOnce();
      return c.json({ ok: true, outcome });
    } catch (err) {
      // 配置错误（如 GITHUB_TOKEN 缺失）或仓储/驱动错误：显式 500，并把完整
      // code/stack/cause 打到 serverless 日志（Vercel runtime logs），不伪装成功。
      console.error('[cron] process-job failed:', JSON.stringify(describeError(err)));
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });

  // GET /internal/cron/cleanup?task=demo|auth|all（默认 all）：物理清理过期会话
  app.get('/internal/cron/cleanup', async (c) => {
    if (!cronAuthorized(c)) return c.json({ error: 'unauthorized' }, 401);
    const task = (c.req.query('task') ?? 'all') as MaintenanceTask;
    if (!['demo', 'auth', 'all'].includes(task)) {
      return c.json({ error: "task must be one of demo|auth|all" }, 400);
    }
    const maintenance =
      deps.runMaintenance ?? ((t: MaintenanceTask, n: string) => runMaintenance(t, repos, n));
    const result = await maintenance(task, now());
    return c.json({ ok: true, result });
  });
}
