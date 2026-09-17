/**
 * chrome.storage.local 中 canonical 本地档案的读写薄壳（service worker 与 content script 共用）。
 *
 * chrome.storage 按扩展维度隔离、跨域可见，是两端（扩展面板 ATS 域、报告页产品域）共享
 * 本地档案的权威存储；两端本域 localStorage 仅作降级缓存。写入统一 JSON 序列化（规避
 * undefined 字段与跨上下文序列化差异），损坏数据按空处理、绝不抛出阻塞主流程。
 */
import {
  LOCAL_PROFILE_STORAGE_KEY,
  sanitizeLocalProfile,
  type LocalProfileFields,
} from '@jobagent/shared';

/** chrome.storage.local 是否可用（service worker / content script 均可访问；单测无 chrome 时返回 false）。 */
function hasChromeStorage(): boolean {
  return typeof chrome !== 'undefined' && typeof chrome.storage?.local !== 'undefined';
}

/** 读 chrome.storage.local 里的 canonical 档案（不可用/损坏按空处理，绝不抛出）。 */
export async function readStoredLocalProfile(): Promise<LocalProfileFields> {
  if (!hasChromeStorage()) return {};
  try {
    const got = await chrome.storage.local.get(LOCAL_PROFILE_STORAGE_KEY);
    const raw = got[LOCAL_PROFILE_STORAGE_KEY] as string | undefined;
    if (raw) return sanitizeLocalProfile(JSON.parse(raw) as LocalProfileFields);
  } catch {
    // 损坏数据按空处理
  }
  return {};
}

/** 写 canonical 档案到 chrome.storage.local（不可用/异常时静默跳过，本域 localStorage 兜底）。 */
export async function writeStoredLocalProfile(value: LocalProfileFields): Promise<void> {
  if (!hasChromeStorage()) return;
  try {
    await chrome.storage.local.set({
      [LOCAL_PROFILE_STORAGE_KEY]: JSON.stringify(sanitizeLocalProfile(value)),
    });
  } catch {
    // 存储异常静默降级
  }
}
