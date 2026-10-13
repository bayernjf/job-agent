import { randomUUID } from 'node:crypto';
import { matchJobs, staleCutoffIso, type JobMatch } from '@jobagent/job-source';
import {
  enhanceMatchReportWithJd,
  filterPostingsForPreference,
  planIntents,
  planTransition,
  preferenceToMatchCriteria,
  selectCandidatesWithReasonsForPreference,
  type ExcludedCandidate,
} from '@jobagent/agent-core';
import {
  buildCoverLetter,
  buildResume,
  renderCoverLetterMarkdown,
  renderMarkdown,
  type ResumeMatchInput,
} from '@jobagent/resume-core';
import {
  toEvidenceItems,
  type IApplicationsRepository,
  type IEvidenceRepository,
  type IJobPostingsRepository,
  type IJobPreferencesRepository,
  type IJobRunEventsRepository,
  type IJobRunsRepository,
  type IProfilesRepository,
  type ISubmitIntentsRepository,
  type StoredJobPosting,
  type StoredJobPreference,
  type StoredJobRun,
  type StoredJobRunEvent,
  type StoredSubmitIntent,
} from '@jobagent/storage';
import type {
  AbilityProfile,
  CoverLetterDraft,
  JobPosting,
  MatchReport,
  MatchScoreTier,
  ResumeDraft,
} from '@jobagent/shared';
import { AGENT_ERROR_CODES } from '@jobagent/shared';
import type { AgentConfig } from './agent-config.js';
import { AGENT_DEFAULTS } from './agent-config.js';

/**
 * 求职 Agent 编排壳（阶段 1：求职工作台）。
 *
 * 分工（对齐 AGENTS「内核与 I/O 分离」）：
 *   - 语义（状态迁移、质量闸、排序、报告口径）全在 `@jobagent/agent-core` 纯函数里；
 *   - 本文件只负责 I/O 与顺序：读库 → 调 matchJobs → 写事件/票据 → 用原子条件更新
 *     （`compareAndSetStatus`）保证并发下不会双重推进；
 *   - 工件（定向简历/求职信）**不落库**：画像快照与票据里的岗位精简快照都是不可变事实，
 *     按需重新装配即可复现同一份交付物（设计 §8 开放问题 2「简历快照留存」因此仍可留待拍板）。
 *
 * 阶段 1 的硬边界：本模块**只准备，不投递**——没有任何对外部系统的写动作。
 */

export interface AgentRepos {
  jobPreferences: IJobPreferencesRepository;
  jobRuns: IJobRunsRepository;
  jobRunEvents: IJobRunEventsRepository;
  submitIntents: ISubmitIntentsRepository;
  profiles: IProfilesRepository;
  evidence: IEvidenceRepository;
  jobPostings: IJobPostingsRepository;
  applications: IApplicationsRepository;
}

/**
 * cron tick 的共享执行上下文（手动「立即扫描」不传，不受 tick 墙钟限制）：
 *   - deadlineAt：整轮 tick 的墙钟截止时刻（epoch ms），每接一个新 run、每次 LLM 调用前检查；
 *   - pool：本 tick 只查一次的岗位池快照，跨 run 复用（避免每 run 各打一次相同查询）。
 */
export interface TickContext {
  deadlineAt?: number;
  pool?: StoredJobPosting[];
}

export interface AgentScanStats {
  poolSize: number;
  /** 通过偏好硬过滤 + 匹配（score>0）的候选数 */
  matchedCount: number;
  /** 过质量闸并成功装配工件的候选数 */
  candidateCount: number;
  /**
   * 过了硬过滤与匹配、但没进本轮票据的条数＝`matchedCount - candidateCount` 口径里的
   * "未选中"全集：**既含**已出票据/已投递的去重，**也含**质量闸挡下的条目。
   * 要区分两者按原因看 `GET /agent/runs/:id/gate-exclusions`（这里只给一个总数）。
   */
  excludedCount: number;
  /** 装配工件失败被跳过的条数（显式记录，不静默） */
  skippedCount: number;
}

export interface AgentRunViewData {
  run: StoredJobRun;
  /** 最新一页事件（默认 200 条，正序）。更早的走 `GET /agent/runs/:id/events` */
  events: StoredJobRunEvent[];
  /** 事件流是否还有本页之外的更早内容（仓储哨兵行探出来的） */
  eventsHasMore: boolean;
  intents: StoredSubmitIntent[];
}

export type AdvanceOutcome =
  | { ok: true; view: AgentRunViewData; scan?: AgentScanStats }
  | { ok: false; status: 404 | 409 | 500; code: string; message: string };

