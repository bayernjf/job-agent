/**
 * RecruiterPostings——招聘方自建 JD：发布私有岗位 + 「按这条岗位排候选人」
 * （决策 #25 的 B3-a 最小子集，2026-10-13）。
 *
 * 两条刻意的设计：
 * 1. 私有岗位只走 `/job-postings/recruiter*` 三个端点；它不进公开池（判据在仓储层），
 *    所以这里的列表不会和 C 端看到的岗位混在一起。
 * 2. 候选人排序**复用** `GET /candidates` 的 `skills` 过滤与 `matchedSkills` 高亮，
 *    不新建第二套候选人读取口——B 端只有一条"按条件找人"的路。
 *
 * 所有用户可见文案由 Astro 服务端通过 props 传入（组件不硬编码文案）。
 */
import { useEffect, useMemo, useState, type FormEvent } from 'react';

interface Posting {
  id: string;
  title: string;
  company: string;
  location?: string | null;
  remote: boolean;
  tags: string[];
  status: 'active' | 'inactive';
  postedAt: string;
}

interface RankedCandidate {
  profileId: string;
  login: string;
  displayName?: string;
  headline: string;
  matchedSkills: string[];
  verifiedClaimCount: number;
}

interface InterviewRow {
  id: string;
  profileId: string;
  roundLabel: string;
  scheduledStart: string;
  status: string;
  outcome: string | null;
}

/** B3-b：投到这条自建岗位的投递（GET /job-postings/recruiter/:id/applications） */
interface PostingApplication {
  id: string;
  profileId: string;
  targetTitle: string;
  targetCompany: string;
  targetUrl: string | null;
  appliedAt: string;
  status: string;
  stage: string | null;
}

interface CandidateBlock {
  loading: boolean;
  error: string | null;
  total: number;
  items: RankedCandidate[];
  interviewsLoading: boolean;
  interviewsError: string | null;
  interviews: InterviewRow[];
  applicationsLoading: boolean;
  applicationsError: string | null;
  applications: PostingApplication[];
  advancingId: string | null;
}

interface Labels {
  title: string;
  subtitle: string;
  formTitle: string;
  fieldTitle: string;
  fieldTitlePlaceholder: string;
  fieldCompany: string;
  fieldCompanyPlaceholder: string;
  fieldLocation: string;
  fieldRemote: string;
  fieldTags: string;
  fieldTagsPlaceholder: string;
  fieldDescription: string;
  submit: string;
  submitting: string;
  published: string;
  formError: string;
  listError: string;
  reload: string;
  empty: string;
  retire: string;
  retiring: string;
  statusActive: string;
  statusInactive: string;
  findCandidates: string;
  needTags: string;
  candidatesLoading: string;
  candidatesError: string;
  candidatesEmpty: string;
  candidatesCount: string;
  verifiedClaims: string;
  interviewsTitle: string;
  interviewsEmpty: string;
  interviewsError: string;
  applicationsTitle: string;
  applicationsEmpty: string;
  applicationsError: string;
  advanceStage: string;
  stageChangeFailed: string;
  stageLabels: Record<string, string>;
  statusLabels: Record<string, string>;
}

interface Props {
  apiBase: string;
  reportBasePath: string;
  locale: string;
  labels: Labels;
}

const EMPTY_CANDIDATES: CandidateBlock = {
  loading: false,
  error: null,
  total: 0,
  items: [],
  interviewsLoading: false,
  interviewsError: null,
  interviews: [],
  applicationsLoading: false,
  applicationsError: null,
  applications: [],
  advancingId: null,
};

/** B3-b：pipeline 单向前进顺序（用于渲染"下一阶段"按钮；'null'=尚未进入 pipeline，首推进落到 new；rejected/hired 为终态） */
const STAGE_NEXT: Record<string, string[]> = {
  null: ['new'],
  new: ['screening', 'rejected'],
  screening: ['interview', 'rejected'],
  interview: ['offer', 'rejected'],
  offer: ['hired', 'rejected'],
  hired: [],
  rejected: [],
};

