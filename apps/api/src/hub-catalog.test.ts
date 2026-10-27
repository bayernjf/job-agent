/**
 * model-hub 目录同步单元测试（W5-1）。
 * 内存 SQLite + 假 fetch，全程不打网络：
 * - sync 把 hub 投影的文本模型写入 llm_catalog_models（source='hub' / revision / assignment_id）
 * - 非文本模型不进本地表；catalogCache 被刷新，第一个 primary 为默认
 * - 二次同步走 304 仍保留目录；ping(L3) 与 test(L4) 入口可用
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStorage } from '@jobagent/storage';
import { createCatalogCache } from '@jobagent/llm';
import type { CatalogResponse } from '@model-hub/model-kit';
import { createHubCatalog } from './hub-catalog.js';

const catalog: CatalogResponse = {
  project: 'job-agent',
  revision: 42,
  fetched_at: '2026-10-28T03:00:00Z',
  models: [
    {
      assignment_id: 'asn_0001noul',
      alias: 'noul',
      role: 'primary',
      modalities: ['text'],
      model: 'ark-code-latest',
      litellm_id: null,
      display_name: 'Ark Code Latest',
      protocol: 'openai-compatible',
      base_url: 'https://ark.cn-beijing.volces.com/api/plan/v3',
      api_key: 'PLACEHOLDER_KEY_NOT_REAL_0001',
      endpoints: { chat: '/chat/completions' },
      adapter: null,
      context_window: 256000,
      supports_json: true,
      supports_stream: true,
      daily_budget_micros: 5000000,
      pricing: null,
    },
    {
      assignment_id: 'asn_0002score',
      alias: 'score',
      role: 'primary',
      modalities: ['text'],
      model: 'doubao-seed-1-6-250615',
      litellm_id: 'openai/doubao-seed-1-6-250615',
      display_name: 'Doubao Seed 1.6',
      protocol: 'openai-compatible',
      base_url: 'https://ark.cn-beijing.volces.com/api/v3',
      api_key: 'PLACEHOLDER_KEY_NOT_REAL_0002',
      endpoints: { chat: '/chat/completions' },
      adapter: null,
      context_window: 256000,
      supports_json: true,
      supports_stream: true,
      daily_budget_micros: 3000000,
      pricing: {
        input_usd_per_million: 0.8,
        output_usd_per_million: 2.0,
      },
    },
    {
      assignment_id: 'asn_0003image',
      alias: null,
      role: 'fallback',
      modalities: ['image'],
      model: 'doubao-seedream-4-0-250828',
      litellm_id: 'openai/doubao-seedream-4-0-250828',
      display_name: 'Doubao Seedream 4.0',
      protocol: 'openai-compatible',
      base_url: 'https://ark.cn-beijing.volces.com/api/v3',
      api_key: 'PLACEHOLDER_KEY_NOT_REAL_0003',
      endpoints: { images: '/images/generations' },
      adapter: null,
      context_window: null,
      supports_json: false,
      supports_stream: false,
      daily_budget_micros: null,
      pricing: { per_image: 0.04 },
    },
  ],
};

/** 假 fetch：hub models 走 304（有 ETag 时）/ 200；usage 204；厂商 chat 回最小 completion。 */
function fakeFetch(
  fetchCalls: Array<{ url: string; body?: string }>,
): typeof fetch {
  return (async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? init.body : undefined;
    fetchCalls.push({ url, body });
    if (url.includes('/pub/v1/models')) {
      const headers = (init?.headers as Record<string, string> | undefined) ?? {};
      if (headers['If-None-Match']) return new Response(null, { status: 304 });
      return new Response(JSON.stringify(catalog), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/pub/v1/usage')) {
      return new Response(null, { status: 202 });
    }
    return new Response(
      JSON.stringify({
        // L4 runs through the LlmClient, which requires a JSON object body.
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
        model: 'ark-code-latest',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;
}

let dir: string;
let fetchCalls: Array<{ url: string; body?: string }>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hub-catalog-'));
  fetchCalls = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function setup() {
  const repos = await createStorage({ sqlitePath: ':memory:' });
  const catalogCache = createCatalogCache();
  const fetchImpl = fakeFetch(fetchCalls);
  const hub = await createHubCatalog(
    {
      hubUrl: 'https://hub.local',
      token: 'tok',
      cachePath: join(dir, 'cache.json'),
      fetchImpl,
    },
    repos,
    catalogCache,
  );
  return { repos, catalogCache, hub, fetchImpl };
}

describe('hub catalog sync', () => {
  it('syncs projected text models into the local catalog table', async () => {
    const { repos, hub } = await setup();
    const result = await hub.sync();
    expect(result.revision).toBe(42);
    expect(result.pulled).toBe(2);
    expect(result.synced).toBe(2);

    const rows = await repos.llmCatalog.listAll();
    expect(rows).toHaveLength(2);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const noul = byId.get('noul');
    expect(noul).toMatchObject({
      source: 'hub',
      revision: 42,
      assignmentId: 'asn_0001noul',
      model: 'ark-code-latest',
      enabled: true,
    });
    const score = byId.get('score');
    expect(score).toMatchObject({
      source: 'hub',
      assignmentId: 'asn_0002score',
      model: 'doubao-seed-1-6-250615',
    });
  });

  it('does not sync non-text models', async () => {
    const { repos, hub } = await setup();
    await hub.sync();
    const rows = await repos.llmCatalog.listAll();
    expect(rows.map((r) => r.model)).not.toContain('doubao-seedream-4-0-250828');
  });

  it('refreshes the cache and marks the first primary as default', async () => {
    const { catalogCache, hub } = await setup();
    await hub.sync();
    const models = catalogCache.get();
    expect(models).toHaveLength(2);
    const noul = models.find((m) => m.id === 'noul');
    const score = models.find((m) => m.id === 'score');
    expect(noul?.isDefault).toBe(true);
    expect(score?.isDefault).toBe(false);
  });

  it('keeps the catalog on a 304 second sync', async () => {
    const { repos, hub } = await setup();
    await hub.sync();
    // Second sync: kit already has revision 42, so the hub answers 304.
    const result = await hub.sync();
    expect(result.revision).toBe(42);
    const rows = await repos.llmCatalog.listAll();
    expect(rows).toHaveLength(2);
  });

  it('reports L3 ping against the hub', async () => {
    const { hub } = await setup();
    const ping = await hub.ping();
    expect(ping.ok).toBe(true);
    expect(ping.revision).toBe(42);
  });

  it('runs an L4 test through the default probe', async () => {
    const { hub } = await setup();
    const test = await hub.test('noul');
    expect(test.ok).toBe(true);
    expect(test.scope).toBe('L4');
  });

  it('resolves the built-in providers from the primary text model', async () => {
    const { hub } = await setup();
    const builtin = await hub.resolveBuiltin();
    expect(builtin).not.toBeNull();
    expect(builtin?.model.alias).toBe('noul');
    expect(builtin?.model.assignmentId).toBe('asn_0001noul');
    expect(builtin?.cover).not.toBeNull();
    expect(builtin?.polish).not.toBeNull();
  });

  it('reports built-in usage to the hub with assignment_id', async () => {
    const { hub } = await setup();
    await hub.sync();
    await hub.reportUsage({
      feature: 'cover_letter',
      assignmentId: 'asn_0001noul',
      promptTokens: 12,
      completionTokens: 34,
    });
    const usageCall = fetchCalls.find((c) => c.url.includes('/pub/v1/usage'));
    expect(usageCall).not.toBeUndefined();
    const body = JSON.parse(usageCall?.body ?? '{}') as Record<string, unknown>;
    expect(body).toMatchObject({
      feature: 'cover_letter',
      billing_source: 'builtin',
      assignment_id: 'asn_0001noul',
      input_tokens: 12,
      output_tokens: 34,
    });
  });

  it('does not report usage for an unknown assignment', async () => {
    const { hub } = await setup();
    await hub.sync();
    await hub.reportUsage({
      feature: 'cover_letter',
      assignmentId: 'asn_does_not_exist',
    });
    expect(fetchCalls.some((c) => c.url.includes('/pub/v1/usage'))).toBe(false);
  });
});
