/**
 * 系统路由：健康检查 + 分析/清理 cron（Q1 单文件拆分）。
 * agent-tick 依赖求职 Agent 装配，放在 agent.ts 末尾以保持原注册顺序。
 */
import type { Hono } from 'hono';
import { runProcessJobOnce, runMaintenance, type MaintenanceTask } from '../cron-jobs.js';
import { describeError } from './helpers.js';
import type { HonoEnv } from './types.js';
import type { RouteDeps } from './context.js';
import type { ColumnRequirement } from '@jobagent/storage';

/**
 * 迁移漂移守卫的关键列清单（deferred「迁移漂移守卫」）：
 * 只放"已上线生产、代码实际引用、缺失即功能损坏"的列；改动 schema 时同步更新。
 * 刻意**不**读 schema_migrations 账本（手工重放的迁移无账本记录，会误报）。
 *
 * 2026-10-08 收敛：023/024/025/027/029 对应 P2 表/列（accounts.is_admin、
 * llm_catalog_models、user_llm_configs、api_tokens、claim_verifications），
 * 生产尚未执行对应迁移，且缺失时功能走降级路径（LLM catalog 回退代码默认等），
 * 放入守卫会让部署后深探活误报 503；P2 上线时再逐项加回。
 */
const REQUIRED_COLUMNS: ColumnRequirement[] = [
  { table: 'accounts', column: 'recruiter_declared_at' }, // 015 招聘方声明
  { table: 'profiles', column: 'removal_requested_at' }, // 017 画像移除申请
  { table: 'job_runs', column: 'last_scan_at' }, // 019 求职任务扫描
  { table: 'job_runs', column: 'last_viewed_at' }, // 030 工作台已读回执
  { table: 'submit_intents', column: 'application_id' }, // 021 投递关联
  { table: 'cron_heartbeat', column: 'consumer' }, // 031 心跳（本批）
];

export { REQUIRED_COLUMNS };

/**
 * 心跳守望（watchdog）参数：watch-heartbeat cron 按 *\/5 调度（与最慢消费方
 * agent-tick 对齐），stale 判定只看"最近一次成功心跳"（last_success_at；失败
 * 记录不覆盖它，见 storage 的 recordFailure 语义）。阈值给连续 N 轮无心跳的
 * 冗余：agent-tick *\/5 → 15 分钟（连续 3 轮）、process-job 30 分钟（容忍
 * 更低频调度/更长任务）。未知 consumer 一律忽略，不误报。
 */
const WATCHDOG_CONSUMER = 'watchdog';
const WATCHDOG_STALE_THRESHOLDS: Record<string, number> = {
  'agent-tick': 15 * 60_000,
  'process-job': 30 * 60_000,
};
/** deep 探活中，watchdog 最近一次失败记录（last_error 非空）视为不健康的时间窗 */
const WATCHDOG_UNHEALTHY_WINDOW_MS = 30 * 60_000;

