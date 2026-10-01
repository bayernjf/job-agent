/**
 * MCP v0 只读工具面（决策 #19，2026-10-01 决策）。
 *
 * 硬原则（违反任一条都不该存在这个面，见 docs/design-mcp-surface-20260928.md §2）：
 *  1. 只做 @jobagent/api 的薄壳——进程内 createApp() + app.request() 自调，绝不 import storage 直读。
 *  2. 服务账号不是人：给密钥也不解锁证据外链 / 信号 detail / 面试题 / interview-kit。
 *  3. 只读，绝不触发分析：/analyze、/resumes/build、/demo/* 不进工具面，不扣 demo 配额。
 */
import { z } from 'zod';

/** MCP 工具统一错误形状（isError=true 时 content 里是给模型读的解释）。 */
export class McpToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'McpToolError';
  }
}

/**
 * 最小结构化依赖：只需要 Hono app 的 request()。
 * 用结构化类型而不是 import 'hono'，让 apps/mcp 不直接持有 web 框架依赖，
 * 也保证本面只能"发请求进 API"，拿不到 storage/仓储句柄。
 */
export interface ApiRequester {
  request(path: string, init?: RequestInit): Promise<Response>;
}

export interface ToolContext {
  app: ApiRequester;
}

async function apiJson<T = unknown>(app: ApiRequester, path: string, init?: RequestInit): Promise<T> {
  const res = await app.request(path, init);
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    const code =
      body && typeof body === 'object' && 'code' in body
        ? String((body as { code: unknown }).code)
        : `HTTP_${res.status}`;
    const message =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `upstream ${res.status}`;
    throw new McpToolError(code, message, res.status);
  }
  return body as T;
}

// ── 入参 zod raw shapes（直接喂给 McpServer.tool，它内部包 z.object）────
export const ProfileIdShape = {
  profileId: z.string().min(1),
} as const;

export const SubjectShape = {
  platform: z.enum(['github', 'gitee']),
  login: z.string().min(1).max(64),
} as const;

export const SearchJobsShape = {
  keyword: z.string().optional(),
  remote: z.boolean().optional(),
  sources: z.array(z.string()).optional(),
  company: z.string().optional(),
  salaryMinUsd: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().nonnegative().optional(),
} as const;

export const MatchShape = {
  profileId: z.string().min(1),
  remote: z.boolean().optional(),
  keyword: z.string().optional(),
  sources: z.array(z.string()).optional(),
  salaryMinUsd: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().nonnegative().optional(),
} as const;

// ── get_profile（映射 GET /profiles/:id/exportable）────────────────────
export interface GetProfileInput {
  profileId: string;
}
export async function getProfile(
  ctx: ToolContext,
  input: GetProfileInput,
): Promise<unknown> {
  const id = encodeURIComponent(input.profileId);
  return apiJson(ctx.app, `/profiles/${id}/exportable`);
}

// ── lookup_profile_by_subject ───────────────────────────────────────────
export interface LookupProfileInput {
  platform: 'github' | 'gitee';
  login: string;
}
export async function lookupProfileBySubject(
  ctx: ToolContext,
  input: LookupProfileInput,
): Promise<unknown> {
  // API 对非法 login 返回 400 { error }（无 code）；归一化成 INVALID_SUBJECT 便于调用方区分。
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(input.login)) {
    throw new McpToolError('INVALID_SUBJECT', 'login must start with an alphanumeric', 400);
  }
  const platform = encodeURIComponent(input.platform);
  const login = encodeURIComponent(input.login);
  return apiJson(ctx.app, `/profiles/by-subject/${platform}/${login}`);
}

// ── search_jobs（唯一不要求密钥的工具，岗位列表本就公开）────────────────
export interface SearchJobsInput {
  keyword?: string;
  remote?: boolean;
  sources?: string[];
  company?: string;
  salaryMinUsd?: number;
  limit?: number;
  offset?: number;
}
export async function searchJobs(ctx: ToolContext, input: SearchJobsInput): Promise<unknown> {
  const params = new URLSearchParams();
  if (input.keyword) params.set('keyword', input.keyword);
  if (input.remote !== undefined) params.set('remote', String(input.remote));
  if (input.sources && input.sources.length > 0) params.set('sources', input.sources.join(','));
  if (input.company) params.set('company', input.company);
  if (input.salaryMinUsd !== undefined) params.set('salary_min', String(input.salaryMinUsd));
  if (input.limit !== undefined) params.set('limit', String(input.limit));
  if (input.offset !== undefined) params.set('offset', String(input.offset));
  const qs = params.toString();
  return apiJson(ctx.app, `/job-postings${qs ? `?${qs}` : ''}`);
}

// ── match_profile_to_job（GET /profiles/:id/job-recommendations）────────
export interface MatchProfileInput {
  profileId: string;
  remote?: boolean;
  keyword?: string;
  sources?: string[];
  salaryMinUsd?: number;
  limit?: number;
  offset?: number;
}
export async function matchProfileToJob(
  ctx: ToolContext,
  input: MatchProfileInput,
): Promise<unknown> {
  const id = encodeURIComponent(input.profileId);
  const params = new URLSearchParams();
  if (input.remote !== undefined) params.set('remote', String(input.remote));
  if (input.keyword) params.set('keyword', input.keyword);
  if (input.sources && input.sources.length > 0) params.set('sources', input.sources.join(','));
  if (input.salaryMinUsd !== undefined) params.set('salary_min', String(input.salaryMinUsd));
  if (input.limit !== undefined) params.set('limit', String(input.limit));
  if (input.offset !== undefined) params.set('offset', String(input.offset));
  const qs = params.toString();
  return apiJson(ctx.app, `/profiles/${id}/job-recommendations${qs ? `?${qs}` : ''}`);
}
