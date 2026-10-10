/**
 * AgentWorkbench——/[locale]/workbench「求职工作台」React island（设计 §3/§5/§6 阶段 1）。
 *
 * 阶段 1 的硬边界（设计 §4 原则 1）：**Agent 只准备、人执行**。本 island 只做四件事：
 *   1. 管理本人的多套「求职偏好」（JobPreferences，CRUD）；
 *   2. 管理「求职任务」（JobRun）+ 展示状态迁移事件流（JobRunEvent，可回放审计）；
 *   3. 展示「待投清单」（SubmitIntent）与**只由 code 现拼**的可解释匹配报告（MatchReport）；
 *   4. 提供人机闸两个动作（approve / reject）与「标记已投」回填。
 * 本阶段不产生任何对外部系统的副作用：没有 ATS 自动填充、没有自动提交。
 *
 * 三条纪律（对齐 AGENTS「渲染侧只认 code」与「i18n 在服务端完成」）：
 *  - **匹配报告只渲染 code**：reasons/gaps/suggestedBoost 一律取 `labels.match.reason[code]`
 *    等本地化模板再用事实（技能名、分值、标签）拼串，绝不按英文句子匹配、绝不在组件里
 *    写英文 snake_case 码（契约里内核只出 code + 事实）；
 *  - **零硬编码文案**：所有用户可见字符串由 Astro 服务端经 `labels` 传入；
 *  - **零硬编码颜色/尺寸**：样式只用全局工具类与 `var(--ja-*)` token。
 *
 * 数据流：全部经 `credentials: 'include'` 调同源 API（跨端口 cookie，见
 * lib/credentials-guard.test.ts）；任何 mutation 后重拉 run 视图 + 待投清单，
 * 并用 `seqRef` 丢弃过期响应（同 ResumeBuilder.tsx 的手法）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  LEGACY_RESUME_FIELDS_STORAGE_KEY,
  LOCAL_PROFILE_STORAGE_KEY,
  OUTCOME_FEEDBACK_VALUES,
  legacyResumeToLocalProfile,
  localProfileToResumeFields,
  matchScoreTier,
  sanitizeLocalProfile,
} from '@jobagent/shared';
import type {
  JobPreferences,
  JobRun,
  JobRunEvent,
  JobRunEventKind,
  JobRunStatus,
  LocalProfileFields,
  LocalResumeFields,
  MatchReport,
  MatchScoreTier,
  SubmitIntent,
  OutcomeFeedback,
  SubmitIntentStatus,
} from '@jobagent/shared';
import EmptyState from './EmptyState';

/**
 * 读本机「统一本地档案」（canonical，含旧键一次性迁移）并投影成简历请求字段。
 *
 * 与 ResumeBuilder 同一口径：画像不提供联系方式/教育/工作经历，只存浏览器本机（服务端不持久化），
 * 故工作台下载简历时必须把本机字段随请求带上，否则投出去的简历会缺电话/教育。
 * 读不到或数据损坏一律返回 undefined（不阻断下载，退回服务端渲染）。
 */
function loadResumeLocalFields(): LocalResumeFields | undefined {
  let fields: LocalProfileFields = {};
  try {
    const raw = localStorage.getItem(LOCAL_PROFILE_STORAGE_KEY);
    if (raw) {
      fields = sanitizeLocalProfile(JSON.parse(raw) as LocalProfileFields);
    } else {
      const legacyRaw = localStorage.getItem(LEGACY_RESUME_FIELDS_STORAGE_KEY);
      if (legacyRaw) {
        fields = legacyResumeToLocalProfile(JSON.parse(legacyRaw) as LocalResumeFields);
      }
    }
  } catch {
    return undefined;
  }
  const projected = localProfileToResumeFields(fields);
  return Object.values(projected).some((value) => value !== undefined) ? projected : undefined;
}

/**
 * island 的全部文案形状（服务端经 props 传入，组件不持有一句用户可见文案）。
 *
 * `statuses` / `tiers` / `intentStatuses` / `eventKinds` / `actors` 是 code → 文案的
 * 全量字典（含阶段 2 才用到的状态），`reason` / `gap` / `boost` 是匹配报告的 code 字典。
 */
export interface Labels {
  title: string;
  subtitle: string;
  loading: string;
  error: string;
  /** 登录但名下无画像：告诉用户先去分析/认领一份（仍可管理偏好） */
  noProfileHint: string;
  noProfileAction: string;
  preferences: {
    title: string;
    hint: string;
    loading: string;
    empty: string;
    add: string;
    create: string;
    cancel: string;
    delete: string;
    createdAt: string;
    labelLabel: string;
    labelPlaceholder: string;
    titlesLabel: string;
    titlesPlaceholder: string;
    skillsLabel: string;
    skillsPlaceholder: string;
    locationsLabel: string;
    locationsPlaceholder: string;
    remoteOnlyLabel: string;
    salaryLabel: string;
    salaryPlaceholder: string;
    minTierLabel: string;
    dailySubmitLimitLabel: string;
    required: string;
  };
  runs: {
    title: string;
    hint: string;
    loading: string;
    empty: string;
    create: string;
    scan: string;
    cancel: string;
    profileLabel: string;
    noProfileOption: string;
    preferenceLabel: string;
    noPreferenceOption: string;
    selectHint: string;
    attempts: string;
    lastScan: string;
    lastScanNever: string;
    scanResult: string;
    timeline: string;
    timelineEmpty: string;
    newCandidates: string;
    from: string;
    actorLabel: string;
  };
  pending: {
    title: string;
    hint: string;
    loading: string;
    empty: string;
    approve: string;
    reject: string;
    rejectReasonLabel: string;
    rejectReasonPlaceholder: string;
    resume: string;
    coverLetter: string;
    apply: string;
    markSubmitted: string;
    remote: string;
    salaryUnavailable: string;
    approved: string;
  };
  /** 已投清单（D1 结果回标面；outcomeFeedback 为空即待回标） */
  submissions: {
    title: string;
    hint: string;
    empty: string;
    outcomeLabel: string;
    outcomeUnset: string;
    saved: string;
    outcome: Record<OutcomeFeedback, string>;
  };
  match: {
    title: string;
    matchedSkills: string;
    reasons: string;
    gaps: string;
    boosts: string;
    none: string;
    points: string;
    reason: Record<'title_match' | 'tag_match' | 'description_match', string>;
    gap: Record<'tag_not_in_profile', string>;
    boost: Record<'add_evidence_for_tag', string>;
  };
  statuses: Record<JobRunStatus, string>;
  intentStatuses: Record<SubmitIntentStatus, string>;
  eventKinds: Record<string, string>;
  actors: Record<'user' | 'agent' | 'system', string>;
  tiers: Record<MatchScoreTier, string>;
  /** 任务列表/表单按钮（refresh 已用于「刷新」按钮） */
  actions: { refresh: string };
  errors: {
    preferences: string;
    runs: string;
    intents: string;
    /** 服务端结构化错误码 → 通用本地化文案（未知 code 回落模块级文案） */
    code: Record<string, string>;
  };
  fields: {
    company: string;
    location: string;
    salary: string;
    postedAt: string;
    run: string;
  };
}

