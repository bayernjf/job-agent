/**
 * MV3 service worker：跨端本地档案同步的消息处理。
 *
 * 报告页（manifest `externally_connectable` 白名单域，如产品域/localhost:4321）经
 * `chrome.runtime.sendMessage(EXTENSION_ID, msg)` 请求读取/写入 canonical 本地档案；
 * background 把档案镜像到 `chrome.storage.local`（跨域权威，扩展 content script 与报告页
 * 共享），两端本域 localStorage 仅作降级缓存。
 *
 * 仍只做用户主动触发的填充与档案同步，无后台自动投递（决策 #15 边界不变）。
 */
import {
  EXT_MSG_GET_LOCAL_PROFILE,
  EXT_MSG_SET_LOCAL_PROFILE,
  mergeLocalProfile,
  type ExtLocalProfileRequest,
  type ExtLocalProfileResponse,
} from '@jobagent/shared';
import { readStoredLocalProfile, writeStoredLocalProfile } from '../lib/local-profile-storage.js';
import { isApiRequestMessage, relayApiRequest } from '../lib/sw-relay.js';

chrome.runtime.onInstalled.addListener(() => {
  // 占位：预留安装事件，后续可在此做版本迁移/一次性初始化。
});

async function handle(req: ExtLocalProfileRequest): Promise<ExtLocalProfileResponse> {
  try {
    if (req.type === EXT_MSG_GET_LOCAL_PROFILE) {
      return { ok: true, value: await readStoredLocalProfile() };
    }
    if (req.type === EXT_MSG_SET_LOCAL_PROFILE) {
      const existing = await readStoredLocalProfile();
      // 新值优先（last-write-wins），现有值补缺标量；教育/工作数组按 school+degree /
      // company+role 去重拼接（mergeLocalProfile 语义），保证 chrome.storage 始终是完整合并值。
      const merged = mergeLocalProfile(req.value, existing);
      await writeStoredLocalProfile(merged);
      return { ok: true, value: merged };
    }
  } catch {
    // 存储异常返回失败，报告页据此降级为本域 localStorage，绝不阻塞主流程
  }
  return { ok: false };
}

// external 消息（来自 externally_connectable 白名单网页，如报告页）。
chrome.runtime.onMessageExternal.addListener((message, _sender, sendResponse) => {
  const req = message as ExtLocalProfileRequest;
  if (req && (req.type === EXT_MSG_GET_LOCAL_PROFILE || req.type === EXT_MSG_SET_LOCAL_PROFILE)) {
    void handle(req).then(sendResponse);
    return true; // 异步 sendResponse，保持消息通道打开
  }
  return false; // 不识别，不响应
});

// internal 消息（来自本扩展 content script）：代发 API 请求。
// SW 以扩展源 + host_permissions 跨域授权发起，规避 ATS 页面源的 CORS /
// 混合内容 / 私有网络访问限制（见 sw-relay.ts）。只放行 GET/POST 与 http(s)。
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (isApiRequestMessage(message)) {
    void relayApiRequest(message).then(sendResponse);
    return true; // 异步 sendResponse，保持消息通道打开
  }
  return false; // 不识别，不响应
});

export {};
