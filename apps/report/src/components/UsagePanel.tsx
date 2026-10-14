/**
 * UsagePanel——报告页「用量与成本回采」island（决策 #25 ④，design-cost-metering-20261014 §7 Wave D）。
 *
 * 读侧 UI：调用 /account/usage（本人窗口聚合）与 /admin/usage（全平台，仅管理员），
 * 把 usage_events 的聚合结果渲染成表格。零硬编码文案：全部走 createTranslator。
 * 数据只读、不做任何写操作；窗口护栏在 API 侧（sinceIso 必填、≤180 天）。
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { createTranslator, type Locale } from '../i18n/index.js';

type UsageCategory = 'llm' | 'search' | 'analysis';
type UsageBillingSource = 'builtin' | 'byok' | 'platform';

interface UsageSummaryRow {
  category: UsageCategory;
  feature: string;
  billingSource: UsageBillingSource;
  events: number;
  sumPromptTokens: number;
  sumCompletionTokens: number;
  sumQuantity: number;
}

interface UsageDailyRow {
  day: string;
  category: UsageCategory;
  events: number;
  sumPromptTokens: number;
  sumCompletionTokens: number;
  sumQuantity: number;
}

interface UsageResponse {
  summary: UsageSummaryRow[];
  daily: UsageDailyRow[];
}

interface UsagePanelProps {
  apiBase: string;
  locale: Locale;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** datetime-local 输入需要 YYYY-MM-DDTHH:mm（本地时区），从 UTC ISO 截取前 16 位即可。 */
function toLocalInput(iso: string): string {
  return iso.slice(0, 16);
}

