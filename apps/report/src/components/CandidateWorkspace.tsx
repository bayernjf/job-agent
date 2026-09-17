/**
 * CandidateWorkspace——企业侧「人才筛选工作台」React island（痛点解决方案批次 2，P-A/P-B）。
 * 调 GET /candidates 检索已生成的可信画像（只读，不触发新采集），
 * 支持关键词/技能/真实性/置信度/平台/排序过滤、分页与本机收藏（shortlist，localStorage）。
 * 点击卡片跳转到报告页招聘方核验视图（/<locale>/report/<id>?view=recruiter）。
 * 所有用户可见文案由 Astro 服务端通过 props 传入（组件不硬编码文案）。
 */
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { authenticityClass } from '../lib/format';

type AuthenticityStatus =
  | 'likely_authentic'
  | 'mixed_signals'
  | 'suspicious'
  | 'insufficient_data';

interface CandidateSkill {
  name: string;
  kind: 'language' | 'framework' | 'domain';
  depth: 'used' | 'proficient';
  confidence: number;
}

interface Candidate {
  profileId: string;
  platform: string;
  login: string;
  displayName?: string;
  avatarUrl?: string;
  profileUrl: string;
  claimed: boolean;
  headline: string;
  seniorityBand?: string;
  authenticity: { status: AuthenticityStatus; confidence: number };
  skills: CandidateSkill[];
  skillCount: number;
  matchedSkills: string[];
  updatedAt: string;
}

interface WorkspaceLabels {
  keyword: string;
  keywordPlaceholder: string;
  skills: string;
  skillsPlaceholder: string;
  skillMatch: string;
  skillMatchAny: string;
  skillMatchAll: string;
  authenticity: string;
  authenticityAny: string;
  minConfidence: string;
  platform: string;
  platformAll: string;
  platformGithub: string;
  platformGitee: string;
  platformFused: string;
  fusedBadge: string;
  fusedBadgeTitle: string;
  sortBy: string;
  sortConfidence: string;
  sortSkills: string;
  sortRecent: string;
  search: string;
  reset: string;
  searching: string;
  loading: string;
  error: string;
  empty: string;
  resultsCount: string;
  viewReport: string;
  skillCount: string;
  matchedSkills: string;
  updatedAt: string;
  confidence: string;
  shortlist: string;
  shortlisted: string;
  shortlistTitle: string;
  prev: string;
  next: string;
  authenticityLabels: Record<AuthenticityStatus, string>;
}

interface Props {
  apiBase: string;
  locale: string;
  reportBasePath: string;
  /** SSR 首屏候选人（只读 storage 直取），挂载时直接渲染、不立即请求 API */
  initialItems: Candidate[];
  initialTotal: number;
  labels: WorkspaceLabels;
}

const PAGE_SIZE = 12;
const SHORTLIST_KEY = 'jobagent.shortlist';
const MAX_VISIBLE_SKILLS = 8;

