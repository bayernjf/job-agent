/**
 * Daily email digest decision core (decision #25, 2026-10-10). Pure: it takes
 * how to call the API and returns what happened — the Email binding send is
 * injected, so Vitest covers the whole flow without a Workers runtime.
 *
 * Flow: GET /internal/cron/digest-tick returns ready-to-send digest payloads;
 * each is sent via the injected sender; the ids of successfully sent digests
 * are posted back to /internal/cron/digest-sent so the API advances the
 * per-subscription window (last_sent_at). Send failures never throw — a
 * failed digest just gets retried by tomorrow's tick (window not advanced).
 */

export interface DigestPayload {
  subscriptionId: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface DigestLog {
  tickOk: boolean;
  tickStatus?: number;
  produced: number;
  sent: number;
  failed: number;
}

type Getter = (path: string) => Promise<{ status: number; body: string }>;
type Poster = (path: string, payload: unknown) => Promise<{ status: number; body: string }>;
type Sender = (digest: DigestPayload) => Promise<void>;

export async function runDigestTick(
  get: Getter,
  post: Poster,
  send: Sender,
): Promise<DigestLog> {
  const tick = await get('/api/internal/cron/digest-tick');
  if (tick.status !== 200) {
    return { tickOk: false, tickStatus: tick.status, produced: 0, sent: 0, failed: 0 };
  }
  let digests: DigestPayload[] = [];
  try {
    const parsed = JSON.parse(tick.body) as { digests?: DigestPayload[] };
    digests = Array.isArray(parsed.digests) ? parsed.digests : [];
  } catch {
    digests = [];
  }

  const sentIds: string[] = [];
  let failed = 0;
  for (const digest of digests) {
    try {
      await send(digest);
      sentIds.push(digest.subscriptionId);
    } catch {
      failed += 1;
    }
  }

  if (sentIds.length > 0) {
    await post('/api/internal/cron/digest-sent', { subscriptionIds: sentIds });
  }

  return {
    tickOk: true,
    tickStatus: 200,
    produced: digests.length,
    sent: sentIds.length,
    failed,
  };
}