/** 读取任务视图（状态 + 事件流 + 票据），GET/scan/approve/reject 共用。 */
export async function loadRunView(
  repos: Pick<AgentRepos, 'jobRuns' | 'jobRunEvents' | 'submitIntents'>,
  run: StoredJobRun,
): Promise<AgentRunViewData> {
  const [page, intents] = await Promise.all([
    repos.jobRunEvents.listLatestPage(run.id),
    repos.submitIntents.listByRun(run.id),
  ]);
  return { run, events: page.events, eventsHasMore: page.hasMore, intents };
}

/**
 * 记一条迁移事件并原子推进状态；条件不满足（并发/状态已变）返回 undefined。
 * 导出给 API 端点复用（cancel 等人工动作与 cron 走同一条审计路径）。
 */
export async function applyRunEvent(
  repos: AgentRepos,
  run: StoredJobRun,
  event: Parameters<typeof planTransition>[1],
  actor: 'user' | 'agent' | 'system',
  nowIso: string,
  patch: { attempts?: number; lastError?: string | null; lastScanAt?: string | null } = {},
): Promise<StoredJobRun | undefined> {
  const plan = planTransition(run.status, event);
  if (!plan.ok) return undefined;
  // CAS 与事件落库同事务：CAS 输家（别人已推进）零事件，赢家状态与审计永远一致
  return repos.jobRuns.compareAndSetStatusWithEvent(
    run.id,
    run.status,
    {
      status: plan.to,
      ...patch,
      updatedAt: nowIso,
    },
    {
      id: `evt-${randomUUID()}`,
      runId: run.id,
      event: plan.event,
      fromStatus: plan.from,
      toStatus: plan.to,
      actor,
      payload: eventPayload(patch),
      createdAt: nowIso,
    },
  );
}

function eventPayload(
  patch: { attempts?: number; lastError?: string | null; lastScanAt?: string | null },
): Record<string, string | number | boolean | null> {
  const payload: Record<string, string | number | boolean | null> = {};
  if (patch.attempts !== undefined) payload.attempts = patch.attempts;
  if (patch.lastError !== undefined) payload.lastError = patch.lastError;
  if (patch.lastScanAt !== undefined) payload.lastScanAt = patch.lastScanAt;
  return payload;
}

/** 显式失败：写 failed 终态 + 原因（禁止"看似成功"）。 */
async function failRun(
  repos: AgentRepos,
  run: StoredJobRun,
  message: string,
  actor: 'user' | 'agent' | 'system',
  nowIso: string,
): Promise<StoredJobRun | undefined> {
  return applyRunEvent(repos, run, 'fail', actor, nowIso, { lastError: message });
}

function postingFromIntentSnapshot(intent: StoredSubmitIntent): JobPosting {
  const job: JobPosting = {
    jobId: intent.job.jobId,
    source: intent.job.source,
    sourceUrl: intent.job.sourceUrl,
    title: intent.job.title,
    company: intent.job.company,
    location: intent.job.location ?? null,
    remote: intent.job.remote,
    salaryMin: intent.job.salaryMin ?? null,
    salaryMax: intent.job.salaryMax ?? null,
    salaryCurrency: intent.job.salaryCurrency ?? null,
    tags: [...intent.job.tags],
    description: null,
    postedAt: intent.job.postedAt,
    fetchedAt: intent.createdAt,
  };
  if (intent.job.applyUrl) job.applyUrl = intent.job.applyUrl;
  return job;
}

/** 票据的岗位：岗位池还在就用实时行，否则退回票据里的精简快照（岗位下架不改写历史票据）。 */
async function postingForIntent(
  repos: Pick<AgentRepos, 'jobPostings'>,
  intent: StoredSubmitIntent,
): Promise<{ posting: JobPosting; fromSnapshot: boolean }> {
  // 池主键（postingId）优先；老票据没有该字段时退回来源原生 jobId（查不到就走快照兜底）
  const poolKey = intent.job.postingId ?? intent.job.jobId;
  const live = await repos.jobPostings.getById(poolKey);
  if (live) return { posting: live, fromSnapshot: false };
  return { posting: postingFromIntentSnapshot(intent), fromSnapshot: true };
}

/**
 * 从已存的匹配报告还原简历/求职信的匹配输入。
 *
 * 报告里存的是 code + 事实（title_match/tag_match/description_match + 分值），
 * 这是 `matchJobs` 的 skillHits 的无损投影：按技能分组求和即可还原 score/fields。
 * 因此**不需要重新匹配**，也就不会出现"票据上的分数"与"简历里的排序"两套口径。
 */
