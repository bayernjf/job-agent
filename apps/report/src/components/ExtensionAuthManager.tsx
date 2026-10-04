/**
 * ExtensionAuthManager——工作台「浏览器扩展授权」island（决策 #22，design-扩展登录态 §7）。
 *
 * 扩展登录态：工作台签发一次性授权码（5 分钟单次消费）→ 扩展兑换长期 API Token（Bearer）。
 * 本面板负责：①签发授权码（复制给扩展粘贴）；②列出已授权 token（仅指纹尾 4 位）；
 * ③撤销 token（立即失效）。零硬编码文案：字符串由 Astro 服务端经 labels 传入；
 * 样式只用 var(--ja-*) token 与全局工具类。
 *
 * 数据流：mount 拉 GET /auth/extension-tokens（401=未登录，隐藏面板）；
 * 签发 POST /auth/extension-token/issue（200 返回 code，5 分钟过期）；
 * 撤销 DELETE /auth/extension-tokens/:id（204，随后刷新列表）。
 */
import { useCallback, useEffect, useState } from 'react';

export interface ExtensionAuthLabels {
  title: string;
  subtitle: string;
  hint: string;
  issue: string;
  issuing: string;
  issuedTitle: string;
  issuedBody: string;
  codeExpires: string;
  copy: string;
  copied: string;
  listEmpty: string;
  fingerprint: string;
  createdAt: string;
  expiresAt: string;
  revoke: string;
  revokeConfirm: string;
  loadFailed: string;
  issueFailed: string;
  revokeFailed: string;
  notLoggedIn: string;
}

interface ExtensionAuthManagerProps {
  apiBase: string;
  locale: 'zh-CN' | 'en';
  labels: ExtensionAuthLabels;
}

interface TokenSummary {
  id: string;
  fingerprint: string;
  name: string;
  createdAt: string;
  lastSeenAt: string | null;
  expiresAt: string;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'issuing' }
  | { kind: 'revoking' }
  | { kind: 'error'; message: string };

export default function ExtensionAuthManager({ apiBase, locale, labels }: ExtensionAuthManagerProps) {
  const [tokens, setTokens] = useState<TokenSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loggedIn, setLoggedIn] = useState(true);
  const [code, setCode] = useState<string | null>(null);
  const [codeExpiresAt, setCodeExpiresAt] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/auth/extension-tokens`, {
        method: 'GET',
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      if (res.status === 401) {
        setLoggedIn(false);
        setLoaded(true);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { tokens: TokenSummary[] };
      setTokens(body.tokens);
      setLoggedIn(true);
      setLoaded(true);
    } catch {
      setMessage(labels.loadFailed);
      setLoaded(true);
    }
  }, [apiBase, labels.loadFailed]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const issue = async () => {
    setStatus({ kind: 'issuing' });
    setMessage(null);
    setCopied(false);
    try {
      const res = await fetch(`${apiBase}/auth/extension-token/issue`, {
        method: 'POST',
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      if (res.status === 401) {
        setLoggedIn(false);
        setStatus({ kind: 'idle' });
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { code: string; expiresAt: string };
      setCode(body.code);
      setCodeExpiresAt(body.expiresAt);
      setStatus({ kind: 'idle' });
    } catch {
      setStatus({ kind: 'error', message: labels.issueFailed });
    }
  };

  const copyCode = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      setMessage(labels.issueFailed);
    }
  };

  const revoke = async (id: string) => {
    if (!window.confirm(labels.revokeConfirm)) return;
    setStatus({ kind: 'revoking' });
    setMessage(null);
    try {
      const res = await fetch(`${apiBase}/auth/extension-tokens/${id}`, { method: 'DELETE', credentials: 'include' });
      if (res.status === 401) {
        setLoggedIn(false);
        setStatus({ kind: 'idle' });
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatus({ kind: 'idle' });
      await refresh();
    } catch {
      setStatus({ kind: 'error', message: labels.revokeFailed });
    }
  };

  if (!loaded) return null;
  if (!loggedIn) return null;

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleString(locale === 'zh-CN' ? 'zh-CN' : 'en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
    });

  return (
    <section className="ja-card" data-testid="extension-auth-manager">
      <h2>{labels.title}</h2>
      <p className="ja-muted">{labels.subtitle}</p>
      <p className="ja-muted">{labels.hint}</p>

      {message ? <p className="ja-alert ja-alert--error" role="alert">{message}</p> : null}

      <div className="ja-flex">
        <button
          type="button"
          className="ja-btn"
          disabled={status.kind === 'issuing'}
          onClick={() => void issue()}
        >
          {status.kind === 'issuing' ? labels.issuing : labels.issue}
        </button>
      </div>

      {code ? (
        <div className="ja-alert" data-testid="issued-code">
          <p>{labels.issuedTitle}</p>
          <p>{labels.issuedBody}</p>
          <code>{code}</code>
          {codeExpiresAt ? <p className="ja-muted">{labels.codeExpires}: {formatDate(codeExpiresAt)}</p> : null}
          <button type="button" className="ja-btn" onClick={() => void copyCode()}>
            {copied ? labels.copied : labels.copy}
          </button>
        </div>
      ) : null}

      <div className="">
        {tokens.length === 0 ? (
          <p className="ja-muted">{labels.listEmpty}</p>
        ) : (
          <ul className="" data-testid="extension-token-list">
            {tokens.map((t) => (
              <li key={t.id} className="ja-flex-between">
                <div>
                  <span className="ja-badge">…{t.fingerprint}</span>
                  <span className="ja-muted">
                    {' '}
                    · {labels.createdAt}: {formatDate(t.createdAt)} · {labels.expiresAt}:{' '}
                    {formatDate(t.expiresAt)}
                  </span>
                </div>
                <button
                  type="button"
                  className="ja-btn ja-btn--ghost"
                  disabled={status.kind === 'revoking'}
                  onClick={() => void revoke(t.id)}
                >
                  {labels.revoke}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
