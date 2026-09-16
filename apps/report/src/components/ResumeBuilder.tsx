/**
 * ResumeBuilder——报告页「岗位定向简历」React island（P-R2）。
 *
 * 数据流：岗位卡片（JobRecommendations）点击「针对此岗生成简历」→ dispatch
 * `jobagent:build-resume` CustomEvent（携带内部 jobId）→ 本组件监听并调
 * `POST /resumes/build`（format=html）→ iframe 预览服务端渲染的可打印 HTML。
 *
 * 隐私（设计 §5.4 三铁律之 provenance / no-fabrication）：
 *  - 本地补填（联系方式/教育/工作经历）只存 localStorage（`jobagent.localResumeFields`），
 *    仅在请求体中随本次生成发送，服务端不入库、不记日志；
 *  - 简历正文只含画像证据可支撑的技能与成果，缺失项进 suggestions/gaps 提示，绝不臆造。
 *  - 打印/导出 PDF 走浏览器打印（HTML 已内置 @media print），不引入服务端 puppeteer。
 * 所有用户可见文案由 Astro 经 labels 传入，组件不硬编码（i18n 在服务端完成）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { LocalResumeFields, ResumeDraft } from '@jobagent/shared';

export const BUILD_RESUME_EVENT = 'jobagent:build-resume';
/** 报告页本地补填字段存储键；与扩展 ATS 的 jobagent.localFields 形状不同，故独立成键。 */
const LOCAL_RESUME_FIELDS_KEY = 'jobagent.localResumeFields';

export interface BuildResumeDetail {
  jobId: string;
  title: string;
  company: string;
}

export interface ResumeLabels {
  sectionTitle: string;
  sectionHint: string;
  idle: string;
  loading: string;
  error: string;
  retry: string;
  targetLabel: string;
  scoreLabel: string;
  tierHigh: string;
  tierMid: string;
  tierLow: string;
  previewLabel: string;
  print: string;
  downloadMd: string;
  close: string;
  localToggle: string;
  localPrivacy: string;
  fieldName: string;
  fieldEmail: string;
  fieldPhone: string;
  fieldLocation: string;
  fieldSite: string;
  educationLabel: string;
  workLabel: string;
  addEducation: string;
  addWork: string;
  remove: string;
  applyLocal: string;
  suggestionsTitle: string;
  gapsTitle: string;
  schoolPlaceholder: string;
  degreePlaceholder: string;
  periodPlaceholder: string;
  companyPlaceholder: string;
  rolePlaceholder: string;
  detailPlaceholder: string;
}

interface ResumeBuilderProps {
  profileId: string;
  apiBase: string;
  locale: string;
  labels: ResumeLabels;
  /** 深链自动触发：URL ?resumeJob=<jobId>（扩展面板"生成简历"入口），mount 后自动生成。 */
  initialJobId?: string;
}

type Status = 'idle' | 'loading' | 'ready' | 'error';

function loadLocal(): LocalResumeFields {
  try {
    const raw = localStorage.getItem(LOCAL_RESUME_FIELDS_KEY);
    return raw ? (JSON.parse(raw) as LocalResumeFields) : {};
  } catch {
    return {};
  }
}

/** 剔除空白字符串与不完整行（school/degree、company/role 均为契约必填），避免 400。 */
function sanitizeLocal(f: LocalResumeFields): LocalResumeFields | undefined {
  const str = (v?: string): string | undefined => {
    const t = v?.trim();
    return t ? t : undefined;
  };
  const education = (f.education ?? [])
    .map((e) => ({ school: str(e.school) ?? '', degree: str(e.degree) ?? '', period: str(e.period) }))
    .filter((e) => e.school && e.degree);
  const workHistory = (f.workHistory ?? [])
    .map((w) => ({
      company: str(w.company) ?? '',
      role: str(w.role) ?? '',
      period: str(w.period),
      detail: str(w.detail),
    }))
    .filter((w) => w.company && w.role);
  const out: LocalResumeFields = {
    fullName: str(f.fullName),
    email: str(f.email),
    phone: str(f.phone),
    location: str(f.location),
    personalSite: str(f.personalSite),
  };
  if (education.length > 0) out.education = education;
  if (workHistory.length > 0) out.workHistory = workHistory;
  return Object.values(out).some((v) => v !== undefined) ? out : undefined;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'resume';
}