export function resumeMatchFromReport(report: MatchReport): ResumeMatchInput {
  const fieldByCode = {
    title_match: 'title',
    tag_match: 'tags',
    description_match: 'description',
  } as const;
  const order: string[] = [];
  const bySkill = new Map<string, { score: number; fields: ('title' | 'tags' | 'description')[] }>();
  for (const reason of report.reasons) {
    const entry = bySkill.get(reason.skill) ?? { score: 0, fields: [] };
    entry.score += reason.points;
    const field = fieldByCode[reason.code];
    if (!entry.fields.includes(field)) entry.fields.push(field);
    bySkill.set(reason.skill, entry);
    if (!order.includes(reason.skill)) order.push(reason.skill);
  }
  return {
    score: report.score,
    matchedSkills: [...report.matchedSkills],
    fieldScores: {
      title: report.fieldScores.title,
      tags: report.fieldScores.tags,
      description: report.fieldScores.description,
    },
    skillHits: order.map((skill) => ({
      skill,
      score: bySkill.get(skill)!.score,
      fields: bySkill.get(skill)!.fields,
    })),
  };
}

export interface IntentArtifacts {
  resume: ResumeDraft;
  coverLetter: CoverLetterDraft;
  /** 装配所用岗位（活岗位行或票据快照重建）；C2 LLM 求职信润色需要它 */
  posting: JobPosting;
  /** 岗位已不在岗位池，工件按票据快照生成 */
  fromSnapshot: boolean;
}

/**
 * 按需装配票据的两件交付物（纯计算，不落库）。
 * `local` 只能来自浏览器本机（服务端不持久化），故服务端渲染的简历不含本地补填字段；
 * 报告页/工作台的下载按钮走 `POST /resumes/build` 带上本机字段（同一套 render 代码）。
 */
export async function buildIntentArtifacts(
  repos: Pick<AgentRepos, 'profiles' | 'evidence' | 'jobPostings'>,
  intent: StoredSubmitIntent,
  options: { locale: 'zh-CN' | 'en'; now?: string },
): Promise<IntentArtifacts | undefined> {
  const profileRow = await repos.profiles.getById(intent.profileId);
  const profile = profileRow?.snapshot as AbilityProfile | null | undefined;
  if (!profile) return undefined;
  const { posting, fromSnapshot } = await postingForIntent(repos, intent);
  const evidence = toEvidenceItems(await repos.evidence.listByProfile(intent.profileId));
  const match = resumeMatchFromReport(intent.report);
  const now = options.now ?? new Date().toISOString();
  const resume = buildResume({
    profile,
    evidence,
    posting,
    match,
    options: { locale: options.locale, now },
  });
  const coverLetter = buildCoverLetter({
    profile,
    evidence,
    posting,
    match,
    options: { locale: options.locale, now },
  });
  return { resume, coverLetter, posting, fromSnapshot };
}

/** 供 API 端点复用的渲染入口（md / html）。 */
export async function renderIntentResume(
  repos: Pick<AgentRepos, 'profiles' | 'evidence' | 'jobPostings'>,
  intent: StoredSubmitIntent,
  locale: 'zh-CN' | 'en',
): Promise<{ markdown: string; draft: ResumeDraft; fromSnapshot: boolean } | undefined> {
  const artifacts = await buildIntentArtifacts(repos, intent, { locale });
  if (!artifacts) return undefined;
  return {
    markdown: renderMarkdown(artifacts.resume, locale),
    draft: artifacts.resume,
    fromSnapshot: artifacts.fromSnapshot,
  };
}

export async function renderIntentCoverLetter(
  repos: Pick<AgentRepos, 'profiles' | 'evidence' | 'jobPostings'>,
  intent: StoredSubmitIntent,
  locale: 'zh-CN' | 'en',
): Promise<{ markdown: string; draft: CoverLetterDraft; fromSnapshot: boolean } | undefined> {
  const artifacts = await buildIntentArtifacts(repos, intent, { locale });
  if (!artifacts) return undefined;
  return {
    markdown: renderCoverLetterMarkdown(artifacts.coverLetter),
    draft: artifacts.coverLetter,
    fromSnapshot: artifacts.fromSnapshot,
  };
}

/** 该画像已投递/已保存的岗位 id（本轮不再重复推荐，对齐 /profiles/:id/job-recommendations 的排除口径）。 */
export async function appliedJobIds(
  repos: Pick<AgentRepos, 'applications'>,
  profileId: string,
): Promise<Set<string>> {
  const applications = await repos.applications.listByProfile(profileId);
  const ids = new Set<string>();
  for (const application of applications) {
    if (application.jobId) ids.add(application.jobId);
  }
  return ids;
}

