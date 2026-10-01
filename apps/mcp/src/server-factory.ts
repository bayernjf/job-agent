/**
 * 构造 MCP server（可注入 app/config/limiter，便于契约与负向测试，不打网络/stdio）。
 *
 * 工具可见性（fail-closed，决策 #19 §5）：
 *  - 未配置 MCP_API_KEY：只有 search_jobs 可用；其余三工具被调用即返回 MCP_KEY_REQUIRED。
 *  - 配置了 key：调用方必须在入参 apiKey 给对 key（stdio 下由客户端注入）。
 * 所有画像类调用统一过固定窗口限流（按 key+源 IP）。
 */
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createApp, type ApiDeps } from '@jobagent/api';
import { FixedWindowRateLimiter } from './rate-limiter.js';
import {
  MCP_ERROR_CODES,
  hashIp,
  isApiKeyValid,
  loadMcpConfig,
  type McpConfig,
} from './config.js';
import {
  getProfile,
  lookupProfileBySubject,
  matchProfileToJob,
  searchJobs,
  McpToolError,
  ProfileIdShape,
  SubjectShape,
  SearchJobsShape,
  MatchShape,
  type ApiRequester,
} from './tools.js';

export interface CreateMcpOptions {
  /** 复用已构造的 Hono app（测试注入）；不传则进程内 createApp()。 */
  app?: Awaited<ReturnType<typeof createApp>>;
  /** 透传给 createApp 的依赖（测试注入内存仓储）。 */
  apiDeps?: ApiDeps;
  config?: McpConfig;
  limiter?: FixedWindowRateLimiter;
  /** 源 IP（stdio 本地通常无 IP，测试可注入）。 */
  sourceIp?: string | null;
}

const TOOL_BOUNDARY_NOTE =
  'This is a verifiable-evidence ability profile, not a score ranking. ' +
  'Raw evidence URLs, signal details, and interview questions are intentionally omitted; ' +
  'a human can view them on the authenticated web report.';

function textResult(payload: unknown, isError = false): CallToolResult {
  return {
    isError,
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

function errorResult(code: string, message: string, httpStatus?: number): CallToolResult {
  return textResult({ error: message, code, ...(httpStatus ? { httpStatus } : {}) }, true);
}

function mapToolError(err: unknown): CallToolResult {
  if (err instanceof McpToolError) {
    if (err.httpStatus === 400) return errorResult(MCP_ERROR_CODES.invalidSubject, err.message, 400);
    if (err.code === 'PROFILE_NOT_FOUND' || err.httpStatus === 404) {
      return errorResult(MCP_ERROR_CODES.profileNotFound, err.message, 404);
    }
    return errorResult(err.code, err.message, err.httpStatus);
  }
  return errorResult('INTERNAL', (err as Error).message);
}

export async function createMcpServer(options: CreateMcpOptions = {}) {
  const config = options.config ?? loadMcpConfig();
  const limiter =
    options.limiter ??
    new FixedWindowRateLimiter({
      windowMs: config.windowMs,
      maxRequests: config.maxRequestsPerWindow,
    });
  const app = (options.app ?? (await createApp(options.apiDeps ?? {}))) as ApiRequester;
  const sourceIp = options.sourceIp ?? null;

  /** 画像类工具共用的鉴权 + 限流前置；null=放行。 */
  const gate = (providedKey: string | undefined): CallToolResult | null => {
    if (!config.apiKey) {
      return errorResult(MCP_ERROR_CODES.keyRequired, 'MCP_API_KEY is not configured on this server');
    }
    if (!isApiKeyValid(providedKey, config.apiKey)) {
      return errorResult(MCP_ERROR_CODES.keyRequired, 'missing or invalid MCP API key', 401);
    }
    const ipHash = hashIp(sourceIp, config.ipSalt) ?? 'local';
    const verdict = limiter.tryConsume(`key:${ipHash}`);
    if (!verdict.allowed) {
      return errorResult(
        MCP_ERROR_CODES.rateLimited,
        `rate limit exceeded; retry after ~${Math.ceil(verdict.resetMs / 1000)}s`,
        429,
      );
    }
    return null;
  };

  /** 公开岗位列表单独限流（按源 IP），不要求 key。 */
  const gateJobs = (): CallToolResult | null => {
    const ipHash = hashIp(sourceIp, config.ipSalt) ?? 'local';
    const verdict = limiter.tryConsume(`jobs:${ipHash}`);
    if (!verdict.allowed) {
      return errorResult(
        MCP_ERROR_CODES.rateLimited,
        `rate limit exceeded; retry after ~${Math.ceil(verdict.resetMs / 1000)}s`,
        429,
      );
    }
    return null;
  };

  const server = new McpServer(
    { name: 'jobagent-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  const KeyShape = { apiKey: z.string().optional() } as const;

  server.tool(
    'search_jobs',
    `Search the curated remote-job pool (title/company/source/url/freshness). Read-only. ${TOOL_BOUNDARY_NOTE}`,
    SearchJobsShape,
    async (input) => {
      const denied = gateJobs();
      if (denied) return denied;
      try {
        return textResult(await searchJobs({ app }, input));
      } catch (err) {
        return mapToolError(err);
      }
    },
  );

  server.tool(
    'get_profile',
    `Get a profile's exportable projection (subject, headline, skills+confidence, authenticity, analyzerVersion). Read-only; never triggers analysis. ${TOOL_BOUNDARY_NOTE}`,
    { ...ProfileIdShape, ...KeyShape },
    async (input) => {
      const denied = gate(input.apiKey);
      if (denied) return denied;
      try {
        return textResult(await getProfile({ app }, { profileId: input.profileId }));
      } catch (err) {
        return mapToolError(err);
      }
    },
  );

  server.tool(
    'lookup_profile_by_subject',
    `Resolve the latest complete/partial profile id for a platform login. Read-only; partial is a terminal degraded state, never upgraded. ${TOOL_BOUNDARY_NOTE}`,
    { ...SubjectShape, ...KeyShape },
    async (input) => {
      const denied = gate(input.apiKey);
      if (denied) return denied;
      try {
        return textResult(
          await lookupProfileBySubject({ app }, { platform: input.platform, login: input.login }),
        );
      } catch (err) {
        return mapToolError(err);
      }
    },
  );

  server.tool(
    'match_profile_to_job',
    `Rank job postings against a profile's skills; returns score, per-skill reasons, and field breakdown. Does not build resumes. Read-only. ${TOOL_BOUNDARY_NOTE}`,
    { ...MatchShape, ...KeyShape },
    async (input) => {
      const denied = gate(input.apiKey);
      if (denied) return denied;
      try {
        const { apiKey: _omit, ...matchInput } = input;
        return textResult(await matchProfileToJob({ app }, matchInput));
      } catch (err) {
        return mapToolError(err);
      }
    },
  );

  return { server, app, config, limiter };
}
