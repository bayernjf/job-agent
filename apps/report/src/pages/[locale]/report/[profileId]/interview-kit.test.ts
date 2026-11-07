import { describe, expect, it } from 'vitest';
import { GET } from './interview-kit.md';

async function requestKit(locale: string, profileId: string): Promise<Response> {
  const url = `http://localhost/${locale}/report/${profileId}/interview-kit.md`;
  return await GET({
    params: { locale, profileId },
    request: new Request(url),
  } as unknown as Parameters<typeof GET>[0]);
}

describe('interview kit sign-in gate', () => {
  it('returns a readable localized 401 page with a login link', async () => {
    const res = await requestKit('zh-CN', 'p-claimed');

    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('登录后下载面试准备包');
    expect(html).toContain('/auth/github/login?return_to=');
    expect(html).toContain(encodeURIComponent('/zh-CN/report/p-claimed/interview-kit.md'));
  });

  it('uses English copy on the en route', async () => {
    const res = await requestKit('en', 'p-claimed');
    expect(res.status).toBe(401);
    expect(await res.text()).toContain('Sign in to download the interview kit');
  });

  it('does not reveal whether the profile is claimed or missing', async () => {
    const missing = await requestKit('en', 'p-missing');
    const claimed = await requestKit('en', 'p-claimed');
    expect(missing.status).toBe(401);
    expect(claimed.status).toBe(401);

    const missingBody = await missing.text();
    const claimedBody = await claimed.text();
    // 除返回路径里的 profileId 外，文案与结构必须一致。
    expect(missingBody.replace(/p-missing/g, 'p-profile')).toBe(
      claimedBody.replace(/p-claimed/g, 'p-profile'),
    );
  });
});
