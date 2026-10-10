/**
 * 扩展外部消息与 relay 代发的可信源白名单（S7/S8，审计 §3.2）。
 *
 * - S7：`onMessageExternal` 只处理来自白名单网页的消息。虽然 manifest
 *   `externally_connectable` 已兜底，但白名单含 localhost 时该端口任意页面
 *   都可发消息——必须在 SW 侧再按 `sender.origin` 校验一次（fail closed）。
 * - S8：content script 借 SW 代发的 API 请求，目标 host 必须命中可信集合，
 *   防止被注入的页面脚本借扩展 host_permissions 请求任意 URL。
 *
 * 生产站点源由构建注入（EXTENSION_SITE_ORIGIN，build.mjs define；默认
 * https://app.job-agent.bayjf.com），与 release 构建替换 externally_connectable /
 * host_permissions 用的是同一变量，保证 SW 校验与 manifest 授权一致。
 */

const SITE_ORIGIN: string =
  typeof EXTENSION_SITE_ORIGIN === 'string' ? EXTENSION_SITE_ORIGIN : 'https://app.job-agent.bayjf.com';

/**
 * CWS release 构建（build.mjs define 折叠为常量、minify 消除死分支）时为 true：
 * localhost/127.0.0.1 白名单与 relay host 不进 bundle，与 manifest 剥离同口径。
 * 单测直接跑 TS 源码、该常量未注入，走 dev 分支（本地白名单保留）。
 */
const RELEASE: boolean = typeof EXTENSION_RELEASE === 'boolean' ? EXTENSION_RELEASE : false;

/** S7：允许发 external 消息的网页 origin（与 manifest externally_connectable 同口径）。 */
export const ALLOWED_EXTERNAL_ORIGINS: ReadonlySet<string> = new Set(
  RELEASE
    ? [SITE_ORIGIN]
    : ['http://localhost:4321', 'http://127.0.0.1:4321', SITE_ORIGIN],
);

/** S8：允许 relay 代发的目标 host（dev：localhost/127.0.0.1 任意端口 + 生产 API host；release 仅生产 host）。 */
export function isAllowedRelayHost(host: string): boolean {
  const h = host.toLowerCase();
  if (!RELEASE && (h === 'localhost' || h === '127.0.0.1')) return true;
  return h === new URL(SITE_ORIGIN).hostname;
}

/** 从 MessageSender 提取 origin；拿不到（sender.origin 与 sender.url 均缺）返回 null。 */
export function resolveSenderOrigin(
  sender: { origin?: string | undefined; url?: string | undefined } | null | undefined,
): string | null {
  if (!sender) return null;
  if (sender.origin) return sender.origin;
  if (sender.url) {
    try {
      return new URL(sender.url).origin;
    } catch {
      return null;
    }
  }
  return null;
}

/** S7 判定：外部消息发送方是否命中白名单（fail closed：未知 origin 一律拒绝）。 */
export function isAllowedExternalOrigin(
  sender: { origin?: string | undefined; url?: string | undefined } | null | undefined,
): boolean {
  const origin = resolveSenderOrigin(sender);
  return origin !== null && ALLOWED_EXTERNAL_ORIGINS.has(origin);
}
