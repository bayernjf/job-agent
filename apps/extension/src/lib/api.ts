/**
 * 扩展侧 API 客户端：复用公开 API（docs/API.md）拿可信画像。
 *
 * 流程（单源 github/gitee）：GET /profiles/by-subject/:platform/:login 解析已有 complete 快照
 *   （公开只读、无 TTL、不扣配额、匿名可用）→ 命中直接 GET /profiles/:id/exportable；
 *   未命中（404）才 POST /analyze 触发新分析 → 轮询 GET /jobs/:id → succeeded 后 exportable。
 * platform=all 无单一主体快照，直接 POST /analyze。
 *
 * 只读：仅调分析/查询接口，不写任何数据（决策 #15 边界：不存密码、不做后台投递）。
 */

import { parseExportableProfile } from '@jobagent/shared';
import type { ExportableProfile } from '@jobagent/shared';

export interface ApiClientOptions {
  /** API base，默认构建期注入（build.mjs 的 EXTENSION_API_BASE） */
  baseUrl: string;
  /** 轮询间隔（测试可注入小值） */
  pollMs?: number;
  /** 轮询总超时（默认 60s） */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** 扩展登录态（决策 #22）：返回长期 Bearer token；未登录返回 null（匿名调用） */
  tokenProvider?: () => Promise<string | null>;
}

const DEFAULT_BASE = typeof EXTENSION_API_BASE === 'string' ? EXTENSION_API_BASE : 'http://localhost:3000';

/**
 * 扩展可选的分析平台（与在线 API POST /analyze 的 platform 枚举对齐）：
 * github/gitee 单源，all = GitHub+Gitee 双源融合（后端镜像去重，Gitee 404 正常降级）。
 * all 不进 shared PlatformSchema（契约层平台仍是 github|gitee），仅作请求参数。
 */
export type AnalyzePlatform = 'github' | 'gitee' | 'all';

export interface AnalyzeError extends Error {
  status: number | undefined;
  details: unknown | undefined;
}

export function apiError(message: string, status?: number, details?: unknown): AnalyzeError {
  const err = new Error(message) as AnalyzeError;
  err.status = status;
  err.details = details;
  return err;
}


/** 待填充票据（与后端 GET /agent/extension/pending-fills 单条同形，shared ExtensionPendingFillSchema）。 */
export interface PendingFill {
  intentId: string;
  runId: string;
  profileId: string;
  job: {
    source: string;
    sourceUrl: string;
    applyUrl?: string | null;
    title: string;
    company?: string | null;
    postingId?: string;
    [k: string]: unknown;
  };
  matchScore: number;
  matchTier: string;
  approvedAt: string;
}

/** GET /agent/intents/:id/cover-letter?format=json&polish=llm 的 JSON 响应。
 * 无 LLM 时后端 fail-closed 回落规则版：polished=false、body 为规则 markdown。 */
export interface IntentCoverLetterJson {
  draft: unknown;
  body: string;
  subject: string | null;
  polished: boolean;
  fallbackReason?: string;
  provenance?: { source: string; provider: string; model: string; promptVersion: string };
  fromSnapshot: boolean;
}

export type IntentOutcome = 'no_response' | 'interview' | 'offer' | 'rejected';

export class JobAgentApi {
  constructor(private readonly opts: ApiClientOptions) {}

  /** 鉴权头：tokenProvider 提供明文 token 时附加 Authorization（仅 tkn- 前缀），否则空对象。 */
  private async authHeaders(): Promise<Record<string, string>> {
    const token = await this.opts.tokenProvider?.();
    if (token) return { authorization: `Bearer ${token}` };
    return {};
  }


  /** 按 profileId 直接取可填充画像（exportable 快照，不触发分析）。 */
  async getExportableProfile(profileId: string): Promise<ExportableProfile> {
    const { baseUrl } = this.opts;
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    return this.getProfile(fetchImpl, baseUrl, profileId);
  }

  // ── 阶段 2 A2：求职 Agent 半自动投递（全部需要登录态，走 Bearer token）──

  /** 拉取本人跨 run 的已确认待填充票据（approved SubmitIntent）。 */
  async listPendingFills(): Promise<PendingFill[]> {
    const { baseUrl } = this.opts;
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const res = await fetchImpl(`${baseUrl}/agent/extension/pending-fills`, {
      headers: await this.authHeaders(),
    });
    if (!res.ok) throw apiError(`pending fills failed (HTTP ${res.status})`, res.status);
    const body = (await res.json().catch(() => ({}))) as { fills?: unknown };
    return Array.isArray(body.fills) ? (body.fills as PendingFill[]) : [];
  }

