import { randomUUID } from 'node:crypto';
import { matchJobs, type JobMatch } from '@jobagent/job-source';
import {
  filterPostingsForPreference,
  planIntents,
  planTransition,
  preferenceToMatchCriteria,
  selectCandidatesForPreference,
  type CandidateLike,
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

export interface AgentScanStats {
  poolSize: number;
  /** 通过偏好硬过滤 + 匹配（score>0）的候选数 */
  matchedCount: number;
  /** 过质量闸并成功装配工件的候选数 */
  candidateCount: number;
  /** 因已出票据/已投递被排除的条数 */
  excludedCount: number;
  /** 装配工件失败被跳过的条数（显式记录，不静默） */
  skippedCount: number;
}

export interface AgentRunViewData {
  run: StoredJobRun;
  events: StoredJobRunEvent[];
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
  const [events, intents] = await Promise.all([
    repos.jobRunEvents.listByRun(run.id),
    repos.submitIntents.listByRun(run.id),
  ]);
  return { run, events, intents };
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
  // 先占位再写事件：CAS 失败说明别人已经推进过，此时不落事件（审计日志不出现幻影迁移）
  const updated = await repos.jobRuns.compareAndSetStatus(run.id, run.status, {
    status: plan.to,
    ...patch,
    updatedAt: nowIso,
  });
  if (!updated) return undefined;
  await repos.jobRunEvents.insert({
    id: `evt-${randomUUID()}`,
    runId: run.id,
    event: plan.event,
    fromStatus: plan.from,
    toStatus: plan.to,
    actor,
    payload: eventPayload(patch),
    createdAt: nowIso,
  });
  return updated;
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
  return { resume, coverLetter, fromSnapshot };
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
  deps: { repos: AgentRepos; now: () => string; config?: AgentConfig },
  runId: string,
  actor: 'user' | 'agent',
): Promise<AdvanceOutcome> {
  const { repos } = deps;
  const cfg = deps.config ?? {
    candidateLimit: AGENT_DEFAULTS.candidateLimit,
    scanPoolLimit: AGENT_DEFAULTS.scanPoolLimit,
    tickMaxRuns: AGENT_DEFAULTS.tickMaxRuns,
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

  return scanOnce(repos, cfg, run, preference, profile, nowIso);
}

async function scanOnce(
  repos: AgentRepos,
  cfg: AgentConfig,
  run: StoredJobRun,
  preference: StoredJobPreference,
  profile: AbilityProfile,
  nowIso: string,
): Promise<AdvanceOutcome> {
  const profileSkills = profile.skillTags.map((tag) => tag.name);

  // 岗位池：只取 active，按发布时间倒序；偏好过滤是硬过滤（宁可少推，不推错的）
  const pool = await repos.jobPostings.search({
    status: 'active',
    limit: cfg.scanPoolLimit,
    orderBy: 'posted_desc',
  });
  const filtered = filterPostingsForPreference(pool as StoredJobPosting[], preference);
  const criteria = preferenceToMatchCriteria(preference, profileSkills);
  const matches: Array<JobMatch<StoredJobPosting>> = matchJobs(filtered, criteria);

  // 已有票据（任何状态）+ 已投递/已保存的岗位都不再重复推
  const existingIntents = await repos.submitIntents.listByRun(run.id, 500);
  const excludeJobIds = await appliedJobIds(repos, run.profileId);
  for (const intent of existingIntents) excludeJobIds.add(intent.jobId);

  const selected = selectCandidatesForPreference(
    matches.map((match) => ({ match, posting: match.posting }) satisfies CandidateLike),
    {
      minTier: preference.minTier,
      limit: cfg.candidateLimit,
      excludeJobIds,
      preferredCompanyTerms: preference.companyWhitelist,
    },
  );

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
    poolSize: pool.length,
    matchedCount: matches.length,
    candidateCount: ready.length,
    excludedCount: matches.length - selected.length,
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

  const createdAt = nowIso;
  await repos.submitIntents.insertMany(
    ready.map((item) => ({
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
    })),
  );

  const gated =
    (await applyRunEvent(repos, recommending, 'generated', 'agent', nowIso)) ?? recommending;
  const view = await loadRunView(repos, gated);
  return { ok: true, view, scan: stats };
}

/** cron tick：按状态推进至多 maxRuns 个任务（最久没扫的优先）。 */
export async function runAgentTickOnce(deps: {
  repos: AgentRepos;
  now: () => string;
  config?: AgentConfig;
}): Promise<{ advanced: number; idle: boolean; results: Array<{ runId: string; status: string; intents: number }> }> {
  const cfg = deps.config ?? {
    candidateLimit: AGENT_DEFAULTS.candidateLimit,
    scanPoolLimit: AGENT_DEFAULTS.scanPoolLimit,
    tickMaxRuns: AGENT_DEFAULTS.tickMaxRuns,
  };
  const runs = await deps.repos.jobRuns.listByStatuses(
    ['created', 'configured', 'watching', 'recommending'],
    cfg.tickMaxRuns,
  );
  const results: Array<{ runId: string; status: string; intents: number }> = [];
  for (const run of runs) {
    const outcome = await advanceRunOnce({ ...deps, config: cfg }, run.id, 'agent');
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
  return { advanced: results.length, idle: results.length === 0, results };
}
