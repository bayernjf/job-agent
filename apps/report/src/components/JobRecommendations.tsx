/**
 * JobRecommendations——报告页「为你推荐的岗位」React island。
 * 调 GET /profiles/:id/job-recommendations，展示匹配分 / 命中技能 / 岗位链接，
 * 并可展开「匹配依据」（决策 #10）：分数在标题/标签/岗位描述上的分解，
 * 以及每个命中技能在画像中可回溯的 GitHub 证据（claim + 原始链接）。
 * 所有用户可见文案由 Astro 服务端通过 props 传入（i18n 在服务端完成，组件不硬编码文案）。
 * 对缺少 fieldScores/skillReasons/evidence 的旧响应保持健壮：回退到仅展示命中技能。
 */
import { useEffect, useState } from 'react';

type MatchField = 'title' | 'tags' | 'description';

interface FieldScores {
  title: number;
  tags: number;
  description: number;
}

interface SkillReason {
  skill: string;
  score: number;
  fields: MatchField[];
  kind: 'language' | 'framework' | 'domain';
  depth: 'used' | 'proficient';
  confidence: number;
  evidenceRefs: string[];
}

interface EvidenceBrief {
  sourceType: string;
  url: string;
  claim: string;
}

interface JobMatchItem {
  score: number;
  matchedSkills: string[];
  fieldScores?: FieldScores;
  skillReasons?: SkillReason[];
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

interface JobRecommendationsResponse {
  matches: JobMatchItem[];
  evidence?: Record<string, EvidenceBrief>;
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
  basisLabel: string;
  fieldTitleLabel: string;
  fieldTagsLabel: string;
  fieldDescriptionLabel: string;
  depthUsedLabel: string;
  depthProficientLabel: string;
  evidenceCountTemplate: string;
  viewEvidenceLabel: string;
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

/** 运行时填充 {count} 占位（模板来自服务端 i18n，组件不持有文案）。 */
function fillCount(template: string, count: number): string {
  return template.replace(/\{count\}/g, String(count));
}

/** 收集一条匹配命中技能引用到的、且在证据字典中存在的证据（按引用顺序去重）。 */
function collectMatchEvidence(
  reasons: SkillReason[] | undefined,
  dict: Record<string, EvidenceBrief> | undefined,
): EvidenceBrief[] {
  if (!reasons || !dict) return [];
  const seen = new Set<string>();
  const out: EvidenceBrief[] = [];
  for (const ref of reasons.flatMap((r) => r.evidenceRefs)) {
    if (seen.has(ref)) continue;
    const brief = dict[ref];
    if (brief) {
      seen.add(ref);
      out.push(brief);
    }
  }
  return out;
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
    basisLabel,
    fieldTitleLabel,
    fieldTagsLabel,
    fieldDescriptionLabel,
    depthUsedLabel,
    depthProficientLabel,
    evidenceCountTemplate,
    viewEvidenceLabel,
  } = props;

  const [data, setData] = useState<JobRecommendationsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const matches = data?.matches ?? null;

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const url = `${apiBase}/profiles/${encodeURIComponent(profileId)}/job-recommendations?limit=${MAX_DISPLAY}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as JobRecommendationsResponse;
        if (!cancelled) {
          setData({ matches: body.matches ?? [], evidence: body.evidence ?? {} });
        }
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

  const fieldLabels: Array<[MatchField, string]> = [
    ['title', fieldTitleLabel],
    ['tags', fieldTagsLabel],
    ['description', fieldDescriptionLabel],
  ];

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
          {matches.map((m, i) => {
            const reasons = m.skillReasons && m.skillReasons.length > 0 ? m.skillReasons : undefined;
            const evidenceItems = collectMatchEvidence(reasons, data?.evidence);
            const showBasis = (m.fieldScores !== undefined) || evidenceItems.length > 0;
            return (
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

                {((reasons ? reasons.map((r) => r.skill) : m.matchedSkills).length > 0) && (
                  <div className="rec-skills">
                    <span className="ja-muted rec-skills-label">{matchedSkillsLabel}:</span>
                    <span className="tag-list">
                      {reasons
                        ? reasons.map((r) => {
                            const depthLabel =
                              r.depth === 'proficient' ? depthProficientLabel : depthUsedLabel;
                            const chipTitle =
                              r.evidenceRefs.length > 0
                                ? `${depthLabel} · ${fillCount(evidenceCountTemplate, r.evidenceRefs.length)}`
                                : depthLabel;
                            return (
                              <span
                                key={r.skill}
                                className={`skill-tag skill-tag--${r.depth}`}
                                title={chipTitle}
                              >
                                {r.skill}
                              </span>
                            );
                          })
                        : m.matchedSkills.map((s) => (
                            <span key={s} className="skill-tag skill-tag--proficient">
                              {s}
                            </span>
                          ))}
                    </span>
                  </div>
                )}

                {showBasis && (
                  <details className="rec-basis">
                    <summary>
                      {basisLabel}
                      {evidenceItems.length > 0 && (
                        <span className="rec-basis-count">
                          {' '}
                          ({fillCount(evidenceCountTemplate, evidenceItems.length)})
                        </span>
                      )}
                    </summary>
                    {m.fieldScores && (
                      <div className="rec-basis-fields">
                        {fieldLabels
                          .filter(([key]) => m.fieldScores![key] > 0)
                          .map(([key, label]) => (
                            <span key={key} className="rec-field-chip">
                              {label} ×{m.fieldScores![key]}
                            </span>
                          ))}
                      </div>
                    )}
                    {evidenceItems.length > 0 && (
                      <ul className="rec-evidence">
                        {evidenceItems.map((e, j) => (
                          <li key={`${e.url}-${j}`}>
                            <span className="rec-evidence-type">{e.sourceType}</span>
                            <a
                              href={e.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              title={viewEvidenceLabel}
                            >
                              {e.claim}
                            </a>
                          </li>
                        ))}
                      </ul>
                    )}
                  </details>
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
            );
          })}
        </ul>
      )}
    </section>
  );
}