/**
 * 推进一个任务一轮（人为点击「立即扫描」或 cron tick 调用）。
 *
 * 顺序（与设计 §5.2 的状态机一致）：
 *   created --validate--> configured --start--> watching
 *   watching --candidates_ready--> recommending（原子占位，抢到的才写票据）
 *   recommending --generated--> awaiting_approval
 *   无合格项：watching --rescan--> watching（记 lastScanAt，不是失败）
 */
export async function advanceRunOnce(
  deps: { repos: AgentRepos; now: () => string; config?: AgentConfig; tick?: TickContext },
  runId: string,
  actor: 'user' | 'agent',
): Promise<AdvanceOutcome> {
  const { repos } = deps;
  const cfg = deps.config ?? {
    candidateLimit: AGENT_DEFAULTS.candidateLimit,
    scanPoolLimit: AGENT_DEFAULTS.scanPoolLimit,
    poolStaleDays: AGENT_DEFAULTS.poolStaleDays,
    tickMaxRuns: AGENT_DEFAULTS.tickMaxRuns,
    submitStaleHours: AGENT_DEFAULTS.submitStaleHours,
    recommendStaleMinutes: AGENT_DEFAULTS.recommendStaleMinutes,
    jdLlmBudgetMs: AGENT_DEFAULTS.jdLlmBudgetMs,
    tickDeadlineMs: AGENT_DEFAULTS.tickDeadlineMs,
  };
  const nowIso = deps.now();

  let run = await repos.jobRuns.getById(runId);
  if (!run) {
    return { ok: false, status: 404, code: AGENT_ERROR_CODES.runNotFound, message: 'job run not found' };
  }

  // 1) created → configured（偏好/画像的存在性就是校验；真正的合法性在写入时就查过）
  if (run.status === 'created') {
    run = (await applyRunEvent(repos, run, 'validate', actor, nowIso)) ?? (await repos.jobRuns.getById(runId));
  }
  // 2) configured → watching
  if (run?.status === 'configured') {
    run = (await applyRunEvent(repos, run, 'start', actor, nowIso)) ?? (await repos.jobRuns.getById(runId));
  }
  if (!run) {
    return { ok: false, status: 404, code: AGENT_ERROR_CODES.runNotFound, message: 'job run not found' };
  }
  const plan = planTransition(run.status, 'candidates_ready');
  if (!plan.ok) {
    // 终态、或正处于 awaiting_approval/tracking：不是错误，返回当前视图由调用方展示
    const view = await loadRunView(repos, run);
    return { ok: true, view };
  }

  const preference = await repos.jobPreferences.getById(run.preferenceId);
  if (!preference) {
    const failed = (await failRun(repos, run, 'preference_not_found', actor, nowIso)) ?? run;
    return {
      ok: false,
      status: 409,
      code: AGENT_ERROR_CODES.preferenceNotFound,
      message: `preference ${run.preferenceId} no longer exists (run marked failed)`,
    };
  }
  const profileRow = await repos.profiles.getById(run.profileId);
  const profile = profileRow?.snapshot as AbilityProfile | null | undefined;
  if (!profile) {
    await failRun(repos, run, 'profile_snapshot_missing', actor, nowIso);
    return {
      ok: false,
      status: 409,
      code: AGENT_ERROR_CODES.profileNotOwned,
      message: `profile ${run.profileId} has no snapshot (run marked failed)`,
    };
  }

  return scanOnce(repos, cfg, run, preference, profile, nowIso, deps.tick);
}

/** 一轮扫描里的候选形状：matchJobs 的输出 + 它打分的岗位池行。 */
export type RunCandidate = { match: JobMatch<StoredJobPosting>; posting: StoredJobPosting };

/** 一轮扫描的候选推导结果：过闸的、被闸挡下的（带原因码）与两个计数。 */
export interface DerivedCandidates {
  /** 岗位池行数（新鲜窗口内还被源站列着的 active 行） */
  poolSize: number;
  /** 过完偏好硬过滤且有命中（score>0）的条数 */
  matchedCount: number;
  profileSkills: string[];
  selected: RunCandidate[];
  /**
   * 被质量闸挡下的条目，按与 `selected` 同一把尺排序（白名单公司 → 分数 → 发布时间），
   * 所以用户看到的是"差多少"的顺序，而不是一串乱序噪声。
   * 已出票据/已投递的岗位不在这里——那是去重，不是闸的判断。
   */
  excluded: ExcludedCandidate<RunCandidate>[];
  minTier: MatchScoreTier;
  candidateLimit: number;
}

