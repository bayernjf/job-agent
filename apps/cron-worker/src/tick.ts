/**
 * Decision core for the cron worker. Pure: takes how to call an endpoint and
 * returns a log of what happened. No globals, no real `fetch`, so the same
 * logic is covered by Vitest instead of trusting `wrangler tail`.
 */

export interface CronEnv {
  /** Production origin, no trailing slash, e.g. https://app.job-agent.bayjf.com */
  PROD_ORIGIN: string;
  /** Shared cron secret; sent as Authorization: Bearer (same form Vercel Cron uses). */
  CRON_SECRET: string;
  /** Max process-job drain calls per invocation (keep below the subrequest cap). */
  DRAIN_LIMIT?: number;
  /** Per-call timeout in milliseconds. */
  CALL_TIMEOUT_MS?: number;
}

export interface CronTickLog {
  processJob: { processed: number; idle: boolean; status?: number };
  agentTick: { ok: boolean; status?: number };
  /** Present when the tick also ran the websearch consumer (same 5-min slot). */
  searchTick?: { ok: boolean; status?: number };
  /** Present only when this tick ran the hourly maintenance cleanup. */
  cleanup?: { ok: boolean; status?: number };
  /** Present when the tick also ran the heartbeat watchdog check. */
  watchHeartbeat?: { ok: boolean; status?: number };
}

export const DEFAULT_DRAIN_LIMIT = 10;
export const DEFAULT_CALL_TIMEOUT_MS = 60_000;
const SUBCALL_DELAY_MS = 5_000;

type Getter = (path: string) => Promise<{ status: number; body: string }>;
type Sleeper = (ms: number) => Promise<void>;

function readKind(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { outcome?: { kind?: unknown } };
    return typeof parsed.outcome?.kind === 'string' ? parsed.outcome.kind : null;
  } catch {
    return null;
  }
}

/**
 * Drain the analysis queue, then advance agent runs, then optionally run the
 * hourly maintenance cleanup. Mirrors the two semantics the GitHub workflow
 * enforced: non-2xx is fatal (no retry, no swallowing), and an empty queue
 * (200 idle) is a safe no-op. Cleanup only runs on a healthy path — a failed
 * process-job aborts the rest of the tick, same as before.
 *
 * `runWatchHeartbeat` runs the heartbeat watchdog (`watch-heartbeat`) on every
 * path — including a failed process-job — because the watchdog's job is to
 * observe exactly that failure: it checks each consumer's last-success
 * heartbeat and surfaces staleness in deep health. It must therefore never be
 * skipped just because a consumer answered non-2xx.
 */
export async function runCronTick(
  env: CronEnv,
  get: Getter,
  sleep: Sleeper,
  runCleanup = false,
  runWatchHeartbeat = false,
): Promise<CronTickLog> {
  const limit = env.DRAIN_LIMIT ?? DEFAULT_DRAIN_LIMIT;
  let processed = 0;

  for (let attempt = 1; attempt <= limit; attempt++) {
    const res = await get('/api/internal/cron/process-job');
    if (res.status !== 200) {
      // 401/403/5xx: stop immediately; next scheduled tick tries again.
      return {
        processJob: { processed, idle: false, status: res.status },
        agentTick: { ok: false },
        watchHeartbeat: await runWatchIfRequested(runWatchHeartbeat, get),
      };
    }
    if (readKind(res.body) === 'idle') {
      const agent = await get('/api/internal/cron/agent-tick');
      const search = await get('/api/internal/cron/search-tick');
      const cleanup = runCleanup
        ? await get('/api/internal/cron/cleanup?task=all')
        : undefined;
      const watch = await runWatchIfRequested(runWatchHeartbeat, get);
      return finishTick(processed, true, agent, search, cleanup, watch);
    }
    processed++;
    if (attempt < limit) await sleep(SUBCALL_DELAY_MS);
  }

  // Reached the drain cap without an idle answer: the agent-tick still runs so
  // job-hunt tasks are not starved by a large analysis backlog.
  const agent = await get('/api/internal/cron/agent-tick');
  const search = await get('/api/internal/cron/search-tick');
  const cleanup = runCleanup
    ? await get('/api/internal/cron/cleanup?task=all')
    : undefined;
  const watch = await runWatchIfRequested(runWatchHeartbeat, get);
  return finishTick(processed, false, agent, search, cleanup, watch);
}

async function runWatchIfRequested(
  runWatchHeartbeat: boolean,
  get: Getter,
): Promise<{ ok: boolean; status: number } | undefined> {
  if (!runWatchHeartbeat) return undefined;
  const res = await get('/api/internal/cron/watch-heartbeat');
  return { ok: res.status === 200, status: res.status };
}

function finishTick(
  processed: number,
  idle: boolean,
  agent: { status: number },
  search: { status: number },
  cleanup: { status: number } | undefined,
  watch: { ok: boolean; status: number } | undefined,
): CronTickLog {
  const log: CronTickLog = {
    processJob: { processed, idle },
    agentTick: { ok: agent.status === 200, status: agent.status },
    searchTick: { ok: search.status === 200, status: search.status },
  };
  if (cleanup) {
    log.cleanup = { ok: cleanup.status === 200, status: cleanup.status };
  }
  if (watch) {
    log.watchHeartbeat = watch;
  }
  return log;
}
