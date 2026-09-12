/**
 * Content script 入口：在 ATS 应用页注入悬浮按钮，点击打开填充面板。
 *
 * 边界（决策 #15）：只做用户主动触发的一键填充；不自动打开表单、不做后台投递。
 * UI 挂 Shadow DOM，避免与页面样式互相污染。
 */
import { createRoot, type Root } from 'react-dom/client';
import { detectAts } from '../ats/index.js';
import { mountPanel, type PanelHandle } from './panel.js';

const OVERLAY_ID = 'jobagent-autofill-overlay';

let handle: PanelHandle | null = null;

function init(): void {
  const ats = detectAts(document);
  if (!ats) {
    console.info('[jobagent] no supported ATS detected on this page');
    return;
  }

  const host = document.createElement('div');
  host.id = OVERLAY_ID;
  host.style.cssText =
    'all:initial;position:fixed;right:24px;bottom:24px;z-index:2147483647;font-family:system-ui,sans-serif;';
  const shadow = host.attachShadow({ mode: 'open' });
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = chrome.runtime.getURL('panel.css');
  shadow.appendChild(link);
  document.documentElement.appendChild(host);

  const buttonMount = document.createElement('div');
  shadow.appendChild(buttonMount);
  const root = createRoot(buttonMount);
  root.render(
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        if (handle) handle.toggle();
      }}
    >
      JobAgent 填充
    </button>,
  );

  handle = mountPanel(shadow, root, ats);
}

init();