/**
 * 推导一轮的候选与被挡清单（纯读：不写票据、不推进状态）。
 *
 * `scanOnce` 与 `GET /agent/runs/:id/gate-exclusions` 共用这一份实现是刻意的：
 * 质量闸"实际怎么筛"和"对界面怎么说自己怎么筛"必须是同一段代码，
 * 否则界面会开始讲一个内核没做的事——那种漂移只能靠人肉发现。
 */
export async function deriveRunCandidates(
  repos: AgentRepos,
  cfg: AgentConfig,
  run: StoredJobRun,
  preference: StoredJobPreference,
  profile: AbilityProfile,
  nowIso: string,
  tick?: TickContext,
): Promise<DerivedCandidates> {
  const profileSkills = profile.skillTags.map((tag) => tag.name);

  // 岗位池：只取 active 且**新鲜窗口内还被源站列着**的行，按发布时间倒序；
  // 偏好过滤是硬过滤（宁可少推，不推错的）。已关闭的岗位不能变成"待投"票据——
  // 用户照着它写一封求职信却发现岗位早没了，是真实伤害。窗口与 stats 同旋钮（JOB_STALE_DAYS）。
  // tick 路径整轮只查一次、跨 run 复用同一快照；手动路径（无 tick）照常自查。
  const pool =
    tick?.pool ??
    (await repos.jobPostings.search({
      status: 'active',
      seenAfter: staleCutoffIso(cfg.poolStaleDays, new Date(nowIso)),
      limit: cfg.scanPoolLimit,
      orderBy: 'posted_desc',
    }));
  const filtered = filterPostingsForPreference(pool as StoredJobPosting[], preference);
  const criteria = preferenceToMatchCriteria(preference, profileSkills);
  const matches: Array<JobMatch<StoredJobPosting>> = matchJobs(filtered, criteria);

  // 已有票据（任何状态）+ 已投递/已保存的岗位都不再重复推
  const existingIntents = await repos.submitIntents.listByRun(run.id, 500);
  const excludeJobIds = await appliedJobIds(repos, run.profileId);
  for (const intent of existingIntents) excludeJobIds.add(intent.jobId);

  const selection = selectCandidatesWithReasonsForPreference<RunCandidate>(
    matches.map((match) => ({ match, posting: match.posting })),
    {
      minTier: preference.minTier,
      limit: cfg.candidateLimit,
      excludeJobIds,
      preferredCompanyTerms: preference.companyWhitelist,
    },
  );

  return {
    poolSize: pool.length,
    matchedCount: matches.length,
    profileSkills,
    selected: selection.selected,
    excluded: selection.excluded,
    minTier: preference.minTier,
    candidateLimit: cfg.candidateLimit,
  };
}

export type GateOverrideOutcome =
  | { ok: true; view: AgentRunViewData; intentId: string }
  | { ok: false; status: 404 | 409; code: string; message: string };

/**
 * 用户显式放行一条被质量闸挡下的岗位（阶段 2「人机闸」的另一半：闸可以越，人不能省）。
 *
 * 越过的**只有质量闸**：
 *  - 写出来的仍是 `pending` 票据——确认动作（approve）与它背后的当日限频一道都不能少，
 *    否则"放行"就成了绕过防海投闸的后门；
 *  - 票据内容与 tick 出的票走同一装配路径（`planIntents` + 工件试装），装配不出
 *    简历/求职信的岗位照样拒绝——放行不该产出用户点开就失败的票据；
 *  - 状态迁移与审计同事务（`publishGeneratedIntents` 的 CAS），并发的 tick 与放行
 *    只有一个赢家，输了的一方零票据、零事件。
 *
 * 岗位必须在**本次推导**的挡下清单里（按岗位池行主键 `postingId` 认身份）：
 * 已出票、已被偏好硬过滤、或池行已下架的岗位都不是"被闸挡下"，一律 409 而不是悄悄新建。
 */
