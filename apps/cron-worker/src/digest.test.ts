import { describe, expect, it } from 'vitest';
import { runDigestTick, type DigestPayload } from './digest.js';

const D1: DigestPayload = {
  subscriptionId: 'nsub-1',
  to: 'me@example.com',
  subject: 's1',
  text: 't1',
  html: '<p>h1</p>',
};
const D2: DigestPayload = { ...D1, subscriptionId: 'nsub-2', to: 'me@example.com' };

function harness(opts: {
  tickStatus?: number;
  digests?: DigestPayload[];
  failOn?: string[];
}) {
  const posted: unknown[] = [];
  const sentTo: string[] = [];
  const get = async () => ({
    status: opts.tickStatus ?? 200,
    body: JSON.stringify({ digests: opts.digests ?? [] }),
  });
  const post = async (_path: string, payload: unknown) => {
    posted.push(payload);
    return { status: 200, body: '{}' };
  };
  const send = async (digest: DigestPayload) => {
    if (opts.failOn?.includes(digest.subscriptionId)) throw new Error('smtp down');
    sentTo.push(digest.to);
  };
  return { posted, sentTo, get, post, send };
}

describe('runDigestTick', () => {
  it('sends every produced digest and posts back the sent ids', async () => {
    const h = harness({ digests: [D1, D2] });
    const log = await runDigestTick(h.get, h.post, h.send);
    expect(log).toMatchObject({ tickOk: true, produced: 2, sent: 2, failed: 0 });
    expect(h.sentTo).toEqual(['me@example.com', 'me@example.com']);
    expect(h.posted).toEqual([{ subscriptionIds: ['nsub-1', 'nsub-2'] }]);
  });

  it('does not post back when nothing was produced (window must not advance)', async () => {
    const h = harness({ digests: [] });
    const log = await runDigestTick(h.get, h.post, h.send);
    expect(log).toMatchObject({ produced: 0, sent: 0 });
    expect(h.posted).toHaveLength(0);
  });

  it('a failed send is excluded from the sent-ids callback (retried tomorrow)', async () => {
    const h = harness({ digests: [D1, D2], failOn: ['nsub-2'] });
    const log = await runDigestTick(h.get, h.post, h.send);
    expect(log).toMatchObject({ produced: 2, sent: 1, failed: 1 });
    expect(h.posted).toEqual([{ subscriptionIds: ['nsub-1'] }]);
  });

  it('non-200 tick is fatal-but-honest: no sends, no callback', async () => {
    const h = harness({ tickStatus: 500 });
    const log = await runDigestTick(h.get, h.post, h.send);
    expect(log.tickOk).toBe(false);
    expect(h.sentTo).toHaveLength(0);
    expect(h.posted).toHaveLength(0);
  });
});
