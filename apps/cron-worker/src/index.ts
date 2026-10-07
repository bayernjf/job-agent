/**
 * Cron Worker entry point. Wakes the production analysis consumer every five
 * minutes and runs the maintenance cleanup hourly. Thin shell: it only turns
 * the runtime `fetch` into the pure getter the decision core expects. No
 * database access and no business logic here — same thin-shell principle as
 * apps/mcp.
 */
import {
  runCronTick,
  DEFAULT_CALL_TIMEOUT_MS,
  type CronEnv,
} from './tick.js';

/** Hourly maintenance cron (physical cleanup of expired sessions/accounts). */
const HOURLY_CRON = '0 * * * *';

export default {
  async scheduled(
    controller: ScheduledController,
    env: CronEnv,
    ctx: ExecutionContext,
  ): Promise<void> {
    const origin = env.PROD_ORIGIN.replace(/\/+$/, '');
    const timeoutMs = env.CALL_TIMEOUT_MS ?? DEFAULT_CALL_TIMEOUT_MS;
    const runCleanup = controller.cron === HOURLY_CRON;

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
          runCleanup,
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
        if (log.cleanup && (!log.cleanup.ok || (log.cleanup.status && log.cleanup.status !== 200))) {
          console.error(
            `[cron-worker] cleanup failed status=${log.cleanup.status ?? 'n/a'}`,
          );
        }
        console.log(
          `[cron-worker] tick processed=${log.processJob.processed} idle=${log.processJob.idle} agentTick=${log.agentTick.status ?? 'skipped'} cleanup=${log.cleanup?.status ?? 'skipped'}`,
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