  /**
   * 取某票据的岗位定向求职信（JSON）。默认 polish=llm：有 LLM 走润色版，
   * 无 key/失败时后端回落规则版 markdown（polished=false），调用方无需分支。
   */
  async getIntentCoverLetter(
    intentId: string,
    locale: 'zh-CN' | 'en' = 'zh-CN',
  ): Promise<IntentCoverLetterJson> {
    const { baseUrl } = this.opts;
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const qs = `format=json&polish=llm&locale=${encodeURIComponent(locale)}`;
    const res = await fetchImpl(
      `${baseUrl}/agent/intents/${encodeURIComponent(intentId)}/cover-letter?${qs}`,
      { headers: await this.authHeaders() },
    );
    if (!res.ok) throw apiError(`cover letter failed (HTTP ${res.status})`, res.status);
    return (await res.json()) as IntentCoverLetterJson;
  }

  /** 用户在 ATS 提交后回执：票据转 submitted、写 origin=agent 投递记录（幂等）。 */
  async markIntentSubmitted(intentId: string): Promise<{ applicationId: string | null }> {
    const { baseUrl } = this.opts;
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const res = await fetchImpl(
      `${baseUrl}/agent/intents/${encodeURIComponent(intentId)}/mark-submitted`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(await this.authHeaders()) },
      },
    );
    const body = (await res.json().catch(() => ({}))) as { applicationId?: string | null };
    if (!res.ok) throw apiError(`mark-submitted failed (HTTP ${res.status})`, res.status, body);
    return { applicationId: body.applicationId ?? null };
  }

  /** 投递结果回写（D1）：仅 submitted 票据可写，非法状态后端返回 409。 */
  async recordIntentOutcome(
    intentId: string,
    outcome: IntentOutcome,
    note?: string,
  ): Promise<void> {
    const { baseUrl } = this.opts;
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const res = await fetchImpl(`${baseUrl}/agent/intents/${encodeURIComponent(intentId)}/outcome`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await this.authHeaders()) },
      body: JSON.stringify({ outcome, ...(note ? { note } : {}) }),
    });
    if (!res.ok) throw apiError(`outcome write-back failed (HTTP ${res.status})`, res.status);
  }

  /**
   * 输入用户名（可选平台），返回可信画像（ExportableProfile）。
   * 单源（github/gitee）先公开只读解析已有 complete 快照（无 TTL、不扣配额、匿名可用）：
   * 画像快照永久可分享，"加载已有画像来一键填充"不应被 POST /analyze 的 24h 缓存 TTL 与演示闸挡住；
   * 只有确实没有快照时才触发新分析（受演示模式配额约束）。platform=all 无单一主体快照，直接走分析。
   * 未生成完的画像会轮询等待；校验失败/分析失败/超时抛错。
   */
  async fetchProfile(username: string, platform: AnalyzePlatform = 'github'): Promise<ExportableProfile> {
    const { baseUrl, pollMs = 2000, timeoutMs = 60_000 } = this.opts;
    const fetchImpl = this.opts.fetchImpl ?? fetch;

    let profileId: string | undefined;
    if (platform === 'github' || platform === 'gitee') {
      profileId = await this.resolveBySubject(fetchImpl, baseUrl, username, platform);
    }

    if (!profileId) {
      const created = await this.postAnalyze(fetchImpl, baseUrl, username, platform);
      profileId = created.profileId;

      if (!profileId) {
        const deadline = Date.now() + timeoutMs;
        while (!profileId && Date.now() < deadline) {
          await sleep(pollMs);
          const job = await this.getJob(fetchImpl, baseUrl, created.jobId!);
          if (job.status === 'succeeded') profileId = job.profileId;
          else if (job.status === 'failed') throw apiError(`analysis failed: ${job.error ?? 'unknown error'}`);
          // queued/running → 继续轮询
        }
        if (!profileId) throw apiError('analysis timed out; please retry later');
      }
    }

    const profile = await this.getProfile(fetchImpl, baseUrl, profileId);
    return profile;
  }

  /**
   * 公开只读解析某主体最新 complete 快照，返回 profileId；无快照（404）返回 undefined，
   * 由调用方回退到 POST /analyze。其他非 2xx（服务器/网络错误）直接抛错，不静默回退。
   */
  private async resolveBySubject(
    fetchImpl: typeof fetch,
    baseUrl: string,
    username: string,
    platform: 'github' | 'gitee',
  ): Promise<string | undefined> {
    const res = await fetchImpl(
      `${baseUrl}/profiles/by-subject/${platform}/${encodeURIComponent(username)}`,
      { headers: await this.authHeaders() },
    );
    if (res.status === 404) return undefined;
    if (!res.ok) throw apiError(`profile lookup failed (HTTP ${res.status})`, res.status);
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return typeof body.profileId === 'string' ? body.profileId : undefined;
  }

  private async postAnalyze(
    fetchImpl: typeof fetch,
    baseUrl: string,
    username: string,
    platform: AnalyzePlatform = 'github',
  ): Promise<{ jobId: string | undefined; profileId: string | undefined }> {
    const res = await fetchImpl(`${baseUrl}/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await this.authHeaders()) },
      body: JSON.stringify({ username, platform }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw apiError(`analyze failed (HTTP ${res.status})`, res.status, body);
    }
    return {
      jobId: typeof body.jobId === 'string' ? body.jobId : undefined,
      profileId: typeof body.profileId === 'string' ? body.profileId : undefined,
    };
  }

  private async getJob(
    fetchImpl: typeof fetch,
    baseUrl: string,
    jobId: string,
  ): Promise<{ status: string; profileId: string | undefined; error: string | undefined }> {
    const res = await fetchImpl(`${baseUrl}/jobs/${encodeURIComponent(jobId)}`, {
      headers: await this.authHeaders(),
    });
    if (!res.ok) throw apiError(`job lookup failed (HTTP ${res.status})`, res.status);
    const body = (await res.json()) as Record<string, unknown>;
    return {
      status: String(body.status ?? ''),
      profileId: typeof body.profileId === 'string' ? body.profileId : undefined,
      error: typeof body.error === 'string' ? body.error : undefined,
    };
  }

  private async getProfile(fetchImpl: typeof fetch, baseUrl: string, profileId: string): Promise<ExportableProfile> {
    const res = await fetchImpl(`${baseUrl}/profiles/${encodeURIComponent(profileId)}/exportable`, {
      headers: await this.authHeaders(),
    });
    if (!res.ok) throw apiError(`profile lookup failed (HTTP ${res.status})`, res.status);
    const body = await res.json();
    const parsed = parseExportableProfile(body);
    if (!parsed) throw apiError('profile payload does not match the exportable schema');
    return parsed;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { DEFAULT_BASE };

/** 分数在岗位标题/标签/正文上的分解（三项合计=score，决策 #10）。 */
export interface JobMatchFieldScores {
  title: number;
  tags: number;
  description: number;
}

/** 单个画像技能在岗位上的字段级命中。 */
export interface JobMatchSkillHit {
  skill: string;
  score: number;
  fields: Array<'title' | 'tags' | 'description'>;
}

/** 命中技能的推荐理由：匹配贡献 + 画像元数据与证据指针（仅 profileId 匹配时返回）。 */
export interface JobMatchSkillReason extends JobMatchSkillHit {
  kind: 'language' | 'framework' | 'domain';
  depth: 'used' | 'proficient';
  confidence: number;
  evidenceRefs: string[];
}

/** 精简证据字典项：只带前端可回溯所需，不搬运整行存储字段（与 API match-explain 对齐）。 */
export interface EvidenceBrief {
  sourceType: string;
  url: string;
  claim: string;
  occurredAt?: string;
  layer?: string;
}

/** 岗位匹配结果（POST /job-postings/match 返回的单条） */
export interface JobMatchItem {
  score: number;
  matchedSkills: string[];
  /** 可解释性字段（决策 #10）：旧后端可能缺，故全部可选以便健壮降级 */
  fieldScores?: JobMatchFieldScores;
  skillHits?: JobMatchSkillHit[];
  skillReasons?: JobMatchSkillReason[];
  posting: {
    /** 岗位内部主键（job_postings.id），用于构造简历生成深链 ?resumeJob=<id> */
    id?: string;
    title: string;
    company: string;
    location?: string | null;
    remote?: boolean;
    sourceUrl: string;
    postedAt?: string;
    source?: string;
  };
}

/** POST /job-postings/match 响应：matches 在列表，evidence 在顶层（profileId 匹配时）。 */
export interface JobMatchResponse {
  matches: JobMatchItem[];
  total?: number;
  profileSkills?: string[];
  /** 顶层去重证据字典，key = evidenceRef（仅 profileId 匹配时返回） */
  evidence?: Record<string, EvidenceBrief>;
}

/**
 * 用画像 profileId 调 POST /job-postings/match，返回按匹配分排序的岗位 + 顶层证据字典。
 * evidence 在 API 响应顶层（不在每个 item 内），面板展示证据外链时从这里取。
 */
export async function matchJobs(
  baseUrl: string,
  profileId: string,
  opts: { limit?: number; fetchImpl?: typeof fetch } = {},
): Promise<JobMatchResponse> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(`${baseUrl}/job-postings/match`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ profileId, limit: opts.limit ?? 5 }),
  });
  if (!res.ok) throw apiError(`job match failed (HTTP ${res.status})`, res.status);
  const body = (await res.json()) as Partial<JobMatchResponse>;
  const evidence = body.evidence && typeof body.evidence === 'object' ? body.evidence : undefined;
  return {
    matches: Array.isArray(body.matches) ? body.matches : [],
    ...(body.total !== undefined ? { total: body.total } : {}),
    ...(body.profileSkills !== undefined ? { profileSkills: body.profileSkills } : {}),
    ...(evidence !== undefined ? { evidence } : {}),
  };
}
