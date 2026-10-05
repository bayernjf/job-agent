/**
 * Cron Worker entry point. Wakes the production analysis consumer every five
 * minutes. Thin shell: it only turns the runtime `fetch` into the pure getter
 * the decision core expects. No database access and no business logic here —
 * same thin-shell principle as apps/mcp.
 */
import {
  runCronTick,
  DEFAULT_CALL_TIMEOUT_MS,
  type CronEnv,
} from './tick.js';

export default {
  async scheduled(
    controller: ScheduledController,
    env: CronEnv,
    ctx: ExecutionContext,
  ): Promise<void> {
    const origin = env.PROD_ORIGIN.replace(/\/+$/, '');
    const timeoutMs = env.CALL_TIMEOUT_MS ?? DEFAULT_CALL_TIMEOUT_MS;

    ctx.waitUntil(
      (async () => {
        const log = await runCronTick(
          env,
          async (path) => {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), timeoutMs);
            try {
              const res = await fetch(`${origin}${path}`, {
                method: 'GET',
                headers: { authorization: `Bearer ${env.CRON_SECRET}` },
                signal: ctrl.signal,
              });
              return { status: res.status, body: await res.text() };
            } finally {
              clearTimeout(timer);
            }
          },
          (ms) => new Promise((r) => setTimeout(r, ms)),
        );

        if (log.processJob.status && log.processJob.status !== 200) {
          console.error(
            `[cron-worker] process-job failed status=${log.processJob.status} processed=${log.processJob.processed}`,
          );
        }
        if (!log.agentTick.ok || (log.agentTick.status && log.agentTick.status !== 200)) {
          console.error(
            `[cron-worker] agent-tick failed status=${log.agentTick.status ?? 'n/a'}`,
          );
        }
        console.log(
          `[cron-worker] tick processed=${log.processJob.processed} idle=${log.processJob.idle} agentTick=${log.agentTick.status ?? 'skipped'}`,
        );
      })(),
    );
  },

  // A plain HTTP hit is not how this runs, but answer something honest instead
  // of exposing the schedule internals.
  async fetch(): Promise<Response> {
    return new Response('cron worker: no HTTP surface', { status: 404 });
  },
};
