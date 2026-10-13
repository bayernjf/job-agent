/**
 * 外部平台告警 Webhook 薄壳（2026-10-14，闭环 deferred「Cron Worker 失败信号无读者」
 * 剩余缺口②：没有进程按节奏读 `/health?deep=1` 做外部平台对接）。
 *
 * 设计见 docs/design-notification-channels-20261010.md §10：watch-heartbeat 判 stale
 * 翻转边沿时，除 Web Push（决策 #25-2）与 digest 每日邮件兜底外，再向一个
 * 「必定有人看」的平台通道（企业微信 / 飞书机器人 / Slack 兼容）POST 一条告警。
 *
 * 硬约束（与 web-push.ts 一致）：
 *   - **绝不抛出**：任何网络/协议错误都收敛为 `{ok:false}`，调用方只记日志——
 *     告警通道自己坏掉不能把 watchdog 本体带崩；
 *   - **未配置即静默**：`ALERT_WEBHOOK_URL` 不设时调用方根本不调本函数；
 *   - webhook 地址是密钥（URL 内嵌 token），只走服务端 env，绝不进前端/Git/日志。
 */

export interface AlertWebhookResult {
  ok: boolean;
  /** 平台回的状态码（网络层失败为 undefined） */
  status?: number;
  error?: string;
}

/** 告警正文（纯文本；各平台报文格式由 buildAlertWebhookBody 决定）。 */
export type AlertMessage = string;

/** 平台识别：按 webhook 主机名。未知网关回退 Slack 兼容 `{text}`。 */
export type AlertWebhookPlatform = 'wecom' | 'feishu' | 'slack';

/** 单次 POST 超时：告警不能拖住 cron tick（watch-heartbeat 由 5 分钟档调用）。 */
const ALERT_WEBHOOK_TIMEOUT_MS = 5000;

export function detectAlertWebhookPlatform(webhookUrl: string): AlertWebhookPlatform {
  let host: string;
  try {
    host = new URL(webhookUrl).hostname.toLowerCase();
  } catch {
    return 'slack';
  }
  if (host === 'qyapi.weixin.qq.com') return 'wecom';
  if (host === 'open.feishu.cn' || host === 'open.larksuite.com') return 'feishu';
  return 'slack';
}

/**
 * 按平台组报文体：
 *   - 企业微信群机器人：`{msgtype:'markdown', markdown:{content}}`
 *   - 飞书自定义机器人：`{msg_type:'text', content:{text}}`
 *   - 其它（Slack / 自建网关）：`{text}`
 * URL 非法时回退 slack 形态（发送才会失败，不在这里抛）。
 */
export function buildAlertWebhookBody(webhookUrl: string, message: AlertMessage): string {
  switch (detectAlertWebhookPlatform(webhookUrl)) {
    case 'wecom':
      return JSON.stringify({ msgtype: 'markdown', markdown: { content: message } });
    case 'feishu':
      return JSON.stringify({ msg_type: 'text', content: { text: message } });
    default:
      return JSON.stringify({ text: message });
  }
}

/**
 * 发送一条告警。绝不抛出：网络错误/超时/非 2xx/URL 非法一律
 * `{ok:false, ...}`；调用方（watch-heartbeat）只记日志、不影响端点语义。
 * URL 预检：必须可解析且为 https（webhook 地址内嵌 token，明文 HTTP 会泄露密钥）。
 *
 * @param fetchImpl 可注入（测试零网络）；生产用全局 fetch。
 */
export async function sendAlertWebhook(
  webhookUrl: string,
  message: AlertMessage,
  fetchImpl: typeof fetch = fetch,
): Promise<AlertWebhookResult> {
  let parsed: URL;
  try {
    parsed = new URL(webhookUrl);
  } catch {
    return { ok: false, error: 'invalid webhook url' };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, error: `unsupported protocol: ${parsed.protocol}` };
  }
  try {
    const res = await fetchImpl(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: buildAlertWebhookBody(webhookUrl, message),
      signal: AbortSignal.timeout(ALERT_WEBHOOK_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