export default function UsagePanel({ apiBase, locale }: UsagePanelProps) {
  const t = createTranslator(locale);
  const [sinceIso, setSinceIso] = useState(() => new Date(Date.now() - 30 * DAY_MS).toISOString());
  const [untilIso, setUntilIso] = useState('');
  const [own, setOwn] = useState<UsageResponse | null>(null);
  const [all, setAll] = useState<UsageResponse | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');

  const categoryLabels: Record<string, string> = {
    llm: t('usage.cat.llm'),
    search: t('usage.cat.search'),
    analysis: t('usage.cat.analysis'),
  };
  const featureLabels: Record<string, string> = {
    cover_letter: t('usage.feature.cover_letter'),
    resume_polish: t('usage.feature.resume_polish'),
    jd_extraction: t('usage.feature.jd_extraction'),
    semantic_summary: t('usage.feature.semantic_summary'),
    websearch: t('usage.feature.websearch'),
    analysis_job: t('usage.feature.analysis_job'),
  };
  const billLabels: Record<string, string> = {
    builtin: t('usage.bill.builtin'),
    byok: t('usage.bill.byok'),
    platform: t('usage.bill.platform'),
  };
  const label = (map: Record<string, string>, key: string): string => map[key] ?? key;

  const load = useCallback(async () => {
    setStatus('loading');
    const params = new URLSearchParams({ sinceIso });
    if (untilIso.trim() !== '') params.set('untilIso', untilIso);
    try {
      const ownRes = await fetch(`${apiBase}/account/usage?${params.toString()}`, {
        credentials: 'include',
      });
      if (!ownRes.ok) {
        setStatus('error');
        return;
      }
      const ownData = (await ownRes.json()) as UsageResponse;
      setOwn(ownData);
      // 尝试全平台口径：非管理员返回 401/403，静默降级为不展示该段。
      try {
        const allRes = await fetch(`${apiBase}/admin/usage?${params.toString()}`, {
          credentials: 'include',
        });
        if (allRes.ok) {
          setAll((await allRes.json()) as UsageResponse);
          setIsAdmin(true);
        } else {
          setAll(null);
          setIsAdmin(false);
        }
      } catch {
        setAll(null);
        setIsAdmin(false);
      }
      setStatus('idle');
    } catch {
      setStatus('error');
    }
  }, [apiBase, sinceIso, untilIso]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleApply = (e: FormEvent) => {
    e.preventDefault();
    void load();
  };

  const renderSummary = (data: UsageResponse | null, emptyLabel: string) => {
    if (!data || data.summary.length === 0) {
      return (
        <p className="ja-muted" data-testid="usage-empty">
          {emptyLabel}
        </p>
      );
    }
    const totals = data.summary.reduce(
      (acc, r) => {
        acc.events += r.events;
        acc.prompt += r.sumPromptTokens;
        acc.completion += r.sumCompletionTokens;
        acc.quantity += r.sumQuantity;
        return acc;
      },
      { events: 0, prompt: 0, completion: 0, quantity: 0 },
    );
    return (
      <table data-testid="usage-summary">
        <thead>
          <tr>
            <th>{t('usage.category')}</th>
            <th>{t('usage.feature')}</th>
            <th>{t('usage.billingSource')}</th>
            <th>{t('usage.events')}</th>
            <th>{t('usage.promptTokens')}</th>
            <th>{t('usage.completionTokens')}</th>
            <th>{t('usage.quantity')}</th>
          </tr>
        </thead>
        <tbody>
          {data.summary.map((r) => (
            <tr key={`${r.category}:${r.feature}:${r.billingSource}`}>
              <td>{label(categoryLabels, r.category)}</td>
              <td>{label(featureLabels, r.feature)}</td>
              <td>{label(billLabels, r.billingSource)}</td>
              <td>{r.events}</td>
              <td>{r.sumPromptTokens}</td>
              <td>{r.sumCompletionTokens}</td>
              <td>{r.sumQuantity}</td>
            </tr>
          ))}
          <tr data-testid="usage-total">
            <td colSpan={3}>{t('usage.total')}</td>
            <td>{totals.events}</td>
            <td>{totals.prompt}</td>
            <td>{totals.completion}</td>
            <td>{totals.quantity}</td>
          </tr>
        </tbody>
      </table>
    );
  };

  const renderDaily = (data: UsageResponse | null) => {
    if (!data || data.daily.length === 0) return null;
    return (
      <table data-testid="usage-daily">
        <thead>
          <tr>
            <th>{t('usage.day')}</th>
            <th>{t('usage.category')}</th>
            <th>{t('usage.events')}</th>
            <th>{t('usage.promptTokens')}</th>
            <th>{t('usage.completionTokens')}</th>
            <th>{t('usage.quantity')}</th>
          </tr>
        </thead>
        <tbody>
          {data.daily.map((d) => (
            <tr key={`${d.day}:${d.category}`}>
              <td>{d.day}</td>
              <td>{label(categoryLabels, d.category as string)}</td>
              <td>{d.events}</td>
              <td>{d.sumPromptTokens}</td>
              <td>{d.sumCompletionTokens}</td>
              <td>{d.sumQuantity}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  };

  return (
    <section className="usage-panel ja-card" data-testid="usage-panel">
      <form className="usage-controls" onSubmit={handleApply}>
        <label className="ja-field">
          <span>{t('usage.since')}</span>
          <input
            type="datetime-local"
            value={toLocalInput(sinceIso)}
            onChange={(e) => setSinceIso(new Date(e.target.value).toISOString())}
            data-testid="usage-since"
          />
        </label>
        <label className="ja-field">
          <span>{t('usage.until')}</span>
          <input
            type="datetime-local"
            value={untilIso ? toLocalInput(untilIso) : ''}
            onChange={(e) =>
              setUntilIso(e.target.value ? new Date(e.target.value).toISOString() : '')
            }
            data-testid="usage-until"
          />
        </label>
        <button type="submit" className="ja-btn ja-btn--primary" data-testid="usage-apply">
          {t('usage.apply')}
        </button>
      </form>

      {status === 'loading' ? (
        <p className="ja-muted" data-testid="usage-loading">
          {t('usage.loading')}
        </p>
      ) : status === 'error' ? (
        <p className="ja-error" role="alert" data-testid="usage-error">
          {t('usage.loadFailed')}
        </p>
      ) : (
        <>
          <h2>{t('usage.ownTitle')}</h2>
          {renderSummary(own, t('usage.empty'))}
          {renderDaily(own)}

          {isAdmin ? (
            <>
              <h2>{t('usage.allTitle')}</h2>
              <p className="ja-muted">{t('usage.adminNote')}</p>
              {renderSummary(all, t('usage.empty'))}
              {renderDaily(all)}
            </>
          ) : null}
        </>
      )}
    </section>
  );
}
