/**
 * MV3 service worker skeleton.
 *
 * MVP 只做用户主动触发的表单填充，所有逻辑都在 content script 内完成；
 * background 现阶段仅保留消息透传位，供后续"跨页面状态/存储同步"扩展。
 * （无后台自动投递，符合决策 #15 边界。）
 */
chrome.runtime.onInstalled.addListener(() => {
  // 占位：预留安装事件，后续可在此做版本迁移/一次性初始化。
});

export {};