/** 面试排期按读者语言环境格式化（服务端已给 UTC ISO8601，这里只做展示层转换）。 */
function formatWhen(iso: string, locale: string): string {
  const when = new Date(iso);
  return Number.isNaN(when.getTime())
    ? iso
    : new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(when);
}

function parseTags(raw: string): string[] {
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const tag = part.trim();
    if (tag) seen.add(tag);
  }
  return [...seen].slice(0, 25);
}

export default function RecruiterPostings({ apiBase, reportBasePath, locale, labels }: Props) {
  const [postings, setPostings] = useState<Posting[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [title, setTitle] = useState('');
  const [company, setCompany] = useState('');
  const [location, setLocation] = useState('');
  const [remote, setRemote] = useState(false);
  const [tags, setTags] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [published, setPublished] = useState(false);
  const [retiringId, setRetiringId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Record<string, CandidateBlock>>({});

  const tagList = useMemo(() => parseTags(tags), [tags]);

  async function loadList() {
    setListError(null);
    try {
      const res = await fetch(`${apiBase}/job-postings/recruiter?limit=100`, {
        credentials: 'include',
      });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { items: Posting[] };
      setPostings(body.items);
    } catch {
      setListError(labels.listError);
    } finally {
      setLoaded(true);
    }
  }

  useEffect(() => {
    void loadList();
    // 只在挂载时取一次；后续刷新由发布/下线的成功分支直接更新 state
  }, []);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    setPublished(false);
    if (!title.trim() || !company.trim()) {
      setFormError(labels.formError);
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`${apiBase}/job-postings/recruiter`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          company: company.trim(),
          location: location.trim() || undefined,
          remote,
          tags: tagList,
          description: description.trim() || undefined,
        }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const created = (await res.json()) as Posting;
      setPostings((prev) => [created, ...prev]);
      setTitle('');
      setCompany('');
      setLocation('');
      setTags('');
      setDescription('');
      setRemote(false);
      setPublished(true);
    } catch {
      setFormError(labels.formError);
    } finally {
      setSubmitting(false);
    }
  }

  async function retire(posting: Posting) {
    setRetiringId(posting.id);
    try {
      const res = await fetch(`${apiBase}/job-postings/recruiter/${encodeURIComponent(posting.id)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) throw new Error(String(res.status));
      const updated = (await res.json()) as Posting;
      setPostings((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
    } catch {
      setListError(labels.listError);
    } finally {
      setRetiringId(null);
    }
  }

  async function rankCandidates(posting: Posting) {
    if (expanded === posting.id) {
      setExpanded(null);
      return;
    }
    setExpanded(posting.id);
    if (candidates[posting.id]?.items.length) return;
    setCandidates((prev) => ({
      ...prev,
      [posting.id]: {
        ...EMPTY_CANDIDATES,
        loading: true,
        interviewsLoading: true,
        applicationsLoading: true,
      },
    }));
    const params = new URLSearchParams({
      skills: posting.tags.join(','),
      skillMatch: 'any',
      sortBy: 'skills',
      limit: '8',
    });
    // 三路读取并行：候选人（既有 /candidates 的技能过滤）+ 这条岗位已排的面试 +
    // 投到这条岗位的投递（B3-b pipeline）。面板就是这条岗位的 pipeline 视图——
    // "有谁命中、已经排到第几面、候选人走到哪一阶段"。
    const [candsRes, interviewsRes, appsRes] = await Promise.allSettled([
      fetch(`${apiBase}/candidates?${params.toString()}`, { credentials: 'include' }),
      fetch(`${apiBase}/interviews?postingId=${encodeURIComponent(posting.id)}`, {
        credentials: 'include',
      }),
      fetch(
        `${apiBase}/job-postings/recruiter/${encodeURIComponent(posting.id)}/applications`,
        { credentials: 'include' },
      ),
    ]);

    let block: CandidateBlock = {
      ...EMPTY_CANDIDATES,
      loading: false,
      interviewsLoading: false,
      applicationsLoading: false,
    };
    if (candsRes.status === 'fulfilled' && candsRes.value.ok) {
      const body = (await candsRes.value.json()) as { items: RankedCandidate[]; total: number };
      block = { ...block, total: body.total, items: body.items };
    } else {
      block = { ...block, error: labels.candidatesError };
    }
    if (interviewsRes.status === 'fulfilled' && interviewsRes.value.ok) {
      const body = (await interviewsRes.value.json()) as { items: InterviewRow[] };
      block = { ...block, interviews: body.items };
    } else {
      block = { ...block, interviewsError: labels.interviewsError };
    }
    if (appsRes.status === 'fulfilled' && appsRes.value.ok) {
      const body = (await appsRes.value.json()) as { items: PostingApplication[] };
      block = { ...block, applications: body.items };
    } else {
      block = { ...block, applicationsError: labels.applicationsError };
    }
    setCandidates((prev) => ({ ...prev, [posting.id]: block }));
  }

  /** B3-b：推进候选人 pipeline 阶段（PATCH /applications/:id/stage），成功后本地更新 */
  async function advance(postingId: string, applicationId: string, toStage: string) {
    const block = candidates[postingId];
    if (!block || block.advancingId) return;
    setCandidates((prev) => ({
      ...prev,
      [postingId]: { ...prev[postingId]!, advancingId: applicationId },
    }));
    try {
      const res = await fetch(
        `${apiBase}/applications/${encodeURIComponent(applicationId)}/stage`,
        {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ toStage }),
        },
      );
      if (!res.ok) throw new Error(String(res.status));
      const updated = (await res.json()) as PostingApplication;
      setCandidates((prev) => {
        const current = prev[postingId];
        if (!current) return prev;
        return {
          ...prev,
          [postingId]: {
            ...current,
            applications: current.applications.map((a) =>
              a.id === updated.id ? { ...a, stage: updated.stage } : a,
            ),
          },
        };
      });
    } catch {
      setCandidates((prev) => ({
        ...prev,
        [postingId]: { ...prev[postingId]!, applicationsError: labels.stageChangeFailed },
      }));
    } finally {
      setCandidates((prev) => ({
        ...prev,
        [postingId]: { ...prev[postingId]!, advancingId: null },
      }));
    }
  }

  return (
    <section className="recruit-jd" aria-labelledby="recruit-jd-title">
      <h2 id="recruit-jd-title">{labels.title}</h2>
      <p className="ja-muted">{labels.subtitle}</p>

      <form className="ja-form" onSubmit={onSubmit}>
        <h3>{labels.formTitle}</h3>
        <div className="recruit-filters">
          <div className="recruit-field">
            <label htmlFor="jd-title">{labels.fieldTitle}</label>
            <input
              id="jd-title"
              className="ja-input"
              value={title}
              placeholder={labels.fieldTitlePlaceholder}
              onChange={(e) => setTitle(e.target.value)}
              data-testid="jd-title"
            />
          </div>
          <div className="recruit-field">
            <label htmlFor="jd-company">{labels.fieldCompany}</label>
            <input
              id="jd-company"
              className="ja-input"
              value={company}
              placeholder={labels.fieldCompanyPlaceholder}
              onChange={(e) => setCompany(e.target.value)}
              data-testid="jd-company"
            />
          </div>
          <div className="recruit-field">
            <label htmlFor="jd-location">{labels.fieldLocation}</label>
            <input
              id="jd-location"
              className="ja-input"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              data-testid="jd-location"
            />
          </div>
          <div className="recruit-field">
            <label htmlFor="jd-tags">{labels.fieldTags}</label>
            <input
              id="jd-tags"
              className="ja-input"
              value={tags}
              placeholder={labels.fieldTagsPlaceholder}
              onChange={(e) => setTags(e.target.value)}
              data-testid="jd-tags"
            />
          </div>
          <div className="recruit-field recruit-field--wide">
            <label htmlFor="jd-description">{labels.fieldDescription}</label>
            <textarea
              id="jd-description"
              className="ja-input"
              rows={4}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              data-testid="jd-description"
            />
          </div>
          <div className="recruit-field">
            <label htmlFor="jd-remote" className="recruit-jd-remote">
              <input
                id="jd-remote"
                type="checkbox"
                checked={remote}
                onChange={(e) => setRemote(e.target.checked)}
                data-testid="jd-remote"
              />
              <span>{labels.fieldRemote}</span>
            </label>
          </div>
        </div>
        <div className="ja-btn-row">
          <button type="submit" className="ja-btn ja-btn--primary" disabled={submitting} data-testid="jd-submit">
            {submitting ? labels.submitting : labels.submit}
          </button>
          {tagList.length > 0 && (
            <span className="ja-muted recruit-jd-tagcount">{tagList.length}</span>
          )}
        </div>
        {formError && (
          <p className="ja-error" role="alert" data-testid="jd-form-error">
            {formError}
          </p>
        )}
        {published && (
          <p className="ja-success" role="status" data-testid="jd-published">
            {labels.published}
          </p>
        )}
      </form>

      {listError && (
        <p className="ja-error" role="alert">
          {listError}{' '}
          <button type="button" className="ja-btn ja-btn--sm" onClick={() => void loadList()}>
            {labels.reload}
          </button>
        </p>
      )}
      {loaded && !listError && postings.length === 0 && <p className="ja-muted">{labels.empty}</p>}

      <ul className="recruit-jd-list">
        {postings.map((posting) => {
          const block = candidates[posting.id];
          const isOpen = expanded === posting.id;
          return (
            <li key={posting.id} className="recruit-jd-item" data-testid="jd-item">
              <div className="recruit-card-head">
                <div>
                  <p className="recruit-name">{posting.title}</p>
                  <p className="recruit-id">
                    {posting.company}
                    {posting.location ? ` · ${posting.location}` : ''}
                  </p>
                </div>
                <span
                  className={
                    posting.status === 'active' ? 'ja-badge ja-badge--likely' : 'ja-badge'
                  }
                >
                  {posting.status === 'active' ? labels.statusActive : labels.statusInactive}
                </span>
              </div>
              {posting.tags.length > 0 && (
                <p className="recruit-tags">
                  {posting.tags.map((tag) => (
                    <span key={tag} className="ja-badge">
                      {tag}
                    </span>
                  ))}
                </p>
              )}
              <div className="ja-btn-row">
                <button
                  type="button"
                  className="ja-btn ja-btn--sm"
                  onClick={() => void rankCandidates(posting)}
                  disabled={posting.tags.length === 0}
                  title={posting.tags.length === 0 ? labels.needTags : undefined}
                  data-testid="jd-rank"
                >
                  {labels.findCandidates}
                </button>
                {posting.status === 'active' && (
                  <button
                    type="button"
                    className="ja-btn ja-btn--sm ja-btn--danger"
                    onClick={() => void retire(posting)}
                    disabled={retiringId === posting.id}
                    data-testid="jd-retire"
                  >
                    {retiringId === posting.id ? labels.retiring : labels.retire}
                  </button>
                )}
              </div>
              {isOpen && block && (
                <div className="recruit-jd-cands">
                  {block.loading && <p className="ja-muted">{labels.candidatesLoading}</p>}
                  {!block.loading && block.error && (
                    <p className="ja-error" role="alert" data-testid="jd-cands-error">
                      {block.error}
                    </p>
                  )}
                  {!block.loading &&
                    !block.error &&
                    block.items.length === 0 && (
                      <p className="ja-muted">{labels.candidatesEmpty}</p>
                    )}
                  {!block.loading && !block.error && block.items.length > 0 && (
                    <>
                      <p className="recruit-results-meta">
                        {labels.candidatesCount.replace('{count}', String(block.total))}
                      </p>
                      <ul>
                        {block.items.map((candidate) => (
                          <li key={candidate.profileId} className="recruit-jd-cand">
                            <a
                              href={`${reportBasePath}/${candidate.profileId}?view=recruiter`}
                              data-testid="jd-cand-link"
                            >
                              {candidate.displayName || candidate.login}
                            </a>
                            <span className="ja-muted recruit-jd-headline">{candidate.headline}</span>
                            {candidate.matchedSkills.length > 0 && (
                              <span className="recruit-tags">
                                {candidate.matchedSkills.map((skill) => (
                                  <span key={skill} className="recruit-tag--matched">
                                    {skill}
                                  </span>
                                ))}
                              </span>
                            )}
                            {candidate.verifiedClaimCount > 0 && (
                              <span className="ja-badge">
                                {labels.verifiedClaims.replace('{count}', String(candidate.verifiedClaimCount))}
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}

                  <h4 className="recruit-jd-sub">{labels.interviewsTitle}</h4>
                  {block.interviewsLoading && <p className="ja-muted">{labels.candidatesLoading}</p>}
                  {!block.interviewsLoading && block.interviewsError && (
                    <p className="ja-error" role="alert" data-testid="jd-interviews-error">
                      {block.interviewsError}
                    </p>
                  )}
                  {!block.interviewsLoading &&
                    !block.interviewsError &&
                    block.interviews.length === 0 && (
                      <p className="ja-muted" data-testid="jd-interviews-empty">
                        {labels.interviewsEmpty}
                      </p>
                    )}
                  {block.interviews.length > 0 && (
                    <ul>
                      {block.interviews.map((interview) => (
                        <li key={interview.id} className="recruit-jd-cand" data-testid="jd-interview-item">
                          <a
                            href={`${reportBasePath}/${interview.profileId}?view=recruiter`}
                            data-testid="jd-interview-link"
                          >
                            {interview.roundLabel}
                          </a>
                          <span className="ja-muted">{formatWhen(interview.scheduledStart, locale)}</span>
                          <span className="ja-badge">
                            {labels.statusLabels[interview.status] ?? interview.status}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}

                  <h4 className="recruit-jd-sub">{labels.applicationsTitle}</h4>
                  {block.applicationsLoading && <p className="ja-muted">{labels.candidatesLoading}</p>}
                  {!block.applicationsLoading && block.applicationsError && (
                    <p className="ja-error" role="alert" data-testid="jd-apps-error">
                      {block.applicationsError}
                    </p>
                  )}
                  {!block.applicationsLoading &&
                    !block.applicationsError &&
                    block.applications.length === 0 && (
                      <p className="ja-muted" data-testid="jd-apps-empty">
                        {labels.applicationsEmpty}
                      </p>
                    )}
                  {block.applications.length > 0 && (
                    <ul>
                      {block.applications.map((application) => (
                        <li key={application.id} className="recruit-jd-cand" data-testid="jd-application-item">
                          <a
                            href={`${reportBasePath}/${application.profileId}?view=recruiter`}
                            data-testid="jd-application-link"
                          >
                            {application.targetTitle}
                          </a>
                          <span className="ja-muted">
                            {application.targetCompany} · {formatWhen(application.appliedAt, locale)}
                          </span>
                          <span className="ja-badge ja-badge--likely">
                            {application.stage
                              ? (labels.stageLabels[application.stage] ?? application.stage)
                              : labels.stageLabels.new}
                          </span>
                          {STAGE_NEXT[application.stage ?? 'null']?.map((next) => (
                              <button
                                key={next}
                                type="button"
                                className="ja-btn ja-btn--sm"
                                disabled={block.advancingId !== null}
                                onClick={() => void advance(posting.id, application.id, next)}
                                data-testid="jd-stage-advance"
                              >
                                {labels.advanceStage.replace('{stage}', labels.stageLabels[next] ?? next)}
                              </button>
                            ))}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
