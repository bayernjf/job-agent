/**
 * Content script 入口：在 ATS 应用页注入悬浮按钮，点击打开填充面板。
 *
 * 边界（决策 #15）：只做用户主动触发的一键填充；不自动打开表单、不做后台投递。
 * UI 挂 Shadow DOM，避免与页面样式互相污染。
 *
 * SPA 保活：Greenhouse 等 ATS 站点（如 job-boards.greenhouse.io）在 hydration/
 * 路由完成后会重渲染并清理未知注入节点（冒烟 #3 实测），用 MutationObserver
 * 在节点被移除后重建 overlay。
 */
import { createRoot } from 'react-dom/client';
import { detectAts, type AtsAdapter } from '../ats/index.js';
import { mountPanel, type PanelHandle } from './panel.js';

const OVERLAY_ID = 'jobagent-autofill-overlay';

let handle: PanelHandle | null = null;

function mountOverlay(ats: AtsAdapter): void {
  const host = document.createElement('div');
  host.id = OVERLAY_ID;
  host.style.cssText =
    'all:initial;position:fixed;right:24px;bottom:24px;z-index:2147483647;font-family:system-ui,sans-serif;';
  // 定位锚点属结构性样式（首帧样式表未加载也必须就位），刻意不走 token；视觉样式全部在 shadow 样式表内
  const shadow = host.attachShadow({ mode: 'open' });
  // 先挂设计 token（:host 作用域），再挂组件样式，保证 var(--ja-*) 已定义
  const tokensLink = document.createElement('link');
  tokensLink.rel = 'stylesheet';
  tokensLink.href = chrome.runtime.getURL('tokens.css');
  shadow.appendChild(tokensLink);
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = chrome.runtime.getURL('panel.css');
  shadow.appendChild(link);
  document.documentElement.appendChild(host);

  const buttonMount = document.createElement('div');
  shadow.appendChild(buttonMount);
  const buttonRoot = createRoot(buttonMount);
  buttonRoot.render(
    <button
      className="ja-fab"
      type="button"
      aria-haspopup="dialog"
      aria-expanded="false"
      onClick={(e) => {
        e.stopPropagation();
        if (handle) {
          e.currentTarget.setAttribute('aria-expanded', String(handle.toggle()));
        }
      }}
    >
      JobAgent
    </button>,
  );

  // 面板由 mountPanel 内部创建独立 root（避免与悬浮按钮互相替换，冒烟 #3 发现）；
  // 此处不再额外建 panelMount，否则会留下一个同 id 的空 div（重复 id，E2E 发现）。
  handle = mountPanel(shadow, ats);
}

function init(): void {
  const ats = detectAts(document);
  if (!ats) {
    console.info('[jobagent] no supported ATS detected on this page');
    return;
  }

  mountOverlay(ats);

  // SPA 保活：Greenhouse job-boards 等页面会周期性清理注入节点/清空 shadow
  // 内容，用 interval 轮询检查 host 与按钮双重存在（比 MutationObserver 抗页面高频清理）
  const keepalive = (): void => {
    const host = document.getElementById(OVERLAY_ID);
    const buttonAlive = !!host?.shadowRoot?.querySelector('button');
    if (!host || !buttonAlive) {
      // 已存在但内部被清空：移除后重建；不存在：直接重建
      host?.remove();
      mountOverlay(ats);
    }
  };
  setInterval(keepalive, 1000);
}

init();
