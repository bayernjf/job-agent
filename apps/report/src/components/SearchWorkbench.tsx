/**
 * 全网搜岗岛（design-websearch-job-discovery-20261008 §5 UI）。
 *
 * 用户用自然语言指令发起一次搜岗（POST /agent/search），轮询任务状态直到终态，
 * 再拉取本次入库结果（GET /agent/search/:id/results）并展示；右侧为筛选条件预设
 * 列表（保存/删除/一键再搜）。i18n 在服务端完成——所有用户可见文案经 labels
 * 传入，岛内零硬编码（对齐 workbench.astro 既有约定）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export interface SearchPresetView {
  presetId: string;
  title: string | null;
  query: string;
  conditions: {
    queries: string[];
    location?: string | null;
    remote?: boolean;
    salaryMinUsd?: number | null;
    keywords?: string[];
  };
  createdAt: string;
  updatedAt: string;
}

export interface SearchRunStatusView {
  runId: string;
  query: string;
  status: 'queued' | 'running' | 'done' | 'partial' | 'failed';
  resultsCount: number;
  newCount: number;
  matchedCount: number;
  error: string | null;
}

export interface SearchResultPosting {
  id: string;
  title: string;
  company: string;
  location: string | null;
  remote: boolean;
  salaryMin: number | null;
  salaryMax: number | null;
  tags: string[];
  sourceUrl: string;
  applyUrl: string;
  description: string | null;
}

export interface SearchWorkbenchLabels {
  title: string;
  hint: string;
  queryLabel: string;
  queryPlaceholder: string;
  locationLabel: string;
  locationPlaceholder: string;
  remoteLabel: string;
  salaryLabel: string;
  salaryPlaceholder: string;
  start: string;
  searching: string;
  status: {
    queued: string;
    running: string;
    done: string;
    partial: string;
    failed: string;
  };
  resultsTitle: string;
  resultsEmpty: string;
  newCount: string;
  resultsCount: string;
  presetsTitle: string;
  presetsEmpty: string;
  presetSave: string;
  presetSaved: string;
  presetDelete: string;
  presetTitleLabel: string;
  presetTitlePlaceholder: string;
  presetUse: string;
  remote: string;
  apply: string;
  error: string;
  companyLabel: string;
  locationUnknown: string;
  salaryFormat: string;
  noSearchYet: string;
  siteLabel: string;
}

export interface SearchWorkbenchProps {
  apiBase: string;
  locale: string;
  labels: SearchWorkbenchLabels;
}

type RunStatus = SearchRunStatusView['status'];

const TERMINAL: ReadonlySet<RunStatus> = new Set(['done', 'partial', 'failed']);

export default function SearchWorkbench(props: SearchWorkbenchProps) {
  const { apiBase, labels } = props;

  const [query, setQuery] = useState('');
  const [location, setLocation] = useState('');
  const [remote, setRemote] = useState(false);
  const [salaryMinUsd, setSalaryMinUsd] = useState('');
  const [presetTitle, setPresetTitle] = useState('');

  const [presets, setPresets] = useState<SearchPresetView[]>([]);
  const [presetsLoading, setPresetsLoading] = useState(true);

  const [run, setRun] = useState<SearchRunStatusView | null>(null);
  const [results, setResults] = useState<SearchResultPosting[] | null>(null);
  const [started, setStarted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savingPreset, setSavingPreset] = useState(false);
  const [presetNote, setPresetNote] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPoll = useCallback(() => {
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const loadPresets = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/agent/search-presets`, {
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { presets: SearchPresetView[] };
      setPresets(data.presets);
    } catch {
      // 预设列表加载失败不阻塞搜岗主流程
    } finally {
      setPresetsLoading(false);
    }
  }, [apiBase]);

  useEffect(() => {
    void loadPresets();
    return () => clearPoll();
  }, [loadPresets, clearPoll]);

  /** 轮询任务直到终态，然后拉取本次结果。 */
  const startSearch = useCallback(
    async (presetId?: string) => {
      clearPoll();
      setStarted(true);
      setError(null);
      setResults(null);
      setRun(null);
      const body = presetId
        ? { presetId }
        : {
            query,
            conditions: {
              queries: [query],
              location: location.trim() || null,
              remote,
              salaryMinUsd: salaryMinUsd ? Number(salaryMinUsd) : null,
            },
          };
      try {
        const res = await fetch(`${apiBase}/agent/search`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error ?? `HTTP ${res.status}`);
        }
        const { runId } = (await res.json()) as { runId: string };
        pollRun(runId);
      } catch (err) {
        setError((err as Error).message);
        setStarted(false);
      }
    },
    [apiBase, query, location, remote, salaryMinUsd, clearPoll],
  );

  const pollRun = useCallback(
    (runId: string) => {
      const tick = async () => {
        try {
          const res = await fetch(`${apiBase}/agent/search/${encodeURIComponent(runId)}`, {
            credentials: 'include',
          });
          if (!res.ok) {
            const data = (await res.json().catch(() => ({}))) as { error?: string };
            throw new Error(data.error ?? `HTTP ${res.status}`);
          }
          const data = (await res.json()) as { run: SearchRunStatusView };
          setRun(data.run);
          if (TERMINAL.has(data.run.status)) {
            const rr = await fetch(
              `${apiBase}/agent/search/${encodeURIComponent(runId)}/results`,
              { credentials: 'include' },
            );
            if (rr.ok) {
              const rd = (await rr.json()) as { postings: SearchResultPosting[] };
              setResults(rd.postings);
            }
            return;
          }
          pollRef.current = setTimeout(() => void tick(), 2500);
        } catch (err) {
          setError((err as Error).message);
          setStarted(false);
        }
      };
      void tick();
    },
    [apiBase],
  );

  const savePreset = useCallback(async () => {
    setSavingPreset(true);
    setPresetNote(null);
    try {
      const res = await fetch(`${apiBase}/agent/search-presets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          query,
          ...(presetTitle.trim() ? { title: presetTitle.trim() } : {}),
          conditions: {
            queries: [query],
            location: location.trim() || null,
            remote,
            salaryMinUsd: salaryMinUsd ? Number(salaryMinUsd) : null,
          },
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      await loadPresets();
      setPresetNote(labels.presetSaved);
      setPresetTitle('');
    } catch (err) {
      setPresetNote((err as Error).message);
    } finally {
      setSavingPreset(false);
    }
  }, [apiBase, query, location, remote, salaryMinUsd, presetTitle, loadPresets, labels.presetSaved]);

  const deletePreset = useCallback(
    async (presetId: string) => {
      try {
        const res = await fetch(
          `${apiBase}/agent/search-presets/${encodeURIComponent(presetId)}`,
          { method: 'DELETE', credentials: 'include' },
        );
        if (!res.ok) return;
        setPresets((prev) => prev.filter((p) => p.presetId !== presetId));
      } catch {
        // 删除失败静默：下次加载会纠正列表
      }
    },
    [apiBase],
  );

  const statusText = (status: RunStatus): string =>
    labels.status[status] ?? status;

  return (
    <section className="search-workbench ja-card" data-testid="search-workbench">
      <header className="search-workbench__header">
        <h2>{labels.title}</h2>
        <p className="ja-muted">{labels.hint}</p>
      </header>

      <div className="search-workbench__grid">
        <div className="search-workbench__main">
          <form
            className="ja-form"
            onSubmit={(e) => {
              e.preventDefault();
              void startSearch();
            }}
          >
            <label className="ja-field">
              <span>{labels.queryLabel}</span>
              <textarea
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={labels.queryPlaceholder}
                rows={2}
                data-testid="search-query"
              />
            </label>
            <div className="search-workbench__filters">
              <label className="ja-field">
                <span>{labels.locationLabel}</span>
                <input
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder={labels.locationPlaceholder}
                />
              </label>
              <label className="ja-field search-workbench__remote">
                <input
                  type="checkbox"
                  checked={remote}
                  onChange={(e) => setRemote(e.target.checked)}
                />
                <span>{labels.remoteLabel}</span>
              </label>
              <label className="ja-field">
                <span>{labels.salaryLabel}</span>
                <input
                  type="number"
                  min={0}
                  value={salaryMinUsd}
                  onChange={(e) => setSalaryMinUsd(e.target.value)}
                  placeholder={labels.salaryPlaceholder}
                />
              </label>
            </div>
            <div className="search-workbench__actions">
              <button
                type="submit"
                className="ja-btn ja-btn--primary"
                disabled={started || query.trim().length === 0}
                data-testid="search-start"
              >
                {started ? labels.searching : labels.start}
              </button>
              <button
                type="button"
                className="ja-btn"
                disabled={savingPreset || query.trim().length === 0}
                onClick={() => void savePreset()}
                data-testid="search-save-preset"
              >
                {savingPreset ? labels.searching : labels.presetSave}
              </button>
              <label className="ja-field search-workbench__preset-title">
                <input
                  value={presetTitle}
                  onChange={(e) => setPresetTitle(e.target.value)}
                  placeholder={labels.presetTitlePlaceholder}
                />
              </label>
            </div>
            {presetNote && <p className="ja-muted search-workbench__note">{presetNote}</p>}
          </form>

          {error && <p className="ja-error" data-testid="search-error">{labels.error}: {error}</p>}

          {started && (
            <div className="search-workbench__run" data-testid="search-run">
              {run ? (
                <>
                  <p>
                    <span className="ja-chip">{statusText(run.status)}</span>{' '}
                    <span className="ja-muted">{run.query}</span>
                    {run.error && <span className="ja-muted"> · {run.error}</span>}
                  </p>
                  <p className="ja-muted">
                    {labels.newCount}: {run.newCount} · {labels.resultsCount}:{' '}
                    {run.resultsCount}
                  </p>
                </>
              ) : (
                <p className="ja-muted">{labels.searching}</p>
              )}

              {results && results.length > 0 && (
                <ul className="search-workbench__results" data-testid="search-results">
                  {results.map((p) => (
                    <li key={p.id} className="search-workbench__result">
                      <div className="search-workbench__result-main">
                        <a
                          href={p.applyUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="search-workbench__result-title"
                        >
                          {p.title}
                        </a>
                        <p className="ja-muted">
                          {p.company}
                          {p.location ? ` · ${p.location}` : ` · ${labels.locationUnknown}`}
                          {p.remote ? ` · ${labels.remote}` : ''}
                          {p.salaryMin != null
                            ? ` · ${p.salaryMax != null ? labels.salaryFormat.replace('{min}', String(p.salaryMin)).replace('{max}', String(p.salaryMax)) : labels.salaryFormat.replace('{min}', String(p.salaryMin)).replace('–{max}', '')}`
                            : ''}
                        </p>
                        {p.tags.length > 0 && (
                          <p className="search-workbench__tags">
                            {p.tags.map((t) => (
                              <span key={t} className="ja-chip ja-chip--small">{t}</span>
                            ))}
                          </p>
                        )}
                        {p.description && (
                          <p className="ja-muted search-workbench__desc">
                            {p.description.slice(0, 240)}
                          </p>
                        )}
                      </div>
                      <div className="search-workbench__result-side">
                        <a href={p.applyUrl} target="_blank" rel="noreferrer" className="ja-btn">
                          {labels.apply}
                        </a>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {results && results.length === 0 && (
                <p className="ja-muted" data-testid="search-results-empty">{labels.resultsEmpty}</p>
              )}
            </div>
          )}
          {!started && !run && !error && (
            <p className="ja-muted">{labels.noSearchYet}</p>
          )}
        </div>

        <aside className="search-workbench__presets">
          <h3>{labels.presetsTitle}</h3>
          {presetsLoading ? (
            <p className="ja-muted">{labels.searching}</p>
          ) : presets.length === 0 ? (
            <p className="ja-muted">{labels.presetsEmpty}</p>
          ) : (
            <ul className="search-workbench__preset-list" data-testid="search-presets">
              {presets.map((p) => (
                <li key={p.presetId} className="search-workbench__preset">
                  <button
                    type="button"
                    className="search-workbench__preset-use"
                    onClick={() => {
                      setQuery(p.query);
                      void startSearch(p.presetId);
                    }}
                    title={labels.presetUse}
                  >
                    <strong>{p.title ?? p.query}</strong>
                    <span className="ja-muted">{p.query}</span>
                  </button>
                  <button
                    type="button"
                    className="ja-btn ja-btn--ghost"
                    onClick={() => void deletePreset(p.presetId)}
                    aria-label={labels.presetDelete}
                  >
                    {labels.presetDelete}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
    </section>
  );
}