interface InitialProfile {
  profileId: string;
  headline: string;
}

export interface AgentWorkbenchProps {
  apiBase: string;
  locale: 'zh-CN' | 'en';
  /** SSR 预取的本人画像（可序列化投影：id + 标题） */
  initialProfiles: InitialProfile[];
  /** 本人已认领画像（单数，可能为 null，如融合画像） */
  claimedProfileId: string | null;
  /** 无画像时的引导链接（`/${locale}/`） */
  profileHintHref: string;
  labels: Labels;
}

/**
 * JobRunEventKind → labels.eventKinds 的键（snake_case 契约码 → camelCase key）。
 * 未登记的码回落原始码：宁可显示一个内部标识，也绝不编造文案。
 */
const EVENT_KIND_KEYS: Record<JobRunEventKind, string> = {
  validate: 'validate',
  start: 'start',
  candidates_ready: 'candidatesReady',
  generated: 'generated',
  approve: 'approve',
  reject: 'reject',
  rescan: 'rescan',
  submitted: 'submitted',
  track: 'track',
  archive: 'archive',
  fail: 'fail',
  cancel: 'cancel',
};

/** 取事件码的本地化文案（未知码回落原始码，不猜文案）。 */
export function eventKindLabel(
  event: JobRunEventKind,
  dict: Record<string, string>,
): string {
  const key = (EVENT_KIND_KEYS as Record<string, string | undefined>)[event];
  return (key ? dict[key] : undefined) ?? event;
}

/** API 错误响应体（契约：`{ error: string, code?: string }`）。 */
interface ApiErrorBody {
  error?: string;
  code?: string;
}

/** 纯 helper：字符串 → 文件名 slug（与 ResumeBuilder 同一口径）。 */
export function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'job'
  );
}

/** 纯 helper：一条待投票据的 md 下载文件名 `<company>-<title>.md`。 */
export function intentFileName(intent: SubmitIntent, suffix = ''): string {
  return `${slugify(intent.job.company)}-${slugify(intent.job.title)}${suffix}.md`;
}

