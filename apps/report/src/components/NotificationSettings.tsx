/**
 * NotificationSettings——工作台「通知设置」island（决策 #25，
 * design-notification-channels-20261010 §8）。
 *
 * 两个通道共用同一份"有待确认候选"事实源，各自独立 opt-in：
 * - 邮件 digest：开关 + 目的邮箱；开＝PUT enabled:true（email 可省，省则沿用
 *   已有订阅/accounts.email，都没有则服务端 400 如实报 EMAIL_REQUIRED）；
 *   关＝PUT enabled:false（删订阅行）。
 * - Web Push：开＝注册 /push-sw.js + Notification.requestPermission +
 *   PushManager.subscribe(VAPID) + POST 订阅；关＝unsubscribe + DELETE。
 *   浏览器拒绝授权（denied）如实展示"浏览器已拒绝"，不假装成功。
 * 零硬编码文案：所有字符串由 Astro 服务端经 labels 传入；样式只用
 * var(--ja-*) token 与全局工具类。
 */
import { useCallback, useEffect, useState } from 'react';

export interface NotificationSettingsLabels {
  title: string;
  subtitle: string;
  emailTitle: string;
  emailHint: string;
  emailLabel: string;
  emailPlaceholder: string;
  emailRequired: string;
  pushTitle: string;
  pushHint: string;
  pushDenied: string;
  pushUnsupported: string;
  vapidMissing: string;
  enable: string;
  enabling: string;
  disable: string;
  disabling: string;
  enabledSince: string;
  lastSent: string;
  never: string;
  saveFailed: string;
  loadFailed: string;
}

interface Props {
  apiBase: string;
  locale: 'zh-CN' | 'en';
  labels: NotificationSettingsLabels;
}

interface SubView {
  id: string;
  channel: 'email_digest' | 'web_push';
  endpoint: string;
  enabled: boolean;
  lastSentAt: string | null;
  createdAt: string;
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export default function NotificationSettings({ apiBase, labels }: Props) {
  const [emailSub, setEmailSub] = useState<SubView | null>(null);
  const [pushSub, setPushSub] = useState<SubView | null>(null);
  const [emailInput, setEmailInput] = useState('');
  const [busy, setBusy] = useState<'email' | 'push' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pushState, setPushState] = useState<'ok' | 'denied' | 'unsupported' | 'no-vapid'>('ok');

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/agent/notifications`, { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { subscriptions: SubView[] };
      setEmailSub(data.subscriptions.find((s) => s.channel === 'email_digest') ?? null);
      setPushSub(data.subscriptions.find((s) => s.channel === 'web_push') ?? null);
      setError(null);
    } catch {
      setError(labels.loadFailed);
    }
  }, [apiBase, labels.loadFailed]);

  useEffect(() => {
    void load();
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      setPushState('unsupported');
    } else if (typeof Notification !== 'undefined' && Notification.permission === 'denied') {
      setPushState('denied');
    }
  }, [load]);

  const toggleEmail = async (enable: boolean) => {
    setBusy('email');
    setError(null);
    try {
      const res = await fetch(`${apiBase}/agent/notifications/email-digest`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          enable ? { enabled: true, ...(emailInput.trim() ? { email: emailInput.trim() } : {}) } : { enabled: false },
        ),
      });
      const data = (await res.json().catch(() => ({}))) as { code?: string };
      if (!res.ok) {
        setError(data.code === 'EMAIL_REQUIRED' ? labels.emailRequired : labels.saveFailed);
        return;
      }
      await load();
    } catch {
      setError(labels.saveFailed);
    } finally {
      setBusy(null);
    }
  };

  const togglePush = async (enable: boolean) => {
    setBusy('push');
    setError(null);
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        setPushState('unsupported');
        return;
      }
      const registration = await navigator.serviceWorker.register('/push-sw.js');
      if (!enable) {
        const existing = await registration.pushManager.getSubscription();
        if (existing) {
          await fetch(`${apiBase}/agent/notifications/web-push`, {
            method: 'DELETE',
            credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ endpoint: existing.endpoint }),
          });
          await existing.unsubscribe();
        }
        await load();
        return;
      }
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setPushState('denied');
        return;
      }
      const keyRes = await fetch(`${apiBase}/agent/notifications/vapid-key`, { credentials: 'include' });
      if (!keyRes.ok) {
        setPushState('no-vapid');
        return;
      }
      const { publicKey } = (await keyRes.json()) as { publicKey: string };
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
      });
      const key = subscription.getKey('p256dh');
      const auth = subscription.getKey('auth');
      if (!key || !auth) throw new Error('subscription keys missing');
      const toB64 = (buf: ArrayBuffer) =>
        btoa(String.fromCharCode(...new Uint8Array(buf)));
      const res = await fetch(`${apiBase}/agent/notifications/web-push`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          endpoint: subscription.endpoint,
          keys: { p256dh: toB64(key), auth: toB64(auth) },
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setPushState('ok');
      await load();
    } catch {
      setError(labels.saveFailed);
    } finally {
      setBusy(null);
    }
  };

  const fmt = (iso: string | null) =>
    iso ? new Date(iso).toLocaleString() : labels.never;

  return (
    <section className="ja-card" aria-label={labels.title}>
      <h2>{labels.title}</h2>
      <p className="ja-muted">{labels.subtitle}</p>

      <div className="ja-field" style={{ marginTop: 'var(--ja-space-4)' }}>
        <h3>{labels.emailTitle}</h3>
        <p className="ja-muted">{labels.emailHint}</p>
        {emailSub ? (
          <p className="ja-muted">
            {emailSub.endpoint} · {labels.lastSent}: {fmt(emailSub.lastSentAt)}
          </p>
        ) : (
          <label className="ja-field">
            <span>{labels.emailLabel}</span>
            <input
              className="ja-input"
              type="email"
              value={emailInput}
              placeholder={labels.emailPlaceholder}
              onChange={(e) => setEmailInput(e.target.value)}
            />
          </label>
        )}
        <button
          type="button"
          className="ja-btn ja-btn--ghost"
          disabled={busy !== null}
          onClick={() => void toggleEmail(!emailSub)}
        >
          {busy === 'email'
            ? emailSub
              ? labels.disabling
              : labels.enabling
            : emailSub
              ? labels.disable
              : labels.enable}
        </button>
      </div>

      <div className="ja-field" style={{ marginTop: 'var(--ja-space-4)' }}>
        <h3>{labels.pushTitle}</h3>
        <p className="ja-muted">{labels.pushHint}</p>
        {pushState === 'denied' && <p className="ja-alert ja-alert--warn">{labels.pushDenied}</p>}
        {pushState === 'unsupported' && <p className="ja-muted">{labels.pushUnsupported}</p>}
        {pushState === 'no-vapid' && <p className="ja-muted">{labels.vapidMissing}</p>}
        {pushSub && (
          <p className="ja-muted">
            {labels.enabledSince} {fmt(pushSub.createdAt)} · {labels.lastSent}: {fmt(pushSub.lastSentAt)}
          </p>
        )}
        {pushState === 'ok' && (
          <button
            type="button"
            className="ja-btn ja-btn--ghost"
            disabled={busy !== null}
            onClick={() => void togglePush(!pushSub)}
          >
            {busy === 'push'
              ? pushSub
                ? labels.disabling
                : labels.enabling
              : pushSub
                ? labels.disable
                : labels.enable}
          </button>
        )}
      </div>

      {error && <p className="ja-alert ja-alert--error">{error}</p>}
    </section>
  );
}
