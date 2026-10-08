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

/** Five-minute consumption cron; also runs the heartbeat watchdog. */
const FIVE_MIN_CRON = '*/5 * * * *';
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
    // Watchdog lives on the five-minute slot (same cadence as agent-tick,
    // whose 15-min stale threshold tolerates 3 missed ticks). It is NOT a
    // Vercel Cron: Hobby accounts are limited to one cron invocation per day,
    // so the watch-heartbeat schedule had to move here (2026-10-08).
    const runWatchHeartbeat = controller.cron === FIVE_MIN_CRON;

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
          runWatchHeartbeat,
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
        // 503 here is the watchdog ALARMING (a consumer is stale), not a bug:
        // deep health flips red and self-heals on the next healthy tick.
        if (log.watchHeartbeat && (!log.watchHeartbeat.ok || (log.watchHeartbeat.status && log.watchHeartbeat.status !== 200))) {
          console.warn(
            `[cron-worker] watch-heartbeat status=${log.watchHeartbeat.status ?? 'n/a'} (503 = watchdog alarming on stale consumer)`,
          );
        }
        console.log(
          `[cron-worker] tick processed=${log.processJob.processed} idle=${log.processJob.idle} agentTick=${log.agentTick.status ?? 'skipped'} cleanup=${log.cleanup?.status ?? 'skipped'} watch=${log.watchHeartbeat?.status ?? 'skipped'}`,
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
