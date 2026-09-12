/**
 * 扩展侧 API 客户端：复用公开 API（docs/API.md）拿可信画像。
 *
 * 流程：POST /analyze {username} → 拿 jobId（缓存命中直接 profileId）
 *   → 轮询 GET /jobs/:id → succeeded 后 GET /profiles/:id → parseExportableProfile。
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
}

const DEFAULT_BASE = typeof EXTENSION_API_BASE === 'string' ? EXTENSION_API_BASE : 'http://localhost:3000';

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

export class JobAgentApi {
  constructor(private readonly opts: ApiClientOptions) {}

  /**
   * 输入 GitHub 用户名，返回可信画像（ExportableProfile）。
   * 未生成完的画像会轮询等待；校验失败/分析失败/超时抛错。
   */
  async fetchProfile(username: string): Promise<ExportableProfile> {
    const { baseUrl, pollMs = 2000, timeoutMs = 60_000 } = this.opts;
    const fetchImpl = this.opts.fetchImpl ?? fetch;

    const created = await this.postAnalyze(fetchImpl, baseUrl, username);
    let profileId: string | undefined = created.profileId;

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

    const profile = await this.getProfile(fetchImpl, baseUrl, profileId);
    return profile;
  }

  private async postAnalyze(
    fetchImpl: typeof fetch,
    baseUrl: string,
    username: string,
  ): Promise<{ jobId: string | undefined; profileId: string | undefined }> {
    const res = await fetchImpl(`${baseUrl}/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username }),
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
    const res = await fetchImpl(`${baseUrl}/jobs/${encodeURIComponent(jobId)}`);
    if (!res.ok) throw apiError(`job lookup failed (HTTP ${res.status})`, res.status);
    const body = (await res.json()) as Record<string, unknown>;
    return {
      status: String(body.status ?? ''),
      profileId: typeof body.profileId === 'string' ? body.profileId : undefined,
      error: typeof body.error === 'string' ? body.error : undefined,
    };
  }

  private async getProfile(fetchImpl: typeof fetch, baseUrl: string, profileId: string): Promise<ExportableProfile> {
    const res = await fetchImpl(`${baseUrl}/profiles/${encodeURIComponent(profileId)}/exportable`);
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
