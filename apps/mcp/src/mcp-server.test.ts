/**
 * MCP 接入面端到端测试（决策 #19，2026-10-01）：
 * 用真实 MCP Client + InMemoryTransport 连 createMcpServer，不打网络/stdio。
 * 覆盖：
 *  - 四个只读工具契约（入参、返回字段集合、错误码）
 *  - fail-closed：未配 key 时画像类工具 401 MCP_KEY_REQUIRED；search_jobs 放行
 *  - 负向可见性：get_profile 响应 0 个 http 证据外链、无 interviewQuestions/signal detail
 *  - 限流可证伪：超阈值 MCP_RATE_LIMITED，阈值内全过
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer } from './server-factory.js';
import { FixedWindowRateLimiter } from './rate-limiter.js';
import { MCP_ERROR_CODES, type McpConfig } from './config.js';
import { buildHarness, PROFILE_ID, SUBJECT } from './test-harness.js';

const KEY = 'test-secret-key';

function testConfig(overrides: Partial<McpConfig> = {}): McpConfig {
  return {
    apiKey: KEY,
    isProduction: false,
    windowMs: 60_000,
    maxRequestsPerWindow: 60,
    ipSalt: 'salt',
    ...overrides,
  };
}

async function makeConnected(opts: { config?: McpConfig; limiter?: FixedWindowRateLimiter } = {}) {
  const harness = await buildHarness();
  const built = await createMcpServer({
    app: harness.app,
    config: opts.config ?? testConfig(),
    limiter: opts.limiter,
  });
  const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([built.server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, config: built.config };
}

function parseText(result: CallToolResult): unknown {
  const first = result.content[0];
  if (!first || first.type !== 'text') throw new Error('expected text content');
  return JSON.parse(first.text);
}

afterEach(async () => {
  // 客户端/服务端 transport 在各用例内是独立内存实例，无需全局清理；
});

describe('MCP surface (decision #19)', () => {
  it('lists exactly the four read-only tools', async () => {
    const { client } = await makeConnected();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['get_profile', 'lookup_profile_by_subject', 'match_profile_to_job', 'search_jobs'].sort(),
    );
  });

  it('search_jobs works WITHOUT a key (public job pool), returns postings', async () => {
    const { client } = await makeConnected({ config: testConfig({ apiKey: undefined }) });
    const result = await client.callTool({ name: 'search_jobs', arguments: { keyword: 'AI', limit: 5 } });
    expect(result.isError).toBeFalsy();
    const body = parseText(result as CallToolResult) as { items: { title: string }[] };
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items[0]!.title).toMatch(/AI/);
  });

  it('get_profile with a valid key returns the exportable projection', async () => {
    const { client } = await makeConnected();
    const result = await client.callTool({ name: 'get_profile', arguments: { profileId: PROFILE_ID, apiKey: KEY } });
    expect(result.isError).toBeFalsy();
    const body = parseText(result as CallToolResult) as Record<string, unknown>;
    expect(body.profileId).toBe(PROFILE_ID);
    expect(body).toHaveProperty('headline');
    expect(body).toHaveProperty('skills');
    expect(body).toHaveProperty('authenticity');
    expect(body).toHaveProperty('analyzerVersion');
  });

  it('NEGATIVE visibility: get_profile never leaks evidence URLs, signal detail, or interview questions', async () => {
    const { client } = await makeConnected();
    const result = await client.callTool({ name: 'get_profile', arguments: { profileId: PROFILE_ID, apiKey: KEY } });
    const raw = JSON.stringify(parseText(result as CallToolResult));
    // 主体主页 profileUrl 是公开的（允许）；证据/PR/commit 外链与信号原文不得出现。
    expect(raw).not.toMatch(/github\.com\/[^/"]+\/(pull|issues|commit)/);
    expect(raw).not.toContain('Has merged external pull requests');
    const body = parseText(result as CallToolResult) as Record<string, unknown>;
    expect(body).not.toHaveProperty('interviewQuestions');
    expect(body).not.toHaveProperty('caveats');
    const skillsJson = JSON.stringify((body as { skills: unknown[] }).skills);
    // evidenceRefs 只给内部 id，不含 URL
    expect(skillsJson).not.toMatch(/github\.com\/.*\/pull/);
  });

  it('get_profile without key is fail-closed: MCP_KEY_REQUIRED', async () => {
    const { client } = await makeConnected();
    const result = await client.callTool({ name: 'get_profile', arguments: { profileId: PROFILE_ID } });
    expect(result.isError).toBe(true);
    const body = parseText(result as CallToolResult) as { code: string; httpStatus: number };
    expect(body.code).toBe(MCP_ERROR_CODES.keyRequired);
    expect(body.httpStatus).toBe(401);
  });

  it('get_profile with a wrong key is rejected: MCP_KEY_REQUIRED', async () => {
    const { client } = await makeConnected();
    const result = await client.callTool({ name: 'get_profile', arguments: { profileId: PROFILE_ID, apiKey: 'nope' } });
    expect(result.isError).toBe(true);
    expect((parseText(result as CallToolResult) as { code: string }).code).toBe(MCP_ERROR_CODES.keyRequired);
  });

  it('unconfigured server fail-closes profile tools even when a key is supplied', async () => {
    const { client } = await makeConnected({ config: testConfig({ apiKey: undefined }) });
    const result = await client.callTool({ name: 'get_profile', arguments: { profileId: PROFILE_ID, apiKey: KEY } });
    expect(result.isError).toBe(true);
    expect((parseText(result as CallToolResult) as { code: string }).code).toBe(MCP_ERROR_CODES.keyRequired);
  });

  it('get_profile unknown id → PROFILE_NOT_FOUND', async () => {
    const { client } = await makeConnected();
    const result = await client.callTool({ name: 'get_profile', arguments: { profileId: 'does-not-exist', apiKey: KEY } });
    expect(result.isError).toBe(true);
    expect((parseText(result as CallToolResult) as { code: string }).code).toBe(MCP_ERROR_CODES.profileNotFound);
  });

  it('lookup_profile_by_subject resolves profile id + status', async () => {
    const { client } = await makeConnected();
    const result = await client.callTool({
      name: 'lookup_profile_by_subject',
      arguments: { platform: SUBJECT.platform, login: SUBJECT.login, apiKey: KEY },
    });
    expect(result.isError).toBeFalsy();
    const body = parseText(result as CallToolResult) as { profileId: string; status: string };
    expect(body.profileId).toBe(PROFILE_ID);
    expect(['complete', 'partial']).toContain(body.status);
  });

  it('lookup_profile_by_subject with malformed login → INVALID_SUBJECT', async () => {
    const { client } = await makeConnected();
    const result = await client.callTool({
      name: 'lookup_profile_by_subject',
      arguments: { platform: 'github', login: 'bad login!!', apiKey: KEY },
    });
    expect(result.isError).toBe(true);
    expect((parseText(result as CallToolResult) as { code: string }).code).toBe(MCP_ERROR_CODES.invalidSubject);
  });

  it('lookup_profile_by_subject unknown subject → PROFILE_NOT_FOUND', async () => {
    const { client } = await makeConnected();
    const result = await client.callTool({
      name: 'lookup_profile_by_subject',
      arguments: { platform: 'github', login: 'nobodyhere', apiKey: KEY },
    });
    expect(result.isError).toBe(true);
    expect((parseText(result as CallToolResult) as { code: string }).code).toBe(MCP_ERROR_CODES.profileNotFound);
  });

  it('match_profile_to_job returns ranked matches with score and skill reasons', async () => {
    const { client } = await makeConnected();
    const result = await client.callTool({
      name: 'match_profile_to_job',
      arguments: { profileId: PROFILE_ID, remote: true, apiKey: KEY, limit: 5 },
    });
    expect(result.isError).toBeFalsy();
    const body = parseText(result as CallToolResult) as {
      profileId: string;
      matches: { score: number; posting: { title: string } }[];
    };
    expect(body.profileId).toBe(PROFILE_ID);
    expect(body.matches.length).toBeGreaterThan(0);
    expect(typeof body.matches[0]!.score).toBe('number');
    expect(body.matches[0]!.posting.title).toMatch(/AI/);
  });

  it('rate limiter is falsifiable: threshold+1 profile call is rejected, within threshold passes', async () => {
    const limiter = new FixedWindowRateLimiter({ windowMs: 60_000, maxRequests: 3, now: () => 0 });
    const { client } = await makeConnected({ limiter });
    // search_jobs 用独立桶，不占画像额度
    const ok = await client.callTool({ name: 'get_profile', arguments: { profileId: PROFILE_ID, apiKey: KEY } });
    expect(ok.isError).toBeFalsy();
    await client.callTool({ name: 'get_profile', arguments: { profileId: PROFILE_ID, apiKey: KEY } });
    await client.callTool({ name: 'get_profile', arguments: { profileId: PROFILE_ID, apiKey: KEY } });
    const blocked = await client.callTool({ name: 'get_profile', arguments: { profileId: PROFILE_ID, apiKey: KEY } });
    expect(blocked.isError).toBe(true);
    expect((parseText(blocked as CallToolResult) as { code: string }).code).toBe(MCP_ERROR_CODES.rateLimited);
  });
});
