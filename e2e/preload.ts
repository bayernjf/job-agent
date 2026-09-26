/**
 * E2E 冷路由预热（T29，item81 处置）：Astro dev SSR 是即时编译，首个访问某路由的
 * 用例会承担冷编译耗时（CI 实测 gated-content.spec.ts:55 的 Gitee 路由 `page.goto`
 * 30s 超时两次，同 run 里首访该路由的用例耗时 9.1s，其余报告页用例 150–500ms）。
 *
 * workers=1 串行 + 按文件名字母序执行：第一个 spec 的 beforeAll 里把所有 fixture
 * 路由各预热一次，后续任意 spec 访问同路由都不再冷编译。幂等、无依赖、纯 fetch。
 */
import { FIXTURE_PROFILE_ID, FIXTURE_CLAIMED_PROFILE_ID, FIXTURE_FUSED_PROFILE_ID,
  FIXTURE_GITEE_PROFILE_ID, FIXTURE_NEXT_STEPS_PROFILE_ID, FIXTURE_PARTIAL_PROFILE_ID } from './fixtures/sample-profile.js';

export async function preloadAstro(baseURL: string): Promise<void> {
  // 精简路由：只预 zh-CN 报告页（locale 合法值为 zh-CN/en，/zh/ 会重定向 /en/ 丢 query），
  // home/my/分流各一次即可；每请求限 6s，整体控制在 beforeAll 120s 内。
  const paths = [
    '/zh-CN/',
    '/en/',
    '/zh-CN/my',
    '/zh-CN/?unavailable=1',
    '/zh-CN/?notfound=1',
    `/zh-CN/report/${FIXTURE_PROFILE_ID}`,
    `/zh-CN/report/${FIXTURE_CLAIMED_PROFILE_ID}`,
    `/zh-CN/report/${FIXTURE_GITEE_PROFILE_ID}`,
    `/zh-CN/report/${FIXTURE_FUSED_PROFILE_ID}`,
    `/zh-CN/report/${FIXTURE_NEXT_STEPS_PROFILE_ID}`,
    `/zh-CN/report/${FIXTURE_PARTIAL_PROFILE_ID}`,
    `/en/report/${FIXTURE_GITEE_PROFILE_ID}`,
  ];
  // 逐个串行预热（Astro 冷编译是单文件级的，并行反而加剧资源争用；失败不阻塞测试，
  // 只留警告——预热是缓解不是硬依赖）。
  for (const p of paths) {
    const url = `${baseURL}${p}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(6000), headers: { 'user-agent': 'e2e-preload' } });
      if (!res.ok) console.warn(`[e2e-preload] ${url} -> ${res.status}`);
    } catch (err) {
      console.warn(`[e2e-preload] ${url} failed: ${String(err)}`);
    }
  }
}
