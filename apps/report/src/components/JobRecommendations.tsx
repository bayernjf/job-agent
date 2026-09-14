/**
 * JobRecommendations——报告页「为你推荐的岗位」React island。
 * 调 GET /profiles/:id/job-recommendations，展示匹配分 / 命中技能 / 岗位链接。
 * 所有用户可见文案由 Astro 服务端通过 props 传入（i18n 在服务端完成，组件不硬编码文案）。
 */
import { useEffect, useState } from 'react';

interface JobMatchItem {
  score: number;
  matchedSkills: string[];
  posting: {
    title: string;
    company: string;
    location?: string | null;
    remote?: boolean;
    sourceUrl: string;
    postedAt?: string;
    source?: string;
  };
}

interface JobRecommendationsProps {
  profileId: string;
  apiBase: string;
  locale: string;
  title: string;
  loadingText: string;
  errorText: string;
  emptyText: string;
  scoreLabel: string;
  matchedSkillsLabel: string;
  viewJobLabel: string;
  remoteLabel: string;
}

const MAX_DISPLAY = 10;

function formatDate(iso: string | undefined, locale: string): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(locale === 'zh-CN' ? 'zh-CN' : 'en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return '';
  }
}

/** 匹配分→语义色（复用真实性四态色板的 CSS 变量，不新增色） */
function scoreClass(score: number): string {
  if (score >= 6) return 'rec-score--high';
  if (score >= 3) return 'rec-score--mid';
  return 'rec-score--low';
}

export default function JobRecommendations(props: JobRecommendationsProps) {
  const {
    profileId,
    apiBase,
    locale,
    title,
    loadingText,
    errorText,
    emptyText,
    scoreLabel,
    matchedSkillsLabel,
    viewJobLabel,
    remoteLabel,
  } = props;

  const [matches, setMatches] = useState<JobMatchItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const url = `${apiBase}/profiles/${encodeURIComponent(profileId)}/job-recommendations?limit=${MAX_DISPLAY}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { matches: JobMatchItem[] };
        if (!cancelled) setMatches(data.matches ?? []);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [profileId, apiBase]);

  return (
    <section className="ja-card job-recs">
      <h2>{title}</h2>

      {loading && (
        <p className="ja-muted rec-status" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          {loadingText}
        </p>
      )}

      {error && (
        <p className="rec-error" role="alert">
          {errorText}: {error}
        </p>
      )}

      {!loading && !error && matches && matches.length === 0 && (
        <p className="ja-muted rec-status">{emptyText}</p>
      )}

      {!loading && !error && matches && matches.length > 0 && (
        <ul className="rec-list">
          {matches.map((m, i) => (
            <li key={`${m.posting.sourceUrl}-${i}`} className="rec-item">
              <div className="rec-item-head">
                <a
                  href={m.posting.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rec-title"
                >
                  {m.posting.title}
                </a>
                <span className={`rec-score ${scoreClass(m.score)}`} title={scoreLabel}>
                  {m.score}
                </span>
              </div>
              <div className="rec-item-meta">
                <span className="ja-muted">{m.posting.company}</span>
                {m.posting.remote && <span className="rec-badge">{remoteLabel}</span>}
                {m.posting.location && <span className="ja-muted">{m.posting.location}</span>}
                {m.posting.postedAt && (
                  <span className="ja-muted">{formatDate(m.posting.postedAt, locale)}</span>
                )}
              </div>
              {m.matchedSkills.length > 0 && (
                <div className="rec-skills">
                  <span className="ja-muted rec-skills-label">{matchedSkillsLabel}:</span>
                  <span className="tag-list">
                    {m.matchedSkills.map((s) => (
                      <span key={s} className="skill-tag skill-tag--proficient">
                        {s}
                      </span>
                    ))}
                  </span>
                </div>
              )}
              <a
                href={m.posting.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="rec-view-link"
              >
                {viewJobLabel} →
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
