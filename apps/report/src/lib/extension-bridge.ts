/**
 * 报告页 ↔ Chrome 扩展的跨端本地档案桥接。
 *
 * 报告页（产品域）通过 `chrome.runtime.sendMessage(EXTENSION_ID, msg)` 与扩展 background
 * 通信，读写扩展 `chrome.storage.local` 里的 canonical 本地档案（跨域权威）。扩展未安装 /
 * 非 Chrome 浏览器 / 通信失败时一律降级为仅本域 localStorage，绝不阻塞简历生成。
 *
 * 消息协议形状（EXT_MSG_* / ExtLocalProfileResponse）落在 shared 单一事实源。
 */
import {
  EXT_MSG_GET_LOCAL_PROFILE,
  EXT_MSG_SET_LOCAL_PROFILE,
  type ExtLocalProfileResponse,
  type LocalProfileFields,
} from '@jobagent/shared';

/** 固定扩展 ID（由 apps/extension/src/manifest.json 的 `key` 派生），报告页据此发消息。 */
export const EXTENSION_ID = 'dgbnkdljapgglpdcmncbleioocbjfmmc';

/** 最小 chrome.runtime 形状（报告页不引 @types/chrome，仅声明用到的 sendMessage）。 */
interface ChromeRuntimeLike {
  sendMessage?: (extensionId: string, message: unknown) => Promise<unknown> | undefined;
}
interface ChromeLike {
  runtime?: ChromeRuntimeLike;
}

function getChrome(): ChromeLike | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as { chrome?: ChromeLike }).chrome;
}

function hasExtensionBridge(): boolean {
  return Boolean(getChrome()?.runtime?.sendMessage);
}

async function send<T>(message: unknown): Promise<T | undefined> {
  const runtime = getChrome()?.runtime;
  if (!runtime?.sendMessage) return undefined;
  try {
    return (await runtime.sendMessage(EXTENSION_ID, message)) as T;
  } catch {
    // 扩展未安装（"Receiving end does not exist"）或通信失败 → 降级为本域 localStorage
    return undefined;
  }
}

/** 从扩展读取 canonical 本地档案；扩展不可用返回 undefined。 */
export async function fetchExtensionLocalProfile(): Promise<LocalProfileFields | undefined> {
  if (!hasExtensionBridge()) return undefined;
  const resp = await send<ExtLocalProfileResponse>({ type: EXT_MSG_GET_LOCAL_PROFILE });
  return resp?.ok ? resp.value : undefined;
}

/** 把 canonical 本地档案推给扩展（扩展合并后落 chrome.storage）；失败静默降级。 */
export async function pushExtensionLocalProfile(value: LocalProfileFields): Promise<void> {
  if (!hasExtensionBridge()) return;
  await send<ExtLocalProfileResponse>({ type: EXT_MSG_SET_LOCAL_PROFILE, value });
}
