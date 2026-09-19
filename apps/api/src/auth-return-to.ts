/**
 * OAuth 登录后 return_to 深链回跳的安全校验（账号主脊收尾，2026-09-19）。
 *
 * 只放行**同源相对路径**，防开放重定向（open redirect）：
 * - 必须以单个 `/` 开头；第二字符不得是 `/` 或 `\`（拦 `//host`、`/\\host` 这类
 *   协议相对 URL，浏览器会把 `//host` 解析成跳到 host 的绝对 URL）。
 * - 拒绝绝对 URL（`https://…`、`javascript:…`）、控制字符（CR/LF/Tab，防响应头
 *   注入与怪异 URL 解析）、超长值。
 * - 不回跳到 `/auth/` 认证端点本身，避免登录环。
 * 纯函数、无 I/O，便于单测。非法/缺失一律返回 null，由调用方回退默认落地页。
 */

/** 回跳路径长度上限（与常见 URL/头字段上限同量级，足够携带深链 query）。 */
export const MAX_RETURN_TO_LENGTH = 2048;

/**
 * 校验登录后回跳目标。
 * @returns 可安全用于 302 Location 的同源相对路径；非法/缺失返回 null。
 */
export function sanitizeReturnTo(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value.length === 0 || value.length > MAX_RETURN_TO_LENGTH) return null;

  // 拒绝任何控制字符（含 CR/LF/Tab），防头注入
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;

  // 仅接受同源绝对路径：必须以 '/' 开头（拒绝 https: / javascript: 等）
  if (!value.startsWith('/')) return null;
  // 第二个字符不得是 '/' 或 '\'：拦协议相对 URL（//host、/\host）
  if (value.length > 1 && (value[1] === '/' || value[1] === '\\')) return null;

  // 不回跳到认证端点本身（避免 /auth/github/login → 回调 → /auth/github/login 环）
  if (value === '/auth/github/login' || value.startsWith('/auth/')) return null;

  return value;
}
