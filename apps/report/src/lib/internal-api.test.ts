import { afterEach, describe, expect, it } from 'vitest';
import { forwardToHono, setInternalAppForTest, type ForwardableApp } from './internal-api';

/** Backend double that records the pathname it receives, so prefix stripping is verified end-to-end. */
function makeBackend() {
  const seen: string[] = [];
  const backend: ForwardableApp = {
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      seen.push(path);
      if (path === '/health') {
        return new Response(JSON.stringify({ status: 'ok', service: 'jobagent-api' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('Not Found', { status: 404 });
    },
  };
  return { backend, seen };
}

afterEach(() => {
  setInternalAppForTest(null);
});

describe('Vercel same-domain API entry (forwardToHono)', () => {
  it('strips the /api prefix before routing and returns the backend body', async () => {
    const { backend, seen } = makeBackend();
    setInternalAppForTest(backend);

    const res = await forwardToHono(new Request('http://localhost/api/health'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', service: 'jobagent-api' });
    // The backend must receive the Hono path /health, not /api/health.
    expect(seen).toEqual(['/health']);
  });

  it('forwards unknown routes with the backend status code', async () => {
    const { backend, seen } = makeBackend();
    setInternalAppForTest(backend);

    const res = await forwardToHono(new Request('http://localhost/api/does-not-exist'));
    expect(res.status).toBe(404);
    expect(seen).toEqual(['/does-not-exist']);
  });

  it('preserves the request method and body', async () => {
    let receivedMethod = '';
    let receivedBody = '';
    setInternalAppForTest({
      fetch: async (req) => {
        receivedMethod = req.method;
        receivedBody = await req.text();
        return new Response(null, { status: 204 });
      },
    });

    const res = await forwardToHono(
      new Request('http://localhost/api/analyze', {
        method: 'POST',
        body: JSON.stringify({ subject: 'octocat' }),
        headers: { 'content-type': 'application/json' },
      }),
    );

    expect(res.status).toBe(204);
    expect(receivedMethod).toBe('POST');
    expect(receivedBody).toBe(JSON.stringify({ subject: 'octocat' }));
  });
});