export function registerSystem(app: Hono<HonoEnv>, d: RouteDeps): void {
  const { repos, now, deps, cronAuthorized } = d;

  // 健康检查：浅检查（默认）不依赖 DB，恒定返回进程存活；
  // ?deep=1（或 ?deep=true）额外执行一次持久化层 SELECT 1 往返，DB 不可达时返回 503，
  // 供部署后 smoke / 监控探活区分"进程在但数据库挂了"；同时返回 cron 消费心跳
  // （迁移 031：process-job / agent-tick 最近一次成功/失败），让"消费方是否活着"
  // 在应用内可见，而不再只存在于 serverless 日志。
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
      const [, heartbeats, missing] = await Promise.all([
        repos.ping(),
        repos.cronHeartbeat.listAll(),
        repos.verifyRequiredColumns(REQUIRED_COLUMNS),
      ]);
      if (missing.length > 0) {
        // 迁移漂移：代码所需的关键列缺失（手工重放迁移/部分回滚/降级发布等），
        // 服务可能半残，深探活必须 503 显式暴露，不伪装 ok。
        return c.json(
          {
            status: 'error',
            service: 'jobagent-api',
            time: new Date().toISOString(),
            db: 'ok',
            dbLatencyMs: Date.now() - started,
            schemaDrift: missing,
          },
          503,
        );
      }
      // 心跳守望：watch-heartbeat cron 最近一次发现消费方 stale 时（watchdog 行
      // last_error 非空且在窗口内），deep 探活 503 显式暴露——让"分析/代理消费
      // 通道断了"成为可探知的失败，而不是只在 cron 日志里躺一条。
      const watchdog = heartbeats.find((hb) => hb.consumer === WATCHDOG_CONSUMER);
      if (watchdog?.lastError && Date.now() - new Date(watchdog.updatedAt).getTime() < WATCHDOG_UNHEALTHY_WINDOW_MS) {
        return c.json(
          {
            ...base,
            db: 'ok',
            dbLatencyMs: Date.now() - started,
            watchdog: { status: 'error', message: watchdog.lastError, checkedAt: watchdog.updatedAt },
          },
          503,
        );
      }
      return c.json({
        ...base,
        db: 'ok',
        dbLatencyMs: Date.now() - started,
        cronHeartbeat: heartbeats,
      });
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
    const started = now();
    try {
      const processOnce = deps.processJobOnce ?? (() => runProcessJobOnce());
      const outcome = await processOnce();
      // 心跳回写：消费方活着 = 这一轮确实执行了（idle/deferred/processed 都算成功）；
      // failed 是"执行了但任务处理失败"，记入 last_error 供读口对照，不伪装成功。
      if (outcome.kind === 'failed') {
        await repos.cronHeartbeat.recordFailure('process-job', started, outcome.message);
      } else {
        const summary =
          outcome.kind === 'idle'
            ? 'idle'
            : outcome.kind === 'deferred'
              ? `deferred=${outcome.jobId}`
              : `processed=${outcome.jobId}`;
        await repos.cronHeartbeat.recordSuccess('process-job', started, summary);
      }
      return c.json({ ok: true, outcome });
    } catch (err) {
      // 配置错误（如 GITHUB_TOKEN 缺失）或仓储/驱动错误：显式 500，并把完整
      // code/stack/cause 打到 serverless 日志（Vercel runtime logs），不伪装成功。
      // 心跳同样记失败：这个消费通道目前是坏的。
      console.error('[cron] process-job failed:', JSON.stringify(describeError(err)));
      await repos.cronHeartbeat.recordFailure('process-job', started, (err as Error).message);
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });

  // GET /internal/cron/watch-heartbeat：消费心跳守望——按节奏（Vercel Cron *\/5）
  // 检查各 cron 消费方最近一次成功心跳，任一 stale 即回写 watchdog 失败心跳并返回
  // 503（Vercel 面板/日志可见失败），deep 探活同步暴露为不健康；全部新鲜则回写
  // watchdog 成功心跳（last_error 清空 → deep 探活恢复 200）。
  app.get('/internal/cron/watch-heartbeat', async (c) => {
    if (!cronAuthorized(c)) return c.json({ error: 'unauthorized' }, 401);
    const started = now();
    try {
      const heartbeats = await repos.cronHeartbeat.listAll();
      const stale: string[] = [];
      for (const hb of heartbeats) {
        const threshold = WATCHDOG_STALE_THRESHOLDS[hb.consumer];
        if (threshold === undefined) continue;
        const lastOk = hb.lastSuccessAt ? new Date(hb.lastSuccessAt).getTime() : 0;
        if (Date.now() - lastOk > threshold) {
          stale.push(`${hb.consumer} lastOk=${hb.lastSuccessAt ?? 'never'} lastError=${hb.lastError ?? 'none'}`);
        }
      }
      if (stale.length > 0) {
        const message = `stale: ${stale.join('; ')}`;
        await repos.cronHeartbeat.recordFailure(WATCHDOG_CONSUMER, started, message);
        return c.json({ status: 'error', stale }, 503);
      }
      const summary = heartbeats.length > 0 ? heartbeats.map((hb) => `${hb.consumer}:ok`).join(', ') : 'no-consumers-yet';
      await repos.cronHeartbeat.recordSuccess(WATCHDOG_CONSUMER, started, summary);
      return c.json({ status: 'ok', heartbeats });
    } catch (err) {
      console.error('[cron] watch-heartbeat failed:', JSON.stringify(describeError(err)));
      await repos.cronHeartbeat.recordFailure(WATCHDOG_CONSUMER, started, (err as Error).message);
      return c.json({ status: 'error', error: (err as Error).message }, 500);
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