export async function overrideGateCandidate(
  deps: { repos: AgentRepos; now: () => string; config: AgentConfig },
  runId: string,
  postingId: string,
): Promise<GateOverrideOutcome> {
  const { repos, config: cfg } = deps;
  const nowIso = deps.now();

  const run = await repos.jobRuns.getById(runId);
  if (!run) {
    return { ok: false, status: 404, code: AGENT_ERROR_CODES.runNotFound, message: 'job run not found' };
  }
  const plan = planTransition(run.status, 'gate_override');
  if (!plan.ok) {
    return {
      ok: false,
      status: 409,
      code: AGENT_ERROR_CODES.invalidTransition,
      message: `job run in ${run.status} cannot accept a gate override`,
    };
  }

  const preference = await repos.jobPreferences.getById(run.preferenceId);
  if (!preference) {
    return {
      ok: false,
      status: 409,
      code: AGENT_ERROR_CODES.preferenceNotFound,
      message: `preference ${run.preferenceId} no longer exists`,
    };
  }
  const profileRow = await repos.profiles.getById(run.profileId);
  const profile = profileRow?.snapshot as AbilityProfile | undefined;
  if (!profile) {
    return {
      ok: false,
      status: 409,
      code: AGENT_ERROR_CODES.profileNotOwned,
      message: `profile ${run.profileId} has no snapshot`,
    };
  }

  const derivation = await deriveRunCandidates(repos, cfg, run, preference, profile, nowIso);
  const blocked = derivation.excluded.find((entry) => entry.item.posting.id === postingId);
  if (!blocked) {
    return {
      ok: false,
      status: 409,
      code: AGENT_ERROR_CODES.gateExclusionNotFound,
      message: `posting ${postingId} is not on this run's blocked list`,
    };
  }

  const planned = planIntents([blocked.item], { profileSkills: derivation.profileSkills })[0];
  if (!planned) {
    return { ok: false, status: 409, code: AGENT_ERROR_CODES.artifactsUnavailable, message: 'candidate vanished' };
  }

  // 与 scanOnce 的「generated」闸同一道校验：真装配一遍，装不出来就不写票据
  const evidence = toEvidenceItems(await repos.evidence.listByProfile(run.profileId));
  try {
    const match = resumeMatchFromReport(planned.report);
    buildResume({ profile, evidence, posting: blocked.item.posting, match, options: { locale: 'zh-CN' } });
    buildCoverLetter({ profile, evidence, posting: blocked.item.posting, match, options: { locale: 'zh-CN' } });
  } catch (err) {
    return {
      ok: false,
      status: 409,
      code: AGENT_ERROR_CODES.artifactsUnavailable,
      message: `artifacts cannot be assembled for posting ${postingId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  const intentId = `intent-${randomUUID()}`;
  const gated = await repos.jobRuns.publishGeneratedIntents(
    run.id,
    run.status,
    { status: plan.to, updatedAt: nowIso },
    {
      id: `evt-${randomUUID()}`,
      runId: run.id,
      event: plan.event,
      fromStatus: plan.from,
      toStatus: plan.to,
      // 放行是人的动作，审计流里必须与 agent/tick 的迁移分得开
      actor: 'user',
      payload: {
        intentId,
        postingId,
        jobId: blocked.item.posting.jobId,
        source: blocked.item.posting.source,
        matchScore: planned.matchScore,
        matchTier: planned.matchTier,
        // 挡下它的两个口径一起留档：事后才能回答"当初为什么没推"
        minTier: derivation.minTier,
        blockedBy: blocked.reason,
      },
      createdAt: nowIso,
    },
    [
      {
        id: intentId,
        runId: run.id,
        accountId: run.accountId,
        profileId: run.profileId,
        jobId: planned.job.jobId,
        jobSource: planned.job.source,
        job: planned.job,
        matchScore: planned.matchScore,
        matchTier: planned.matchTier,
        report: planned.report,
        status: 'pending',
        createdAt: nowIso,
        updatedAt: nowIso,
      },
    ],
  );
  if (!gated) {
    // 并发输家（tick 抢先推进了状态）：不写票据、不写事件，让调用方重读视图再试
    return {
      ok: false,
      status: 409,
      code: AGENT_ERROR_CODES.invalidTransition,
      message: 'job run changed underneath this override',
    };
  }

  return { ok: true, view: await loadRunView(repos, gated), intentId };
}

async function scanOnce(
  repos: AgentRepos,
  cfg: AgentConfig,
  run: StoredJobRun,
  preference: StoredJobPreference,
  profile: AbilityProfile,
  nowIso: string,
  tick?: TickContext,
): Promise<AdvanceOutcome> {
  const derivation = await deriveRunCandidates(
    repos,
    cfg,
    run,
    preference,
    profile,
    nowIso,
    tick,
  );
  const selected = derivation.selected;
  const profileSkills = derivation.profileSkills;

  const planned = planIntents(selected, { profileSkills });

  const evidence = toEvidenceItems(await repos.evidence.listByProfile(run.profileId));

  // 「generated」闸：真的把工件装配一遍（no-fabrication / Schema.parse 出口校验都在里面），
  // 装配不出来的候选不写进票据——避免用户点开才发现简历生成失败。
  const ready: typeof planned = [];
  let skipped = 0;
  for (const item of planned) {
    try {
      const posting = selected.find((c) => c.posting.jobId === item.job.jobId)?.posting;
      if (!posting) throw new Error('candidate posting vanished');
      const match = resumeMatchFromReport(item.report);
      buildResume({ profile, evidence, posting, match, options: { locale: 'zh-CN' } });
      buildCoverLetter({ profile, evidence, posting, match, options: { locale: 'zh-CN' } });
      ready.push(item);
    } catch {
      skipped += 1;
    }
  }

  const stats: AgentScanStats = {
    poolSize: derivation.poolSize,
    matchedCount: derivation.matchedCount,
    candidateCount: ready.length,
    excludedCount: derivation.matchedCount - selected.length,
    skippedCount: skipped,
  };

  if (ready.length === 0) {
    // 本轮没扫到合格岗位：留在 watching 等下一轮（不是失败，也不是"看似成功"）
    const updated =
      (await applyRunEvent(repos, run, 'rescan', 'agent', nowIso, { lastScanAt: nowIso, lastError: null })) ?? run;
    const view = await loadRunView(repos, updated);
    return { ok: true, view, scan: stats };
  }

  // 原子占位：抢到 watching → recommending 的那个 tick 才写票据
  const recommending = await applyRunEvent(repos, run, 'candidates_ready', 'agent', nowIso, {
    lastScanAt: nowIso,
    lastError: null,
  });
  if (!recommending) {
    const current = (await repos.jobRuns.getById(run.id)) ?? run;
    const view = await loadRunView(repos, current);
    return { ok: true, view, scan: stats };
  }

  // C1 语义增强（阶段 3，设计 §3.2/§10 C1）放在 CAS 占位成功**之后**：只有抢到
  // watching → recommending 的那个 run 才花 LLM，输家直接返回、零 LLM 花费。
  // LLM 从 JD 正文提取岗位侧要求，再由纯函数合并进报告，不打分、不造画像事实；
  // 任何失败/返回 null 都 fail-closed 保留纯规则报告。双预算约束：本阶段墙钟
  // jdLlmBudgetMs 与整轮 tick 共享截止时刻，每条调用前都检查，预算耗尽后剩余候选
  // 保持纯规则、票据照常写出（单次在途调用另有 LLM_TIMEOUT_MS，最坏超支 ≤ 一次调用）。
  if (cfg.jdExtractor) {
    const enrichStartedAt = Date.now();
    for (const item of ready) {
      if (Date.now() - enrichStartedAt >= cfg.jdLlmBudgetMs) break;
      if (tick?.deadlineAt !== undefined && Date.now() >= tick.deadlineAt) break;
      const posting = selected.find((c) => c.posting.jobId === item.job.jobId)?.posting;
      const description = posting?.description;
      if (!description) continue;
      try {
        const insight = await cfg.jdExtractor(item.job.title, description);
        if (insight) {
          item.report = enhanceMatchReportWithJd(item.report, insight, profileSkills);
        }
      } catch {
        // LLM 超时/HTTP/校验失败：保持纯规则报告，不影响票据写入。
      }
    }
  }

  // 三表原子收尾：recommending → awaiting_approval 的 CAS 闸 + 票据批量 + generated 事件
  // 同一事务提交。CAS 输家（如滞留已被 tick 回收回 watching）零票据、零事件，
  // 不会留下「run 已回 watching、孤儿票据却永不再生成」的中间态。
  const createdAt = nowIso;
  const intents = ready.map((item) => ({
    id: `intent-${randomUUID()}`,
    runId: run.id,
    accountId: run.accountId,
    profileId: run.profileId,
    jobId: item.job.jobId,
    jobSource: item.job.source,
    job: item.job,
    matchScore: item.matchScore,
    matchTier: item.matchTier,
    report: item.report,
    status: 'pending' as const,
    createdAt,
    updatedAt: createdAt,
  }));
  const plan = planTransition(recommending.status, 'generated');
  // plan 在状态机上必然成立（recommending 刚由 candidates_ready 迁来），不成立则按输家回落
  const gated = plan.ok
    ? await repos.jobRuns.publishGeneratedIntents(
        recommending.id,
        recommending.status,
        { status: plan.to, updatedAt: nowIso },
        {
          id: `evt-${randomUUID()}`,
          runId: recommending.id,
          event: plan.event,
          fromStatus: plan.from,
          toStatus: plan.to,
          actor: 'agent',
          payload: {},
          createdAt: nowIso,
        },
        intents,
      )
    : undefined;
  if (!gated) {
    const current = (await repos.jobRuns.getById(run.id)) ?? recommending;
    const view = await loadRunView(repos, current);
    return { ok: true, view, scan: stats };
  }
  const view = await loadRunView(repos, gated);
  return { ok: true, view, scan: stats };
}

/** cron tick：推进至多 maxRuns 个扫描态任务，并回收超时未回执的 submitting 任务（阶段 2，§10.4 A4）。 */
export async function runAgentTickOnce(deps: {
  repos: AgentRepos;
  now: () => string;
  config?: AgentConfig;
}): Promise<{
  advanced: number;
  recycled: number;
  idle: boolean;
  results: Array<{ runId: string; status: string; intents: number }>;
}> {
  const cfg = deps.config ?? {
    candidateLimit: AGENT_DEFAULTS.candidateLimit,
    scanPoolLimit: AGENT_DEFAULTS.scanPoolLimit,
    poolStaleDays: AGENT_DEFAULTS.poolStaleDays,
    tickMaxRuns: AGENT_DEFAULTS.tickMaxRuns,
    submitStaleHours: AGENT_DEFAULTS.submitStaleHours,
    recommendStaleMinutes: AGENT_DEFAULTS.recommendStaleMinutes,
    jdLlmBudgetMs: AGENT_DEFAULTS.jdLlmBudgetMs,
    tickDeadlineMs: AGENT_DEFAULTS.tickDeadlineMs,
  };
  // 整轮 tick 共享墙钟截止时刻：串行推进多个 run 时，每接一个新 run 前检查，
  // 超时即停止接新 run（已在跑的 run 不打断）；必须小于 cron-worker 60s fetch 超时。
  const deadlineAt = Date.now() + cfg.tickDeadlineMs;
  // 超时回收：submitting 超过 submitStaleHours 无回执 → fail（显式原因 submit_timeout，
  // 不静默悬空；用户要重试就新建任务）。取 200 条足够覆盖正常规模，无需新仓储方法。
  const nowIso = deps.now();
  let recycled = 0;
  const submitting = await deps.repos.jobRuns.listByStatuses(['submitting'], 200);
  for (const run of submitting) {
    const ageHours = (Date.parse(nowIso) - Date.parse(run.updatedAt)) / 3_600_000;
    if (ageHours >= cfg.submitStaleHours) {
      const failed = await applyRunEvent(deps.repos, run, 'fail', 'system', nowIso, {
        lastError: 'submit_timeout',
      });
      if (failed) recycled += 1;
    }
  }
  // 滞留回收：recommending 占位（写票据前的状态）超过 recommendStaleMinutes 仍未推进
  // ——占位进程在 generated 之前被杀（如 serverless 超时）。走状态机既有的
  // recommending --rescan--> watching 出边回到扫描态，下一轮即可重新产出；
  // 阈值远大于单轮扫描耗时，不会回收正在进行中的扫描。
  const recommending = await deps.repos.jobRuns.listByStatuses(['recommending'], 200);
  for (const run of recommending) {
    const ageMinutes = (Date.parse(nowIso) - Date.parse(run.updatedAt)) / 60_000;
    if (ageMinutes >= cfg.recommendStaleMinutes) {
      const recovered = await applyRunEvent(deps.repos, run, 'rescan', 'system', nowIso, {
        lastError: 'recommend_stale_recovered',
      });
      if (recovered) recycled += 1;
    }
  }
  const runs = await deps.repos.jobRuns.listByStatuses(
    ['created', 'configured', 'watching', 'recommending'],
    cfg.tickMaxRuns,
  );
  // 岗位池整轮只查一次：同一 tick 内所有 run 复用同一快照（active 池在 5 分钟
  // tick 尺度内近似不变；每个 run 仍各自做偏好过滤/匹配/排重）。无待推进 run 时不查。
  const pool =
    runs.length > 0
      ? await deps.repos.jobPostings.search({
          status: 'active',
          seenAfter: staleCutoffIso(cfg.poolStaleDays, new Date(nowIso)),
          limit: cfg.scanPoolLimit,
          orderBy: 'posted_desc',
        })
      : [];
  const tick: TickContext = { deadlineAt, pool };
  const results: Array<{ runId: string; status: string; intents: number }> = [];
  for (const run of runs) {
    // 到达整轮截止时刻即停止接新 run；已经在跑的 run 不打断（下一个 tick 会回收/续推）
    if (Date.now() >= deadlineAt) break;
    const outcome = await advanceRunOnce({ ...deps, config: cfg, tick }, run.id, 'agent');
    if (outcome.ok) {
      results.push({
        runId: outcome.view.run.id,
        status: outcome.view.run.status,
        intents: outcome.view.intents.length,
      });
    } else {
      results.push({ runId: run.id, status: 'error', intents: 0 });
    }
  }
  return { advanced: results.length, recycled, idle: results.length === 0 && recycled === 0, results };
}