/** 纯 helper：事件时间戳 → 本地化分钟级时间（非法/渲染失败回退原文）。 */
export function formatEventTime(iso: string, locale: string): string {
  try {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleString(locale === 'zh-CN' ? 'zh-CN' : 'en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

/** 纯 helper：模板占位替换（`{skill}` / `{points}` / `{tag}` 等）。 */
export function fillTemplate(
  template: string,
  params: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in params ? String(params[key]) : match,
  );
}

/** 事务性错误信息载体：同时带上 code（取通用文案）与底层 message（诊断用）。 */
class ApiCallError extends Error {
  readonly code: string | undefined;
  readonly status: number;

  constructor(status: number, code: string | undefined, message: string) {
    super(message);
    this.code = code;
    this.status = status;
    this.name = 'ApiCallError';
  }
}

/** 把 HTTP 失败统一转成 ApiCallError（解析 `{ error, code }` 契约体，失败则用状态码）。 */
async function failure(res: Response): Promise<ApiCallError> {
  let code: string | undefined;
  try {
    const body = (await res.json()) as ApiErrorBody;
    code = body.code;
  } catch {
    code = undefined;
  }
  return new ApiCallError(res.status, code, `HTTP ${res.status}`);
}

function errorText(
  err: unknown,
  fallback: string,
  codeLabels: Record<string, string>,
): string {
  if (err instanceof ApiCallError) {
    const mapped = err.code ? codeLabels[err.code] : undefined;
    if (mapped) return mapped;
  }
  const detail = err instanceof Error ? err.message : String(err);
  return `${fallback} (${detail})`;
}

/** 逗号分隔输入 → 去空数组（偏好表单的 titles/skills/locations 共用）。 */
function splitList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

interface PreferenceDraft {
  label: string;
  targetTitles: string;
  skills: string;
  locations: string;
  remoteOnly: boolean;
  salaryMinUsd: string;
  minTier: MatchScoreTier;
  dailySubmitLimit: string;
}

const EMPTY_DRAFT: PreferenceDraft = {
  label: '',
  targetTitles: '',
  skills: '',
  locations: '',
  remoteOnly: false,
  salaryMinUsd: '',
  minTier: 'mid',
  dailySubmitLimit: '20',
};

const TIER_ORDER: MatchScoreTier[] = ['high', 'mid', 'low'];

/**
 * 把一条待投票据渲染成 Blob 并触发下载（简历/求职信共用）。
 * 服务端 `format=md` 直接回 text/plain 正文，这里只负责落地为文件。
 */
function downloadText(text: string, fileName: string): void {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * 已投清单的一行：`GET /agent/runs/:id/submissions` 的形状。
 * 服务端把票据视图与关联投递的结果字段一起返回；`applicationId`/`outcome*` 不在
 * shared 的 SubmitIntent 契约里（那是票据视图的透传字段），所以在这里显式补齐。
 */
type SubmissionRow = SubmitIntent & {
  applicationId: string | null;
  outcomeFeedback: OutcomeFeedback | null;
  outcomeFeedbackAt: string | null;
};

export default function AgentWorkbench(props: AgentWorkbenchProps) {
  const { apiBase, locale, initialProfiles, claimedProfileId, profileHintHref, labels } =
    props;

  const [preferences, setPreferences] = useState<JobPreferences[]>([]);
  const [runs, setRuns] = useState<JobRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runView, setRunView] = useState<{
    run: JobRun;
    events: JobRunEvent[];
    intents: SubmitIntent[];
  } | null>(null);
  const [pending, setPending] = useState<SubmitIntent[] | null>(null);
  const [submissions, setSubmissions] = useState<SubmissionRow[]>([]);

  const [prefsLoading, setPrefsLoading] = useState(true);
  const [runsLoading, setRunsLoading] = useState(true);
  const [pendingLoading, setPendingLoading] = useState(false);
  const [prefsError, setPrefsError] = useState<string | null>(null);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [pendingError, setPendingError] = useState<string | null>(null);

  const [showPrefForm, setShowPrefForm] = useState(false);
  const [draft, setDraft] = useState<PreferenceDraft>(EMPTY_DRAFT);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [newProfileId, setNewProfileId] = useState(
    claimedProfileId ?? initialProfiles[0]?.profileId ?? '',
  );
  const [newPreferenceId, setNewPreferenceId] = useState('');
  const [creating, setCreating] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [scanNote, setScanNote] = useState<string | null>(null);
  const [busyIntentId, setBusyIntentId] = useState<string | null>(null);
  const [rejectReasons, setRejectReasons] = useState<Record<string, string>>({});
  const [approvedNote, setApprovedNote] = useState<string | null>(null);

  const seqRef = useRef(0);

  /**
   * 清未读：拥有者打开一个有待确认新候选的 run 时，调显式已读端点并就地把
   * runs 列表里的派生标记消掉（不重拉列表；下次 GET /agent/runs 仍会算出 false）。
   * 失败静默——未读只是提醒，绝不能因此挡住用户看待投清单。
   */
  const markRunViewed = useCallback(
    async (runId: string) => {
      try {
        const res = await fetch(
          `${apiBase}/agent/runs/${encodeURIComponent(runId)}/view`,
          { method: 'POST', credentials: 'include' },
        );
        if (!res.ok) return;
        setRuns((prev) =>
          prev.map((r) => (r.runId === runId ? { ...r, hasUnseenApprovals: false } : r)),
        );
      } catch {
        // 静默：未读标记失败不影响主流程
      }
    },
    [apiBase],
  );

  const selectRun = useCallback(
    (runId: string | null) => {
      setSelectedRunId(runId);
      setScanNote(null);
      setApprovedNote(null);
      // 用户主动点开一个带着未读新候选的任务才算「看过」；首屏自动展开不清徽标。
      // 静默、不阻塞详情加载，失败也不影响主流程。
      if (runId && runs.find((r) => r.runId === runId)?.hasUnseenApprovals) {
        void markRunViewed(runId);
      }
    },
    [runs, markRunViewed],
  );

  /** 拉取单个 run 的视图（状态 + 事件流 + 全部票据）。 */
  const fetchRunView = useCallback(
    async (runId: string): Promise<{ run: JobRun; events: JobRunEvent[]; intents: SubmitIntent[] }> => {
      const res = await fetch(`${apiBase}/agent/runs/${encodeURIComponent(runId)}`, {
        credentials: 'include',
      });
      if (!res.ok) throw await failure(res);
      return (await res.json()) as { run: JobRun; events: JobRunEvent[]; intents: SubmitIntent[] };
    },
    [apiBase],
  );

  /** 拉取待投清单（人机闸主交付物，单独端点）。 */
  const fetchPending = useCallback(
    async (runId: string): Promise<SubmitIntent[]> => {
      const res = await fetch(
        `${apiBase}/agent/runs/${encodeURIComponent(runId)}/pending-approvals`,
        { credentials: 'include' },
      );
      if (!res.ok) throw await failure(res);
      const body = (await res.json()) as { items?: SubmitIntent[] };
      return body.items ?? [];
    },
    [apiBase],
  );

  /** 已投清单（含各自的结果回标状态）；失败只影响这一块，不连带待投清单。 */
  const fetchSubmissions = useCallback(
    async (runId: string): Promise<SubmissionRow[]> => {
      const res = await fetch(
        `${apiBase}/agent/runs/${encodeURIComponent(runId)}/submissions`,
        { credentials: 'include' },
      );
      if (!res.ok) throw await failure(res);
      const body = (await res.json()) as { items?: SubmissionRow[] };
      return body.items ?? [];
    },
    [apiBase],
  );

  /** 首屏：并行拉本人偏好与任务列表。 */
  useEffect(() => {
    const seq = ++seqRef.current;
    let cancelled = false;
    void (async () => {
      const [prefsResult, runsResult] = await Promise.allSettled([
        (async () => {
          const res = await fetch(`${apiBase}/agent/preferences`, { credentials: 'include' });
          if (!res.ok) throw await failure(res);
          const body = (await res.json()) as { preferences?: JobPreferences[] };
          return body.preferences ?? [];
        })(),
        (async () => {
          const res = await fetch(`${apiBase}/agent/runs`, { credentials: 'include' });
          if (!res.ok) throw await failure(res);
          const body = (await res.json()) as { runs?: JobRun[] };
          return body.runs ?? [];
        })(),
      ]);
      if (cancelled || seq !== seqRef.current) return;

      if (prefsResult.status === 'fulfilled') {
        setPreferences(prefsResult.value);
        setNewPreferenceId((current) => current || (prefsResult.value[0]?.preferenceId ?? ''));
        setPrefsError(null);
      } else {
        setPrefsError(
          errorText(prefsResult.reason, labels.errors.preferences, labels.errors.code),
        );
      }
      setPrefsLoading(false);

      if (runsResult.status === 'fulfilled') {
        setRuns(runsResult.value);
        setRunsError(null);
        const first = runsResult.value[0];
        if (first) {
          setSelectedRunId((current) => current ?? first.runId);
        } else {
          setRunsLoading(false);
        }
      } else {
        setRunsError(errorText(runsResult.reason, labels.errors.runs, labels.errors.code));
        setRunsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // 仅首屏一次（labels 由服务端下发，不会在会话内变化）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBase]);

  /** 选中 run 变化：拉 run 视图 + 待投清单（并行，各自独立报错）。 */
  useEffect(() => {
    if (!selectedRunId) {
      setRunView(null);
      setPending(null);
      setRunsLoading(false);
      return;
    }
    const seq = ++seqRef.current;
    let cancelled = false;
    setRunsLoading(true);
    setPendingLoading(true);
    setRunsError(null);
    setPendingError(null);
    void (async () => {
      const [viewResult, pendingResult, submissionsResult] = await Promise.allSettled([
        fetchRunView(selectedRunId),
        fetchPending(selectedRunId),
        fetchSubmissions(selectedRunId),
      ]);
      if (cancelled || seq !== seqRef.current) return;

      if (viewResult.status === 'fulfilled') {
        setRunView(viewResult.value);
      } else {
        setRunView(null);
        setRunsError(errorText(viewResult.reason, labels.errors.runs, labels.errors.code));
      }
      setRunsLoading(false);

      if (pendingResult.status === 'fulfilled') {
        setPending(pendingResult.value);
      } else {
        setPending(null);
        setPendingError(
          errorText(pendingResult.reason, labels.errors.intents, labels.errors.code),
        );
      }
      setPendingLoading(false);
      setSubmissions(submissionsResult.status === 'fulfilled' ? submissionsResult.value : []);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRunId, apiBase, fetchRunView, fetchPending, fetchSubmissions]);

  /**
   * 统一 mutation 入口：过期响应守卫（seqRef）+ 失败取 code 通用文案 +
   * 成功后重拉当前 run 视图与待投清单。返回解析后的响应体，失败返回 null。
   */
  const mutate = useCallback(
    async <T,>(
      path: string,
      init: RequestInit,
      fallback: string,
      apply?: (body: T) => void,
    ): Promise<T | null> => {
      const seq = ++seqRef.current;
      try {
        const res = await fetch(`${apiBase}${path}`, {
          ...init,
          headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
          credentials: 'include',
        });
        if (!res.ok) throw await failure(res);
        const body = (await res.json()) as T;
        if (seq !== seqRef.current) return null; // 已有更新的请求，丢弃过期响应
        apply?.(body);
        if (selectedRunId) {
          const [viewResult, pendingResult, submissionsResult] = await Promise.allSettled([
            fetchRunView(selectedRunId),
            fetchPending(selectedRunId),
            fetchSubmissions(selectedRunId),
          ]);
          if (seq !== seqRef.current) return null;
          if (viewResult.status === 'fulfilled') setRunView(viewResult.value);
          if (pendingResult.status === 'fulfilled') setPending(pendingResult.value);
          if (submissionsResult.status === 'fulfilled') setSubmissions(submissionsResult.value);
        }
        return body;
      } catch (err) {
        if (seq !== seqRef.current) return null;
        const message = errorText(err, fallback, labels.errors.code);
        if (path.includes('/agent/preferences')) setPrefsError(message);
        else if (path.includes('/pending') || path.includes('/intents/')) setPendingError(message);
        else setRunsError(message);
        return null;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [apiBase, selectedRunId, fetchRunView, fetchPending, fetchSubmissions],
  );

  const refreshRuns = useCallback(async (): Promise<void> => {
    const seq = ++seqRef.current;
    setRunsLoading(true);
    try {
      const res = await fetch(`${apiBase}/agent/runs`, { credentials: 'include' });
      if (!res.ok) throw await failure(res);
      const body = (await res.json()) as { runs?: JobRun[] };
      if (seq !== seqRef.current) return;
      setRuns(body.runs ?? []);
      setRunsError(null);
    } catch (err) {
      if (seq !== seqRef.current) return;
      setRunsError(errorText(err, labels.errors.runs, labels.errors.code));
    } finally {
      if (seq === seqRef.current) setRunsLoading(false);
    }
  }, [apiBase, labels]);

  const refreshPreferences = useCallback(async (): Promise<void> => {
    const seq = ++seqRef.current;
    setPrefsLoading(true);
    try {
      const res = await fetch(`${apiBase}/agent/preferences`, { credentials: 'include' });
      if (!res.ok) throw await failure(res);
      const body = (await res.json()) as { preferences?: JobPreferences[] };
      if (seq !== seqRef.current) return;
      setPreferences(body.preferences ?? []);
      setPrefsError(null);
    } catch (err) {
      if (seq !== seqRef.current) return;
      setPrefsError(errorText(err, labels.errors.preferences, labels.errors.code));
    } finally {
      if (seq === seqRef.current) setPrefsLoading(false);
    }
  }, [apiBase, labels]);

  // ── 偏好：CRUD ──────────────────────────────────────────────────────────

  const createPreference = async (): Promise<void> => {
    const titles = splitList(draft.targetTitles);
    if (!draft.label.trim() || titles.length === 0) {
      setFormError(labels.preferences.required);
      return;
    }
    setSubmitting(true);
    setFormError(null);
    const salary = draft.salaryMinUsd.trim() ? Number(draft.salaryMinUsd.trim()) : undefined;
    const payload: Record<string, unknown> = {
      label: draft.label.trim(),
      targetTitles: titles,
      remoteOnly: draft.remoteOnly,
      minTier: draft.minTier,
    };
    const skills = splitList(draft.skills);
    if (skills.length > 0) payload.skills = skills;
    const locations = splitList(draft.locations);
    if (locations.length > 0) payload.locations = locations;
    if (salary !== undefined && Number.isFinite(salary)) payload.salaryMinUsd = salary;
    const limit = Number(draft.dailySubmitLimit.trim());
    if (Number.isFinite(limit) && limit > 0) payload.dailySubmitLimit = limit;

    const body = await mutate<{ preference: JobPreferences }>(
      '/agent/preferences',
      { method: 'POST', body: JSON.stringify(payload) },
      labels.errors.preferences,
    );
    setSubmitting(false);
    if (!body?.preference) return;
    setPreferences((prev) => [...prev, body.preference]);
    setNewPreferenceId((current) => current || body.preference.preferenceId);
    setDraft(EMPTY_DRAFT);
    setShowPrefForm(false);
  };

  const deletePreference = async (preferenceId: string): Promise<void> => {
    const body = await mutate<{ ok: true }>(
      `/agent/preferences/${encodeURIComponent(preferenceId)}`,
      { method: 'DELETE' },
      labels.errors.preferences,
    );
    if (!body?.ok) return;
    setPreferences((prev) => prev.filter((p) => p.preferenceId !== preferenceId));
    setNewPreferenceId((current) => (current === preferenceId ? '' : current));
  };

  // ── 任务：创建 / 扫描 / 取消 ────────────────────────────────────────────

  const createRun = async (): Promise<void> => {
    if (!newProfileId || !newPreferenceId) return;
    setCreating(true);
    const body = await mutate<{ run: JobRun }>(
      '/agent/runs',
      {
        method: 'POST',
        body: JSON.stringify({ preferenceId: newPreferenceId, profileId: newProfileId }),
      },
      labels.errors.runs,
    );
    setCreating(false);
    if (!body?.run) return;
    setRuns((prev) => [body.run, ...prev.filter((r) => r.runId !== body.run.runId)]);
    selectRun(body.run.runId);
    await refreshRuns();
  };

  const scanRun = async (): Promise<void> => {
    if (!selectedRunId) return;
    setScanning(true);
    setScanNote(null);
    const body = await mutate<{
      run: JobRun;
      events: JobRunEvent[];
      intents: SubmitIntent[];
      scan?: { candidates: number; intentsCreated: number; poolSize: number; note?: string };
    }>(
      `/agent/runs/${encodeURIComponent(selectedRunId)}/scan`,
      { method: 'POST' },
      labels.errors.runs,
    );
    setScanning(false);
    if (!body) return;
    if (body.scan) {
      const note = fillTemplate(labels.runs.scanResult, {
        candidates: body.scan.candidates,
        intentsCreated: body.scan.intentsCreated,
        poolSize: body.scan.poolSize,
      });
      setScanNote(body.scan.note ? `${note} — ${body.scan.note}` : note);
    }
    await refreshRuns();
  };

  const cancelRun = async (): Promise<void> => {
    if (!selectedRunId) return;
    setCancelling(true);
    await mutate<{ run: JobRun; events: JobRunEvent[]; intents: SubmitIntent[] }>(
      `/agent/runs/${encodeURIComponent(selectedRunId)}/cancel`,
      { method: 'POST' },
      labels.errors.runs,
    );
    setCancelling(false);
    await refreshRuns();
  };

  // ── 人机闸：确认 / 拒绝 / 标记已投 / 下载材料 ────────────────────────────

  const approveIntent = async (intentId: string): Promise<void> => {
    if (!selectedRunId) return;
    setBusyIntentId(intentId);
    setApprovedNote(null);
    const body = await mutate<{
      run: JobRun;
      events: JobRunEvent[];
      intents: SubmitIntent[];
      approved: number;
    }>(
      `/agent/runs/${encodeURIComponent(selectedRunId)}/approve`,
      { method: 'POST', body: JSON.stringify({ intentIds: [intentId] }) },
      labels.errors.intents,
    );
    setBusyIntentId(null);
    if (!body) return;
    setApprovedNote(fillTemplate(labels.pending.approved, { count: body.approved }));
  };

  const rejectIntent = async (intentId: string): Promise<void> => {
    if (!selectedRunId) return;
    const reason = (rejectReasons[intentId] ?? '').trim();
    setBusyIntentId(intentId);
    const body = await mutate<{ run: JobRun; events: JobRunEvent[]; intents: SubmitIntent[] }>(
      `/agent/runs/${encodeURIComponent(selectedRunId)}/reject`,
      {
        method: 'POST',
        body: JSON.stringify(reason ? { intentId, reason } : { intentId }),
      },
      labels.errors.intents,
    );
    setBusyIntentId(null);
    if (!body) return;
    setRejectReasons((prev) => {
      const next = { ...prev };
      delete next[intentId];
      return next;
    });
  };

  const markSubmitted = async (intentId: string): Promise<void> => {
    setBusyIntentId(intentId);
    const body = await mutate<{ intent: SubmitIntent; applicationId: string; run: JobRun }>(
      `/agent/intents/${encodeURIComponent(intentId)}/mark-submitted`,
      { method: 'POST' },
      labels.errors.intents,
    );
    setBusyIntentId(null);
    if (!body || !selectedRunId) return;
    await refreshRuns();
  };

  /**
   * D1 结果回标：把「已投」这条投递记上真实结果（无响应/邀约/面试/offer）。
   * 写端点早就有，缺的一直是入口——复盘样本（决策 #20-3 要 ≥20 条）只能从这里开始攒。
   */
  const recordOutcome = async (intentId: string, outcome: OutcomeFeedback): Promise<void> => {
    setBusyIntentId(intentId);
    await mutate<{ applicationId: string }>(
      `/agent/intents/${encodeURIComponent(intentId)}/outcome`,
      { method: 'POST', body: JSON.stringify({ outcome }) },
      labels.errors.intents,
    );
    setBusyIntentId(null);
  };

  /**
   * 下载简历/求职信 md，落成 `<company>-<title>.md`。
   *
   * - 简历走既有 `POST /resumes/build`（带上本机档案字段，电话/教育/工作经历不丢），
   *   与报告页简历按钮同一套 render 代码；
   * - 求职信走 `GET /agent/intents/:id/cover-letter`（规则版，无本机字段）。
   */
  const downloadArtifact = async (
    intent: SubmitIntent,
    kind: 'resume' | 'cover-letter',
  ): Promise<void> => {
    setBusyIntentId(intent.intentId);
    try {
      if (kind === 'resume') {
        const local = loadResumeLocalFields();
        const res = await fetch(`${apiBase}/resumes/build`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            profileId: intent.profileId,
            // 岗位池主键优先（/resumes/build 按池主键取岗位行）；老票据退回来源原生 jobId
            jobId: intent.job.postingId ?? intent.job.jobId,
            locale,
            format: 'md',
            ...(local ? { local } : {}),
          }),
        });
        if (!res.ok) throw await failure(res);
        const body = (await res.json()) as { markdown?: string };
        if (!body.markdown) throw new Error(`HTTP ${res.status}`);
        downloadText(body.markdown, intentFileName(intent, ''));
        return;
      }
      const url = `${apiBase}/agent/intents/${encodeURIComponent(intent.intentId)}/${kind}?format=md&locale=${encodeURIComponent(locale)}`;
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) throw await failure(res);
      const text = await res.text();
      downloadText(text, intentFileName(intent, '-cover-letter'));
    } catch (err) {
      setPendingError(errorText(err, labels.errors.intents, labels.errors.code));
    } finally {
      setBusyIntentId(null);
    }
  };

  const tierClass = (score: number, matchedSkillCount: number): string =>
    `rec-score--${matchScoreTier(score, matchedSkillCount)}`;

  const runItems = useMemo(
    () => [...runs].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)),
    [runs],
  );

  const activeRun = runView?.run ?? runs.find((r) => r.runId === selectedRunId) ?? null;
  const pendingItems = pending ?? [];
  const loading = prefsLoading || runsLoading || pendingLoading;
  const workbenchError = prefsError ?? runsError ?? pendingError;

  const renderMatchReport = (report: MatchReport) => (
    <details className="agent-match" data-testid="agent-match">
      <summary>{labels.match.title}</summary>
      <div className="agent-match-body">
        <div className="agent-match-score">
          <span className="ja-muted">{labels.fields.run}</span>
          <span className="agent-score-value">
            {report.score} · {labels.tiers[report.tier]}
          </span>
        </div>

        {report.matchedSkills.length > 0 && (
          <div className="agent-match-row">
            <span className="ja-muted agent-match-label">{labels.match.matchedSkills}</span>
            <span className="tag-list">
              {report.matchedSkills.map((skill) => (
                <span key={skill} className="skill-tag skill-tag--proficient">
                  {skill}
                </span>
              ))}
            </span>
          </div>
        )}

        {report.reasons.length > 0 && (
          <div className="agent-match-row">
            <span className="ja-muted agent-match-label">{labels.match.reasons}</span>
            <ul className="agent-match-list">
              {report.reasons.map((reason, i) => (
                <li key={`${reason.code}-${reason.skill}-${i}`}>
                  {fillTemplate(labels.match.reason[reason.code], {
                    skill: reason.skill,
                    points: fillTemplate(labels.match.points, { points: reason.points }),
                  })}
                </li>
              ))}
            </ul>
          </div>
        )}

        {report.gaps.length > 0 && (
          <div className="agent-match-row">
            <span className="ja-muted agent-match-label">{labels.match.gaps}</span>
            <ul className="agent-match-list">
              {report.gaps.map((gap, i) => (
                <li key={`${gap.code}-${gap.tag}-${i}`}>
                  {fillTemplate(labels.match.gap[gap.code], { tag: gap.tag })}
                </li>
              ))}
            </ul>
          </div>
        )}

        {report.suggestedBoost.length > 0 && (
          <div className="agent-match-row">
            <span className="ja-muted agent-match-label">{labels.match.boosts}</span>
            <ul className="agent-match-list">
              {report.suggestedBoost.map((boost, i) => (
                <li key={`${boost.code}-${boost.skill}-${i}`}>
                  {fillTemplate(labels.match.boost[boost.code], {
                    skill: boost.skill,
                  })}
                </li>
              ))}
            </ul>
          </div>
        )}

        {report.reasons.length === 0 &&
          report.gaps.length === 0 &&
          report.suggestedBoost.length === 0 && (
            <p className="ja-muted">{labels.match.none}</p>
          )}
      </div>
    </details>
  );

  const renderIntent = (intent: SubmitIntent) => {
    const { job } = intent;
    const salary =
      job.salaryMin != null || job.salaryMax != null
        ? `${job.salaryMin ?? '—'} – ${job.salaryMax ?? '—'} ${job.salaryCurrency ?? ''}`.trim()
        : labels.pending.salaryUnavailable;
    const href = job.applyUrl ?? job.sourceUrl;
    const busy = busyIntentId === intent.intentId;
    return (
      <li className="ja-card agent-intent" key={intent.intentId} data-testid="agent-intent">
        <div className="agent-intent-head">
          <strong className="agent-intent-title">{job.title}</strong>
          <span
            className={`rec-score ${tierClass(intent.matchScore, intent.report.matchedSkills.length)}`}
            data-testid="agent-intent-tier"
            title={labels.tiers[intent.matchTier]}
          >
            {labels.tiers[intent.matchTier]}
          </span>
        </div>
        <div className="agent-intent-meta">
          <span className="agent-intent-fact">
            <span className="ja-muted">{labels.fields.company}</span> {job.company}
          </span>
          {job.location && (
            <span className="agent-intent-fact">
              <span className="ja-muted">{labels.fields.location}</span> {job.location}
            </span>
          )}
          {job.remote && <span className="rec-badge">{labels.pending.remote}</span>}
          <span className="agent-intent-fact">
            <span className="ja-muted">{labels.fields.salary}</span> {salary}
          </span>
          <span className="agent-intent-fact">
            <span className="ja-muted">
              {fillTemplate(labels.fields.postedAt, {
                date: formatEventTime(job.postedAt, locale),
              })}
            </span>
          </span>
          <span className="agent-intent-status ja-muted">
            {labels.intentStatuses[intent.status]}
          </span>
        </div>

        {intent.report.matchedSkills.length > 0 && (
          <div className="agent-match-row">
            <span className="ja-muted agent-match-label">{labels.match.matchedSkills}</span>
            <span className="tag-list">
              {intent.report.matchedSkills.map((skill) => (
                <span key={skill} className="skill-tag skill-tag--proficient">
                  {skill}
                </span>
              ))}
            </span>
          </div>
        )}

        {renderMatchReport(intent.report)}

        <div className="agent-intent-actions">
          <button
            type="button"
            className="ja-btn"
            disabled={busy}
            onClick={() => void approveIntent(intent.intentId)}
          >
            {labels.pending.approve}
          </button>
          <input
            className="ja-input agent-reject-reason"
            aria-label={labels.pending.rejectReasonLabel}
            placeholder={labels.pending.rejectReasonPlaceholder}
            value={rejectReasons[intent.intentId] ?? ''}
            onChange={(e) =>
              setRejectReasons((prev) => ({ ...prev, [intent.intentId]: e.target.value }))
            }
          />
          <button
            type="button"
            className="ja-btn ja-btn--ghost"
            disabled={busy}
            onClick={() => void rejectIntent(intent.intentId)}
          >
            {labels.pending.reject}
          </button>
          <button
            type="button"
            className="ja-btn ja-btn--ghost"
            disabled={busy}
            onClick={() => void downloadArtifact(intent, 'resume')}
          >
            {labels.pending.resume}
          </button>
          <button
            type="button"
            className="ja-btn ja-btn--ghost"
            disabled={busy}
            onClick={() => void downloadArtifact(intent, 'cover-letter')}
          >
            {labels.pending.coverLetter}
          </button>
          <a className="agent-intent-link" href={href} target="_blank" rel="noopener noreferrer">
            {labels.pending.apply}
          </a>
          <button
            type="button"
            className="ja-btn ja-btn--ghost"
            disabled={busy}
            onClick={() => void markSubmitted(intent.intentId)}
          >
            {labels.pending.markSubmitted}
          </button>
        </div>
      </li>
    );
  };

  return (
    <section className="agent-workbench" data-testid="agent-workbench">
      <header className="agent-workbench-header">
        <h1>{labels.title}</h1>
        <p className="ja-muted">{labels.subtitle}</p>
      </header>

      {loading && (
        <p className="ja-muted" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          {labels.loading}
        </p>
      )}

      {workbenchError && (
        <p className="ja-alert ja-alert--error ja-alert--danger" role="alert">
          {labels.error}: {workbenchError}
        </p>
      )}

      {initialProfiles.length === 0 && (
        <div className="ja-card agent-no-profile" data-testid="agent-no-profile">
          <p className="ja-muted">{labels.noProfileHint}</p>
          <a className="ja-btn" href={profileHintHref}>
            {labels.noProfileAction}
          </a>
        </div>
      )}

      {/* ── 我的求职偏好 ─────────────────────────────────────────────── */}
      <section className="ja-card agent-prefs" data-testid="agent-prefs">
        <div className="ja-flex-between">
          <h2>{labels.preferences.title}</h2>
          <button
            type="button"
            className="ja-btn ja-btn--ghost"
            onClick={() => {
              setShowPrefForm((v) => !v);
              setFormError(null);
            }}
          >
            + {showPrefForm ? labels.preferences.cancel : labels.preferences.add}
          </button>
        </div>
        <p className="ja-muted">{labels.preferences.hint}</p>

        {prefsLoading && (
          <p className="ja-muted" role="status" aria-live="polite">
            {labels.preferences.loading}
          </p>
        )}

        {showPrefForm && (
          <div className="agent-pref-form" data-testid="agent-pref-form">
            <div className="agent-field">
              <label htmlFor="agent-pref-label">{labels.preferences.labelLabel}</label>
              <input
                id="agent-pref-label"
                className="ja-input"
                value={draft.label}
                placeholder={labels.preferences.labelPlaceholder}
                onChange={(e) => setDraft({ ...draft, label: e.target.value })}
              />
            </div>
            <div className="agent-field">
              <label htmlFor="agent-pref-titles">{labels.preferences.titlesLabel}</label>
              <input
                id="agent-pref-titles"
                className="ja-input"
                value={draft.targetTitles}
                placeholder={labels.preferences.titlesPlaceholder}
                onChange={(e) => setDraft({ ...draft, targetTitles: e.target.value })}
              />
            </div>
            <div className="agent-field">
              <label htmlFor="agent-pref-skills">{labels.preferences.skillsLabel}</label>
              <input
                id="agent-pref-skills"
                className="ja-input"
                value={draft.skills}
                placeholder={labels.preferences.skillsPlaceholder}
                onChange={(e) => setDraft({ ...draft, skills: e.target.value })}
              />
            </div>
            <div className="agent-field">
              <label htmlFor="agent-pref-locations">{labels.preferences.locationsLabel}</label>
              <input
                id="agent-pref-locations"
                className="ja-input"
                value={draft.locations}
                placeholder={labels.preferences.locationsPlaceholder}
                onChange={(e) => setDraft({ ...draft, locations: e.target.value })}
              />
            </div>
            <div className="agent-field">
              <label htmlFor="agent-pref-salary">{labels.preferences.salaryLabel}</label>
              <input
                id="agent-pref-salary"
                className="ja-input"
                inputMode="numeric"
                value={draft.salaryMinUsd}
                placeholder={labels.preferences.salaryPlaceholder}
                onChange={(e) => setDraft({ ...draft, salaryMinUsd: e.target.value })}
              />
            </div>
            <div className="agent-field">
              <label htmlFor="agent-pref-tier">{labels.preferences.minTierLabel}</label>
              <select
                id="agent-pref-tier"
                className="ja-input"
                value={draft.minTier}
                onChange={(e) =>
                  setDraft({ ...draft, minTier: e.target.value as MatchScoreTier })
                }
              >
                {TIER_ORDER.map((tier) => (
                  <option key={tier} value={tier}>
                    {labels.tiers[tier]}
                  </option>
                ))}
              </select>
            </div>
            <div className="agent-field">
              <label htmlFor="agent-pref-limit">{labels.preferences.dailySubmitLimitLabel}</label>
              <input
                id="agent-pref-limit"
                className="ja-input"
                inputMode="numeric"
                value={draft.dailySubmitLimit}
                onChange={(e) => setDraft({ ...draft, dailySubmitLimit: e.target.value })}
              />
            </div>
            <label className="agent-checkbox">
              <input
                type="checkbox"
                checked={draft.remoteOnly}
                onChange={(e) => setDraft({ ...draft, remoteOnly: e.target.checked })}
              />
              <span>{labels.preferences.remoteOnlyLabel}</span>
            </label>

            {formError && (
              <p className="ja-alert ja-alert--error ja-alert--danger" role="alert">
                {formError}
              </p>
            )}

            <div className="agent-form-actions">
              <button
                type="button"
                className="ja-btn"
                disabled={submitting}
                onClick={() => void createPreference()}
              >
                {labels.preferences.create}
              </button>
              <button
                type="button"
                className="ja-btn ja-btn--ghost"
                onClick={() => {
                  setDraft(EMPTY_DRAFT);
                  setFormError(null);
                  setShowPrefForm(false);
                }}
              >
                {labels.preferences.cancel}
              </button>
            </div>
          </div>
        )}

        {!prefsLoading && preferences.length === 0 && (
          <EmptyState
            icon="briefcase"
            title={labels.preferences.empty}
            ctaLabel={labels.preferences.add}
            onCta={() => {
              setShowPrefForm(true);
              setFormError(null);
              requestAnimationFrame(() => {
                document.getElementById('agent-pref-label')?.focus();
              });
            }}
          />
        )}

        {preferences.length > 0 && (
          <ul className="agent-pref-list" data-testid="agent-pref-list">
            {preferences.map((pref) => (
              <li className="agent-pref" key={pref.preferenceId} data-testid="agent-pref">
                <div className="agent-pref-head">
                  <strong>{pref.label}</strong>
                  <span className="ja-muted">
                    {fillTemplate(labels.preferences.createdAt, {
                      date: formatEventTime(pref.createdAt, locale),
                    })}
                  </span>
                </div>
                <div className="agent-pref-meta">
                  <span className="tag-list">
                    {pref.targetTitles.map((title) => (
                      <span key={title} className="skill-tag">
                        {title}
                      </span>
                    ))}
                  </span>
                  <span className="ja-muted">
                    {labels.preferences.minTierLabel}: {labels.tiers[pref.minTier]}
                  </span>
                  <span className="ja-muted">
                    {labels.preferences.dailySubmitLimitLabel}: {pref.dailySubmitLimit}
                  </span>
                  {pref.remoteOnly && (
                    <span className="rec-badge">{labels.pending.remote}</span>
                  )}
                </div>
                <button
                  type="button"
                  className="ja-btn ja-btn--ghost"
                  onClick={() => void deletePreference(pref.preferenceId)}
                >
                  {labels.preferences.delete}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── 求职任务 + 事件流 ────────────────────────────────────────── */}
      <section className="ja-card agent-runs" data-testid="agent-runs">
        <div className="ja-flex-between">
          <h2>{labels.runs.title}</h2>
          <button
            type="button"
            className="ja-btn ja-btn--ghost"
            onClick={() => void refreshRuns()}
          >
            {labels.actions.refresh}
          </button>
        </div>
        <p className="ja-muted">{labels.runs.hint}</p>

        <div className="agent-run-form" data-testid="agent-run-form">
          <div className="agent-field">
            <label htmlFor="agent-run-profile">{labels.runs.profileLabel}</label>
            <select
              id="agent-run-profile"
              className="ja-input"
              value={newProfileId}
              onChange={(e) => setNewProfileId(e.target.value)}
            >
              {initialProfiles.length === 0 && (
                <option value="">{labels.runs.noProfileOption}</option>
              )}
              {initialProfiles.map((p) => (
                <option key={p.profileId} value={p.profileId}>
                  {p.headline}
                </option>
              ))}
            </select>
          </div>
          <div className="agent-field">
            <label htmlFor="agent-run-preference">{labels.runs.preferenceLabel}</label>
            <select
              id="agent-run-preference"
              className="ja-input"
              value={newPreferenceId}
              onChange={(e) => setNewPreferenceId(e.target.value)}
            >
              {preferences.length === 0 && (
                <option value="">{labels.runs.noPreferenceOption}</option>
              )}
              {preferences.map((pref) => (
                <option key={pref.preferenceId} value={pref.preferenceId}>
                  {pref.label}
                </option>
              ))}
            </select>
          </div>
          <div className="agent-form-actions">
            <button
              type="button"
              className="ja-btn"
              disabled={creating || !newProfileId || !newPreferenceId}
              onClick={() => void createRun()}
            >
              {labels.runs.create}
            </button>
            <button
              type="button"
              className="ja-btn ja-btn--ghost"
              disabled={scanning || !selectedRunId}
              onClick={() => void scanRun()}
            >
              {labels.runs.scan}
            </button>
            <button
              type="button"
              className="ja-btn ja-btn--ghost"
              disabled={cancelling || !selectedRunId}
              onClick={() => void cancelRun()}
            >
              {labels.runs.cancel}
            </button>
          </div>
        </div>

        {runsLoading && (
          <p className="ja-muted" role="status" aria-live="polite">
            {labels.loading}
          </p>
        )}

        {!runsLoading && runItems.length === 0 && (
          <EmptyState icon="search" title={labels.runs.empty} />
        )}

        {runItems.length > 0 && (
          <ul className="agent-run-list" data-testid="agent-run-list">
            {runItems.map((run) => (
              <li key={run.runId}>
                <button
                  type="button"
                  className={`agent-run${run.runId === selectedRunId ? ' agent-run--active' : ''}`}
                  data-testid="agent-run"
                  aria-pressed={run.runId === selectedRunId}
                  onClick={() => selectRun(run.runId)}
                >
                  <span className="agent-run-id">{run.runId}</span>
                  <span className={`agent-status agent-status--${run.status}`}>
                    {labels.statuses[run.status]}
                  </span>
                  {run.hasUnseenApprovals && (
                    <span
                      className="agent-unseen-badge"
                      data-testid="agent-run-unseen"
                      role="status"
                    >
                      {labels.runs.newCandidates}
                    </span>
                  )}
                  <span className="ja-muted">
                    {fillTemplate(labels.runs.attempts, { count: run.attempts })}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {scanNote && (
          <p className="ja-muted" role="status" aria-live="polite" data-testid="agent-scan-note">
            {scanNote}
          </p>
        )}

        {activeRun && (
          <div className="agent-run-detail" data-testid="agent-run-detail">
            <div className="agent-run-detail-head">
              <span className={`agent-status agent-status--${activeRun.status}`}>
                {labels.statuses[activeRun.status]}
              </span>
              <span className="ja-muted">
                {activeRun.lastScanAt
                  ? fillTemplate(labels.runs.lastScan, {
                      date: formatEventTime(activeRun.lastScanAt, locale),
                    })
                  : labels.runs.lastScanNever}
              </span>
              <span className="ja-muted">
                {fillTemplate(labels.runs.attempts, { count: activeRun.attempts })}
              </span>
            </div>

            {activeRun.lastError && (
              <p className="ja-alert ja-alert--error ja-alert--danger" role="alert">
                {activeRun.lastError}
              </p>
            )}

            <h3>{labels.runs.timeline}</h3>
            {runView && runView.events.length === 0 && (
              <p className="ja-muted">{labels.runs.timelineEmpty}</p>
            )}
            {runView && runView.events.length > 0 && (
              <ol className="agent-timeline" data-testid="agent-timeline">
                {runView.events.map((event) => (
                  <li className="agent-event" key={event.eventId} data-testid="agent-event">
                    <span className="agent-event-kind">
                      {eventKindLabel(event.event, labels.eventKinds)}
                    </span>
                    <span className="agent-event-transition ja-muted">
                      {event.fromStatus
                        ? `${labels.runs.from} ${labels.statuses[event.fromStatus]} → ${labels.statuses[event.toStatus]}`
                        : labels.statuses[event.toStatus]}
                    </span>
                    <span className="ja-muted">
                      {labels.runs.actorLabel}: {labels.actors[event.actor]}
                    </span>
                    <time className="ja-muted" dateTime={event.createdAt}>
                      {formatEventTime(event.createdAt, locale)}
                    </time>
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}

        {!runsLoading && !activeRun && runItems.length > 0 && (
          <p className="ja-muted">{labels.runs.selectHint}</p>
        )}
      </section>

      {/* ── 待投清单（人机闸）────────────────────────────────────────── */}
      <section className="ja-card agent-pending" data-testid="agent-pending">
        <h2>{labels.pending.title}</h2>
        <p className="ja-muted">{labels.pending.hint}</p>

        {pendingLoading && (
          <p className="ja-muted" role="status" aria-live="polite">
            {labels.pending.loading}
          </p>
        )}

        {approvedNote && (
          <p className="ja-muted" role="status" aria-live="polite" data-testid="agent-approved-note">
            {approvedNote}
          </p>
        )}

        {!pendingLoading && pendingItems.length === 0 && (
          <EmptyState icon="inbox" title={labels.pending.empty} />
        )}

        {pendingItems.length > 0 && (
          <ul className="agent-intent-list">{pendingItems.map(renderIntent)}</ul>
        )}
      </section>

      <section className="ja-card agent-pending" data-testid="agent-submissions">
        <h2>{labels.submissions.title}</h2>
        <p className="ja-muted">{labels.submissions.hint}</p>
        {submissions.length === 0 ? (
          <EmptyState icon="send" title={labels.submissions.empty} />
        ) : (
          <ul className="agent-intent-list">
            {submissions.map((row) => (
              <li className="ja-card agent-intent" key={row.intentId} data-testid="agent-submission">
                <span className="ja-muted">{row.job.title}</span>
                <span className="ja-muted">{row.job.company}</span>
                <label>
                  <span className="ja-muted">{labels.submissions.outcomeLabel}</span>
                  <select
                    value={row.outcomeFeedback ?? ''}
                    disabled={busyIntentId === row.intentId || !row.applicationId}
                    onChange={(e) => {
                      const next = e.target.value as OutcomeFeedback | '';
                      if (next) void recordOutcome(row.intentId, next);
                    }}
                  >
                    <option value="">{labels.submissions.outcomeUnset}</option>
                    {OUTCOME_FEEDBACK_VALUES.map((code) => (
                      <option key={code} value={code}>
                        {labels.submissions.outcome[code]}
                      </option>
                    ))}
                  </select>
                </label>
                {row.outcomeFeedback && (
                  <span className="ja-muted" data-testid="agent-outcome-saved">
                    {labels.submissions.saved}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
