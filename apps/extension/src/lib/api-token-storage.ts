/**
 * 扩展长期 API token 的 chrome.storage.local 薄壳（决策 #22，design-扩展登录态 §7.4）。
 *
 * 工作台签发一次性 code → 扩展 POST /auth/extension-token/consume 兑换长期 Bearer token；
 * 明文 token 只存本机 chrome.storage.local（服务端只存 SHA-256 哈希）。service worker 与
 * content script 均可访问，读取失败按未登录处理、绝不抛出阻塞主流程。
 */
import { EXT_API_TOKEN_STORAGE_KEY } from '@jobagent/shared';

/** chrome.storage.local 是否可用（单测无 chrome 时返回 false）。 */
function hasChromeStorage(): boolean {
  return typeof chrome !== 'undefined' && typeof chrome.storage?.local !== 'undefined';
}

/** 已授权的扩展身份（consume 响应裁剪：不含明文外的多余字段）。 */
export interface StoredApiToken {
  token: string;
  name: string;
  expiresAt: string;
  account: { platform: 'github' | 'gitee'; login: string };
}

function parseStored(raw: string | undefined): StoredApiToken | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredApiToken>;
    if (
      typeof parsed.token !== 'string' ||
      typeof parsed.expiresAt !== 'string' ||
      !parsed.account ||
      typeof parsed.account.login !== 'string'
    ) {
      return null;
    }
    return {
      token: parsed.token,
      name: typeof parsed.name === 'string' ? parsed.name : 'browser extension',
      expiresAt: parsed.expiresAt,
      account: {
        platform: parsed.account.platform === 'gitee' ? 'gitee' : 'github',
        login: parsed.account.login,
      },
    };
  } catch {
    return null;
  }
}

/** 读已授权的扩展身份；未授权/损坏/存储不可用返回 null。 */
export async function readStoredApiToken(): Promise<StoredApiToken | null> {
  if (!hasChromeStorage()) return null;
  try {
    const got = await chrome.storage.local.get(EXT_API_TOKEN_STORAGE_KEY);
    return parseStored(got[EXT_API_TOKEN_STORAGE_KEY] as string | undefined);
  } catch {
    return null;
  }
}

/** 读明文 token 字符串（JobAgentApi 鉴权头用）；未授权返回 null。 */
export async function readStoredApiTokenValue(): Promise<string | null> {
  const stored = await readStoredApiToken();
  return stored ? stored.token : null;
}

/** 保存授权结果（consume 响应形状）。 */
export async function writeStoredApiToken(value: StoredApiToken): Promise<void> {
  if (!hasChromeStorage()) return;
  try {
    await chrome.storage.local.set({ [EXT_API_TOKEN_STORAGE_KEY]: JSON.stringify(value) });
  } catch {
    // 存储异常静默跳过（只影响登录态持久化，不阻塞主流程）
  }
}

/** 清除授权（扩展侧"断开"，服务端 token 仍有效，用户可在工作台撤销）。 */
export async function clearStoredApiToken(): Promise<void> {
  if (!hasChromeStorage()) return;
  try {
    await chrome.storage.local.remove(EXT_API_TOKEN_STORAGE_KEY);
  } catch {
    // 幂等，忽略
  }
}
