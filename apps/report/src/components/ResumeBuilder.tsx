/**
 * ResumeBuilder——报告页「岗位定向简历」React island（P-R2）。
 *
 * 数据流：岗位卡片（JobRecommendations）点击「针对此岗生成简历」→ dispatch
 * `jobagent:build-resume` CustomEvent（携带内部 jobId）→ 本组件监听并调
 * `POST /resumes/build`（format=html）→ iframe 预览服务端渲染的可打印 HTML。
 *
 * 隐私（设计 §5.4 三铁律之 provenance / no-fabrication）：
 *  - 本地补填（联系方式/教育/工作经历）只存 localStorage（canonical 键
 *    `jobagent.localProfile`，与扩展共用同一 LocalProfileFields 形状，各自本域存储），
 *    仅在请求体中投影为简历字段随本次生成发送，服务端不入库、不记日志；
 *  - 简历正文只含画像证据可支撑的技能与成果，缺失项进 suggestions/gaps 提示，绝不臆造。
 *  - 打印/导出 PDF 走浏览器打印（HTML 已内置 @media print），不引入服务端 puppeteer。
 * 所有用户可见文案由 Astro 经 labels 传入，组件不硬编码（i18n 在服务端完成）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { LocalProfileFields, LocalResumeFields, ResumeDraft } from '@jobagent/shared';
import {
  LEGACY_RESUME_FIELDS_STORAGE_KEY,
  LOCAL_PROFILE_STORAGE_KEY,
  legacyResumeToLocalProfile,
  localProfileToResumeFields,
  mergeLocalProfile,
  sanitizeLocalProfile,
} from '@jobagent/shared';
import { fetchExtensionLocalProfile, pushExtensionLocalProfile } from '../lib/extension-bridge';

export const BUILD_RESUME_EVENT = 'jobagent:build-resume';

export interface BuildResumeDetail {
  jobId: string;
  title: string;
  company: string;
}

/** POST /resumes/build 回传的润色状态（仅请求 polish:true 时出现）。 */
export interface ResumePolishResult {
  requested: boolean;
  applied: boolean;
  reason?: 'not_configured' | 'provider_error' | 'validation_failed' | 'fabrication_detected' | string;
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
  fieldLinkedIn: string;
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
  startPlaceholder: string;
  endPlaceholder: string;
  companyPlaceholder: string;
  rolePlaceholder: string;
  detailPlaceholder: string;
  polishToggle: string;
  polishHint: string;
  polishApplied: string;
  polishFallback: string;
  polishReasonNotConfigured: string;
  polishReasonProviderError: string;
  polishReasonValidationFailed: string;
  polishReasonFabricationDetected: string;
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

/** 读 canonical 本地档案；无则一次性迁移旧简历补填键（迁移后删旧键）。 */
function loadLocal(): LocalProfileFields {
  try {
    const raw = localStorage.getItem(LOCAL_PROFILE_STORAGE_KEY);
    if (raw) return sanitizeLocalProfile(JSON.parse(raw) as LocalProfileFields);
    const legacyRaw = localStorage.getItem(LEGACY_RESUME_FIELDS_STORAGE_KEY);
    if (legacyRaw) {
      const migrated = legacyResumeToLocalProfile(JSON.parse(legacyRaw) as LocalResumeFields);
      persistLocal(migrated);
      try {
        localStorage.removeItem(LEGACY_RESUME_FIELDS_STORAGE_KEY);
      } catch {
        // 旧键清理失败不影响本次使用
      }
      return migrated;
    }
  } catch {
    // 损坏的本地数据按空处理，绝不阻塞生成
  }
  return {};
}

/** 规整后写入 canonical 键（本域 localStorage + 推送扩展 chrome.storage 权威镜像）。 */
function persistLocal(fields: LocalProfileFields): void {
  const clean = sanitizeLocalProfile(fields);
  try {
    localStorage.setItem(LOCAL_PROFILE_STORAGE_KEY, JSON.stringify(clean));
  } catch {
    // 隐私模式 / 配额受限时仅本次会话生效
  }
  // best-effort 推送扩展（跨域权威，供扩展面板读取）；扩展未装时静默降级为本域 localStorage
  void pushExtensionLocalProfile(clean);
}

/** canonical → 简历请求字段；全空时返回 undefined（请求不带 local）。 */
function toResumeRequest(fields: LocalProfileFields): LocalResumeFields | undefined {
  const projected = localProfileToResumeFields(fields);
  return Object.values(projected).some((v) => v !== undefined) ? projected : undefined;
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
  const [local, setLocal] = useState<LocalProfileFields>(loadLocal);
  const [frameHeight, setFrameHeight] = useState(480);
  const [downloading, setDownloading] = useState(false);
  const [polishOn, setPolishOn] = useState(false);
  const [polishResult, setPolishResult] = useState<ResumePolishResult | null>(null);

  const sectionRef = useRef<HTMLElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const seqRef = useRef(0);

  // 挂载后异步拉取扩展 chrome.storage 的权威档案（扩展面板可能已填写），合并到本域缓存。
  // chrome.storage 优先、本域 localStorage 补缺；扩展未装/非 Chrome 时静默跳过。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const ext = await fetchExtensionLocalProfile();
      if (!cancelled && ext) setLocal((prev) => mergeLocalProfile(ext, prev));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const build = useCallback(
    async (job: BuildResumeDetail, fields: LocalProfileFields, polish?: boolean) => {
      const seq = ++seqRef.current;
      const wantPolish = polish ?? polishOn;
      setTarget(job);
      setStatus('loading');
      setMarkdown('');
      setPolishResult(null);
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
            local: toResumeRequest(fields),
            ...(wantPolish ? { polish: true } : {}),
          }),
          credentials: 'include',
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { draft: ResumeDraft; html: string; polish?: ResumePolishResult };
        if (seq !== seqRef.current) return; // 已有更新的请求，丢弃过期响应
        setDraft(body.draft);
        setHtml(body.html);
        setPolishResult(body.polish ?? null);
        setStatus('ready');
      } catch {
        if (seq !== seqRef.current) return;
        setStatus('error');
      }
    },
    [apiBase, profileId, locale, polishOn],
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

  const togglePolish = (on: boolean): void => {
    setPolishOn(on);
    // 已有目标岗位时，切换开关立即按新偏好重新生成
    if (target) void build(target, loadLocal(), on);
  };

  const polishReasonLabel = (reason?: string): string => {
    switch (reason) {
      case 'not_configured':
        return labels.polishReasonNotConfigured;
      case 'provider_error':
        return labels.polishReasonProviderError;
      case 'validation_failed':
        return labels.polishReasonValidationFailed;
      case 'fabrication_detected':
        return labels.polishReasonFabricationDetected;
      default:
        return labels.polishFallback;
    }
  };

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
          body: JSON.stringify({
            profileId,
            jobId: target.jobId,
            locale,
            format: 'md',
            // 必须与上方 build() 的 html 请求带同一份 local，否则下载件会丢掉
            // 姓名/邮箱/教育/工作经历——那些只有用户手填，画像里没有。
            local: toResumeRequest(loadLocal()),
            ...(polishOn ? { polish: true } : {}),
          }),
          credentials: 'include',
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
    persistLocal(local);
    if (target) void build(target, local);
  };

  const reset = (): void => {
    seqRef.current += 1;
    setStatus('idle');
    setTarget(null);
    setDraft(null);
    setHtml('');
    setMarkdown('');
    setPolishResult(null);
  };

  // ── 本地补填表单的行编辑 helper（编辑模型为 canonical LocalProfileFields）──
  const eduRows = local.education ?? [];
  const workRows = local.workHistory ?? [];
  type ScalarKey = 'fullName' | 'email' | 'phone' | 'location' | 'personalSite' | 'linkedinUrl';
  const setSimple = (key: ScalarKey, value: string): void =>
    setLocal((f) => ({ ...f, [key]: value }));
  const updateEdu = (
    i: number,
    patch: Partial<NonNullable<LocalProfileFields['education']>[number]>,
  ): void => setLocal((f) => ({ ...f, education: eduRows.map((e, j) => (j === i ? { ...e, ...patch } : e)) }));
  const addEdu = (): void =>
    setLocal((f) => ({ ...f, education: [...(f.education ?? []), { school: '' }] }));
  const removeEdu = (i: number): void =>
    setLocal((f) => ({ ...f, education: eduRows.filter((_, j) => j !== i) }));
  const updateWork = (
    i: number,
    patch: Partial<NonNullable<LocalProfileFields['workHistory']>[number]>,
  ): void => setLocal((f) => ({ ...f, workHistory: workRows.map((w, j) => (j === i ? { ...w, ...patch } : w)) }));
  const addWork = (): void =>
    setLocal((f) => ({ ...f, workHistory: [...(f.workHistory ?? []), { company: '' }] }));
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

          <div className="resume-polish">
            <label className="resume-polish-toggle">
              <input
                type="checkbox"
                checked={polishOn}
                onChange={(e) => togglePolish(e.target.checked)}
              />
              <span>{labels.polishToggle}</span>
            </label>
            <p className="ja-muted resume-polish-hint">{labels.polishHint}</p>
            {polishResult?.requested && (
              <p
                role="status"
                className={
                  polishResult.applied
                    ? 'resume-polish-status resume-polish-status--ok'
                    : 'resume-polish-status resume-polish-status--fallback'
                }
              >
                {polishResult.applied
                  ? labels.polishApplied
                  : `${labels.polishFallback} — ${polishReasonLabel(polishResult.reason)}`}
              </p>
            )}
          </div>

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
                <label>
                  <span>{labels.fieldLinkedIn}</span>
                  <input
                    type="url"
                    placeholder="https://www.linkedin.com/in/"
                    value={local.linkedinUrl ?? ''}
                    onChange={(e) => setSimple('linkedinUrl', e.target.value)}
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
                      aria-label={labels.startPlaceholder}
                      placeholder={labels.startPlaceholder}
                      value={e.start ?? ''}
                      onChange={(ev) => updateEdu(i, { start: ev.target.value })}
                    />
                    <input
                      aria-label={labels.endPlaceholder}
                      placeholder={labels.endPlaceholder}
                      value={e.end ?? ''}
                      onChange={(ev) => updateEdu(i, { end: ev.target.value })}
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
                      aria-label={labels.startPlaceholder}
                      placeholder={labels.startPlaceholder}
                      value={w.start ?? ''}
                      onChange={(ev) => updateWork(i, { start: ev.target.value })}
                    />
                    <input
                      aria-label={labels.endPlaceholder}
                      placeholder={labels.endPlaceholder}
                      value={w.end ?? ''}
                      onChange={(ev) => updateWork(i, { end: ev.target.value })}
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