function readShortlist(): string[] {
  try {
    const raw = localStorage.getItem(SHORTLIST_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function formatDate(iso: string, locale: string): string {
  try {
    return new Date(iso).toLocaleDateString(locale === 'zh-CN' ? 'zh-CN' : 'en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

export default function CandidateWorkspace({
  apiBase,
  locale,
  reportBasePath,
  initialItems,
  initialTotal,
  labels,
}: Props) {
  const [keyword, setKeyword] = useState('');
  const [skills, setSkills] = useState('');
  const [skillMatch, setSkillMatch] = useState('any');
  const [authenticity, setAuthenticity] = useState('');
  const [minConfidence, setMinConfidence] = useState('');
  const [platform, setPlatform] = useState('');
  const [sortBy, setSortBy] = useState('confidence_desc');

  // committed 是点击搜索后真正用于请求的筛选（输入中不触发请求）
  const [committed, setCommitted] = useState<Record<string, string>>({});
  // 首屏用 SSR 注入的数据，loading 初始为 false、不立即打 API
  const [items, setItems] = useState<Candidate[] | null>(initialItems);
  const [total, setTotal] = useState(initialTotal);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shortlist, setShortlist] = useState<string[]>([]);
  const isFirstRun = useRef(true);

  useEffect(() => {
    setShortlist(readShortlist());
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(SHORTLIST_KEY, JSON.stringify(shortlist));
    } catch {
      // 隐私模式等场景静默失败，收藏仅本次会话有效
    }
  }, [shortlist]);

  useEffect(() => {
    // 首屏使用 SSR 注入的 initialItems，不在挂载时请求（避免无 API 反代时清空首屏）
    if (isFirstRun.current) {
      isFirstRun.current = false;
      return;
    }
    let cancelled = false;
    (async () => {
      setSearching(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(committed)) {
          if (value) params.set(key, value);
        }
        params.set('limit', String(PAGE_SIZE));
        params.set('offset', String(offset));
        const res = await fetch(`${apiBase}/candidates?${params.toString()}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { items: Candidate[]; total: number };
        if (!cancelled) {
          setItems(body.items ?? []);
          setTotal(body.total ?? 0);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) {
          setLoading(false);
          setSearching(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [committed, offset, apiBase]);

  function submit(e: FormEvent) {
    e.preventDefault();
    setOffset(0);
    setCommitted({
      keyword: keyword.trim(),
      skills: skills.trim(),
      skillMatch,
      authenticity,
      minConfidence,
      platform,
      sortBy,
    });
  }

  function reset() {
    setKeyword('');
    setSkills('');
    setSkillMatch('any');
    setAuthenticity('');
    setMinConfidence('');
    setPlatform('');
    setSortBy('confidence_desc');
    setOffset(0);
    setCommitted({});
  }

  function toggleShortlist(id: string) {
    setShortlist((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  const shortlistedCandidates = useMemo(
    () => (items ?? []).filter((c) => shortlist.includes(c.profileId)),
    [items, shortlist],
  );

  const fill = (template: string, value: number): string =>
    template.replace(/\{(total|count|date)\}/g, String(value));

  return (
    <div className="recruit">
      <form className="ja-card recruit-filters" onSubmit={submit}>
        <div className="recruit-field recruit-field--wide">
          <label htmlFor="recruit-keyword">{labels.keyword}</label>
          <input
            id="recruit-keyword"
            className="ja-input"
            value={keyword}
            placeholder={labels.keywordPlaceholder}
            onChange={(e) => setKeyword(e.target.value)}
          />
        </div>
        <div className="recruit-field recruit-field--wide">
          <label htmlFor="recruit-skills">{labels.skills}</label>
          <input
            id="recruit-skills"
            className="ja-input"
            value={skills}
            placeholder={labels.skillsPlaceholder}
            onChange={(e) => setSkills(e.target.value)}
          />
        </div>
        <div className="recruit-field">
          <label htmlFor="recruit-match">{labels.skillMatch}</label>
          <select
            id="recruit-match"
            className="ja-input"
            value={skillMatch}
            onChange={(e) => setSkillMatch(e.target.value)}
          >
            <option value="any">{labels.skillMatchAny}</option>
            <option value="all">{labels.skillMatchAll}</option>
          </select>
        </div>
        <div className="recruit-field">
          <label htmlFor="recruit-auth">{labels.authenticity}</label>
          <select
            id="recruit-auth"
            className="ja-input"
            value={authenticity}
            onChange={(e) => setAuthenticity(e.target.value)}
          >
            <option value="">{labels.authenticityAny}</option>
            <option value="likely_authentic">{labels.authenticityLabels.likely_authentic}</option>
            <option value="mixed_signals">{labels.authenticityLabels.mixed_signals}</option>
            <option value="suspicious">{labels.authenticityLabels.suspicious}</option>
            <option value="insufficient_data">{labels.authenticityLabels.insufficient_data}</option>
          </select>
        </div>
        <div className="recruit-field">
          <label htmlFor="recruit-conf">{labels.minConfidence}</label>
          <select
            id="recruit-conf"
            className="ja-input"
            value={minConfidence}
            onChange={(e) => setMinConfidence(e.target.value)}
          >
            <option value="">0%</option>
            <option value="0.5">50%</option>
            <option value="0.7">70%</option>
            <option value="0.8">80%</option>
            <option value="0.9">90%</option>
          </select>
        </div>
        <div className="recruit-field">
          <label htmlFor="recruit-platform">{labels.platform}</label>
          <select
            id="recruit-platform"
            className="ja-input"
            value={platform}
            onChange={(e) => setPlatform(e.target.value)}
          >
            <option value="">{labels.platformAll}</option>
            <option value="github">{labels.platformGithub}</option>
            <option value="gitee">{labels.platformGitee}</option>
            <option value="all">{labels.platformFused}</option>
          </select>
        </div>
        <div className="recruit-field">
          <label htmlFor="recruit-sort">{labels.sortBy}</label>
          <select
            id="recruit-sort"
            className="ja-input"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
          >
            <option value="confidence_desc">{labels.sortConfidence}</option>
            <option value="skill_count_desc">{labels.sortSkills}</option>
            <option value="recent">{labels.sortRecent}</option>
          </select>
        </div>
        <div className="recruit-actions">
          <button type="submit" className="ja-btn" disabled={searching}>
            {searching ? labels.searching : labels.search}
          </button>
          <button type="button" className="ja-btn ja-btn--ghost" onClick={reset}>
            {labels.reset}
          </button>
        </div>
      </form>

      {shortlist.length > 0 && (
        <details className="ja-card recruit-shortlist" open={false}>
          <summary>
            {labels.shortlistTitle.replace('{count}', String(shortlist.length))}
          </summary>
          <ul className="recruit-shortlist-list">
            {shortlistedCandidates.map((c) => (
              <li key={c.profileId}>
                <a href={`${reportBasePath}/${c.profileId}?view=recruiter`}>
                  {c.displayName ?? c.login}
                </a>
                <button
                  type="button"
                  className="recruit-shortlist-remove"
                  onClick={() => toggleShortlist(c.profileId)}
                  aria-label={labels.shortlist}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="recruit-results-meta">
        {!loading && !error && <span>{fill(labels.resultsCount, total)}</span>}
      </div>

      {loading && (
        <p className="ja-muted" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          {labels.loading}
        </p>
      )}
      {error && <p className="recruit-error" role="alert">{labels.error}: {error}</p>}
      {!loading && !error && items && items.length === 0 && <p className="ja-muted">{labels.empty}</p>}

      {!loading && !error && items && items.length > 0 && (
        <>
          <ul className="recruit-grid">
            {items.map((c) => {
              const isShortlisted = shortlist.includes(c.profileId);
              const matched = new Set(c.matchedSkills);
              const visible = c.skills.slice(0, MAX_VISIBLE_SKILLS);
              return (
                <li key={c.profileId} className="ja-card recruit-card">
                  <div className="recruit-card-head">
                    {c.avatarUrl ? (
                      <img src={c.avatarUrl} alt={c.login} className="recruit-avatar" width="48" height="48" />
                    ) : (
                      <span className="recruit-avatar recruit-avatar--placeholder">
                        {c.login.slice(0, 1).toUpperCase()}
                      </span>
                    )}
                    <div className="recruit-id">
                      <a
                        href={`${reportBasePath}/${c.profileId}?view=recruiter`}
                        className="recruit-name"
                      >
                        {c.displayName ?? c.login}
                      </a>
                      <span className="ja-muted recruit-login">
                        @{c.login} ·{' '}
                        {c.platform === 'all' ? (
                          <span
                            className="ja-badge ja-badge--fused"
                            title={labels.fusedBadgeTitle}
                          >
                            {labels.fusedBadge}
                          </span>
                        ) : (
                          c.platform
                        )}
                      </span>
                    </div>
                    <button
                      type="button"
                      className={`recruit-star${isShortlisted ? ' recruit-star--on' : ''}`}
                      onClick={() => toggleShortlist(c.profileId)}
                      aria-pressed={isShortlisted}
                      title={isShortlisted ? labels.shortlisted : labels.shortlist}
                    >
                      {isShortlisted ? '★' : '☆'}
                    </button>
                  </div>
                  <p className="recruit-headline">{c.headline}</p>
                  <div className="recruit-auth">
                    <span className={`ja-badge ${authenticityClass(c.authenticity.status)}`}>
                      {labels.authenticityLabels[c.authenticity.status]}
                    </span>
                    <span className="ja-muted">
                      {labels.confidence}: {Math.round(c.authenticity.confidence * 100)}%
                    </span>
                  </div>
                  {visible.length > 0 && (
                    <div className="tag-list recruit-tags">
                      {visible.map((s) => (
                        <span
                          key={s.name}
                          className={`skill-tag skill-tag--${s.depth}${
                            matched.has(s.name) ? ' recruit-tag--matched' : ''
                          }`}
                        >
                          {s.name}
                        </span>
                      ))}
                      {c.skillCount > visible.length && (
                        <span className="ja-muted recruit-more">
                          +{c.skillCount - visible.length}
                        </span>
                      )}
                    </div>
                  )}
                  <div className="recruit-card-footer">
                    <span className="ja-muted">{fill(labels.skillCount, c.skillCount)}</span>
                    <span className="ja-muted">
                      {labels.updatedAt.replace('{date}', formatDate(c.updatedAt, locale))}
                    </span>
                  </div>
                  <a
                    className="ja-btn ja-btn--ghost recruit-view"
                    href={`${reportBasePath}/${c.profileId}?view=recruiter`}
                  >
                    {labels.viewReport} →
                  </a>
                </li>
              );
            })}
          </ul>

          <nav className="recruit-pager" aria-label="pagination">
            <button
              type="button"
              className="ja-btn ja-btn--ghost"
              disabled={offset === 0 || searching}
              onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
            >
              ← {labels.prev}
            </button>
            <span className="ja-muted">
              {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} / {total}
            </span>
            <button
              type="button"
              className="ja-btn ja-btn--ghost"
              disabled={offset + PAGE_SIZE >= total || searching}
              onClick={() => setOffset((o) => o + PAGE_SIZE)}
            >
              {labels.next} →
            </button>
          </nav>
        </>
      )}
    </div>
  );
}