export default function ResumeBuilder({ profileId, apiBase, locale, labels, initialJobId }: ResumeBuilderProps) {
  const [target, setTarget] = useState<BuildResumeDetail | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [draft, setDraft] = useState<ResumeDraft | null>(null);
  const [html, setHtml] = useState('');
  const [markdown, setMarkdown] = useState('');
  const [showLocal, setShowLocal] = useState(false);
  const [local, setLocal] = useState<LocalResumeFields>(loadLocal);
  const [frameHeight, setFrameHeight] = useState(480);
  const [downloading, setDownloading] = useState(false);

  const sectionRef = useRef<HTMLElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const seqRef = useRef(0);

  const build = useCallback(
    async (job: BuildResumeDetail, fields: LocalResumeFields) => {
      const seq = ++seqRef.current;
      setTarget(job);
      setStatus('loading');
      setMarkdown('');
      sectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      try {
        const res = await fetch(`${apiBase}/resumes/build`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            profileId,
            jobId: job.jobId,
            locale,
            format: 'html',
            local: sanitizeLocal(fields),
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { draft: ResumeDraft; html: string };
        if (seq !== seqRef.current) return; // 已有更新的请求，丢弃过期响应
        setDraft(body.draft);
        setHtml(body.html);
        setStatus('ready');
      } catch {
        if (seq !== seqRef.current) return;
        setStatus('error');
      }
    },
    [apiBase, profileId, locale],
  );

  // 监听岗位卡片的生成请求；local 始终从 localStorage 读最新已保存值
  useEffect(() => {
    const handler = (e: Event): void => {
      const detail = (e as CustomEvent<BuildResumeDetail>).detail;
      if (detail?.jobId) void build(detail, loadLocal());
    };
    window.addEventListener(BUILD_RESUME_EVENT, handler);
    return () => window.removeEventListener(BUILD_RESUME_EVENT, handler);
  }, [build]);

  // 深链自动触发：?resumeJob=<jobId>（扩展面板入口），title/company 由响应 draft 回填
  useEffect(() => {
    if (initialJobId) void build({ jobId: initialJobId, title: '', company: '' }, loadLocal());
    // 仅按初始 jobId 触发一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialJobId]);

  const tierLabel = (tier: ResumeDraft['targetJob']['tier']): string =>
    tier === 'high' ? labels.tierHigh : tier === 'mid' ? labels.tierMid : labels.tierLow;

  const resizeFrame = (): void => {
    const doc = iframeRef.current?.contentDocument;
    if (doc?.body) setFrameHeight(Math.max(400, doc.body.scrollHeight + 24));
  };

  const print = (): void => {
    const win = iframeRef.current?.contentWindow;
    if (win) {
      win.focus();
      win.print();
    }
  };

  const downloadMarkdown = async (): Promise<void> => {
    if (!target || !draft) return;
    setDownloading(true);
    try {
      let md = markdown;
      if (!md) {
        const res = await fetch(`${apiBase}/resumes/build`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ profileId, jobId: target.jobId, locale, format: 'md' }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { markdown: string };
        md = body.markdown;
        setMarkdown(md);
      }
      const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${slug(draft.targetJob.company)}-${slug(draft.targetJob.title)}.md`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setDownloading(false);
    }
  };

  const applyLocal = (): void => {
    localStorage.setItem(LOCAL_RESUME_FIELDS_KEY, JSON.stringify(local));
    if (target) void build(target, local);
  };

  const reset = (): void => {
    seqRef.current += 1;
    setStatus('idle');
    setTarget(null);
    setDraft(null);
    setHtml('');
    setMarkdown('');
  };

  // ── 本地补填表单的行编辑 helper ──
  const eduRows = local.education ?? [];
  const workRows = local.workHistory ?? [];
  const setSimple = (key: keyof LocalResumeFields, value: string): void =>
    setLocal((f) => ({ ...f, [key]: value }));
  const updateEdu = (i: number, patch: Partial<NonNullable<LocalResumeFields['education']>[number]>): void =>
    setLocal((f) => ({ ...f, education: eduRows.map((e, j) => (j === i ? { ...e, ...patch } : e)) }));
  const addEdu = (): void =>
    setLocal((f) => ({ ...f, education: [...(f.education ?? []), { school: '', degree: '', period: '' }] }));
  const removeEdu = (i: number): void =>
    setLocal((f) => ({ ...f, education: eduRows.filter((_, j) => j !== i) }));
  const updateWork = (i: number, patch: Partial<NonNullable<LocalResumeFields['workHistory']>[number]>): void =>
    setLocal((f) => ({ ...f, workHistory: workRows.map((w, j) => (j === i ? { ...w, ...patch } : w)) }));
  const addWork = (): void =>
    setLocal((f) => ({
      ...f,
      workHistory: [...(f.workHistory ?? []), { company: '', role: '', period: '', detail: '' }],
    }));
  const removeWork = (i: number): void =>
    setLocal((f) => ({ ...f, workHistory: workRows.filter((_, j) => j !== i) }));

  return (
    <section ref={sectionRef} className="ja-card resume-builder" aria-live="polite">
      <h2>{labels.sectionTitle}</h2>
      <p className="ja-muted resume-hint">{labels.sectionHint}</p>

      {status === 'idle' && <p className="ja-muted resume-idle">{labels.idle}</p>}

      {status === 'loading' && (
        <p className="ja-muted resume-status" role="status">
          <span className="spinner" aria-hidden="true" />
          {labels.loading}
        </p>
      )}

      {status === 'error' && (
        <div className="resume-error" role="alert">
          <p>{labels.error}</p>
          {target && (
            <button type="button" className="ja-btn ja-btn--ghost" onClick={() => void build(target, loadLocal())}>
              {labels.retry}
            </button>
          )}
        </div>
      )}

      {status === 'ready' && draft && target && (
        <div className="resume-panel">
          <div className="resume-panel-head">
            <div className="resume-target">
              <span className="ja-muted resume-target-label">{labels.targetLabel}</span>
              <strong>{draft.targetJob.title}</strong>
              <span className="ja-muted"> · {draft.targetJob.company}</span>
            </div>
            <span className={`rec-score rec-score--${draft.targetJob.tier}`} title={labels.scoreLabel}>
              {tierLabel(draft.targetJob.tier)} · {draft.targetJob.matchScore}
            </span>
          </div>

          {(draft.suggestions.length > 0 || draft.gaps.length > 0) && (
            <div className="resume-notes">
              {draft.suggestions.length > 0 && (
                <div className="resume-suggestions">
                  <span className="resume-notes-title">{labels.suggestionsTitle}</span>
                  <ul>
                    {draft.suggestions.map((s, i) => (
                      <li key={`s-${i}`}>{s.text}</li>
                    ))}
                  </ul>
                </div>
              )}
              {draft.gaps.length > 0 && (
                <div className="resume-gaps">
                  <span className="resume-notes-title">{labels.gapsTitle}</span>
                  <ul>
                    {draft.gaps.map((g, i) => (
                      <li key={`g-${i}`}>{g}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          <div className="resume-actions">
            <button type="button" className="ja-btn" onClick={print}>
              {labels.print}
            </button>
            <button
              type="button"
              className="ja-btn ja-btn--ghost"
              disabled={downloading}
              onClick={() => void downloadMarkdown()}
            >
              {labels.downloadMd}
            </button>
            <button type="button" className="ja-btn ja-btn--ghost" onClick={() => setShowLocal((v) => !v)}>
              {labels.localToggle}
            </button>
            <button type="button" className="ja-btn ja-btn--ghost resume-close" onClick={reset}>
              {labels.close}
            </button>
          </div>

          {showLocal && (
            <div className="resume-local">
              <p className="ja-muted resume-local-privacy">{labels.localPrivacy}</p>
              <div className="resume-local-grid">
                <label>
                  <span>{labels.fieldName}</span>
                  <input value={local.fullName ?? ''} onChange={(e) => setSimple('fullName', e.target.value)} />
                </label>
                <label>
                  <span>{labels.fieldEmail}</span>
                  <input
                    type="email"
                    value={local.email ?? ''}
                    onChange={(e) => setSimple('email', e.target.value)}
                  />
                </label>
                <label>
                  <span>{labels.fieldPhone}</span>
                  <input value={local.phone ?? ''} onChange={(e) => setSimple('phone', e.target.value)} />
                </label>
                <label>
                  <span>{labels.fieldLocation}</span>
                  <input value={local.location ?? ''} onChange={(e) => setSimple('location', e.target.value)} />
                </label>
                <label>
                  <span>{labels.fieldSite}</span>
                  <input
                    type="url"
                    placeholder="https://"
                    value={local.personalSite ?? ''}
                    onChange={(e) => setSimple('personalSite', e.target.value)}
                  />
                </label>
              </div>

              <fieldset className="resume-local-group">
                <legend>{labels.educationLabel}</legend>
                {eduRows.map((e, i) => (
                  <div key={`edu-${i}`} className="resume-local-row">
                    <input
                      aria-label={labels.schoolPlaceholder}
                      placeholder={labels.schoolPlaceholder}
                      value={e.school}
                      onChange={(ev) => updateEdu(i, { school: ev.target.value })}
                    />
                    <input
                      aria-label={labels.degreePlaceholder}
                      placeholder={labels.degreePlaceholder}
                      value={e.degree ?? ''}
                      onChange={(ev) => updateEdu(i, { degree: ev.target.value })}
                    />
                    <input
                      aria-label={labels.periodPlaceholder}
                      placeholder={labels.periodPlaceholder}
                      value={e.period ?? ''}
                      onChange={(ev) => updateEdu(i, { period: ev.target.value })}
                    />
                    <button type="button" className="ja-btn ja-btn--ghost resume-row-remove" onClick={() => removeEdu(i)}>
                      {labels.remove}
                    </button>
                  </div>
                ))}
                <button type="button" className="ja-btn ja-btn--ghost" onClick={addEdu}>
                  {labels.addEducation}
                </button>
              </fieldset>

              <fieldset className="resume-local-group">
                <legend>{labels.workLabel}</legend>
                {workRows.map((w, i) => (
                  <div key={`work-${i}`} className="resume-local-row">
                    <input
                      aria-label={labels.companyPlaceholder}
                      placeholder={labels.companyPlaceholder}
                      value={w.company}
                      onChange={(ev) => updateWork(i, { company: ev.target.value })}
                    />
                    <input
                      aria-label={labels.rolePlaceholder}
                      placeholder={labels.rolePlaceholder}
                      value={w.role ?? ''}
                      onChange={(ev) => updateWork(i, { role: ev.target.value })}
                    />
                    <input
                      aria-label={labels.periodPlaceholder}
                      placeholder={labels.periodPlaceholder}
                      value={w.period ?? ''}
                      onChange={(ev) => updateWork(i, { period: ev.target.value })}
                    />
                    <button type="button" className="ja-btn ja-btn--ghost resume-row-remove" onClick={() => removeWork(i)}>
                      {labels.remove}
                    </button>
                    <input
                      className="resume-local-detail"
                      aria-label={labels.detailPlaceholder}
                      placeholder={labels.detailPlaceholder}
                      value={w.detail ?? ''}
                      onChange={(ev) => updateWork(i, { detail: ev.target.value })}
                    />
                  </div>
                ))}
                <button type="button" className="ja-btn ja-btn--ghost" onClick={addWork}>
                  {labels.addWork}
                </button>
              </fieldset>

              <button type="button" className="ja-btn" onClick={applyLocal}>
                {labels.applyLocal}
              </button>
            </div>
          )}

          <div className="resume-preview">
            <span className="ja-muted resume-preview-label">{labels.previewLabel}</span>
            <iframe
              ref={iframeRef}
              title={`${draft.targetJob.title} — ${draft.targetJob.company}`}
              srcDoc={html}
              className="resume-iframe"
              style={{ height: `${frameHeight}px` }}
              onLoad={resizeFrame}
            />
          </div>
        </div>
      )}
    </section>
  );
}
