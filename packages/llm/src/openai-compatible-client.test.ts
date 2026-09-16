import { describe, expect, it, vi } from 'vitest';
import {
  OpenAICompatibleClient,
  createResumePolishProviderFromEnv,
  parseJsonObject,
  providerFromBaseUrl,
  type LlmFetch,
  type LlmFetchInit,
  type LlmFetchResponse,
} from './openai-compatible-client.js';
import { LlmResponseError } from './port.js';

function contentResponse(content: unknown, status = 200): LlmFetchResponse {
  const body =
    typeof content === 'string'
      ? { choices: [{ message: { content } }] }
      : (content as unknown);
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => text,
  };
}

/** 记录最后一次请求的假 fetch。 */
function fakeFetch(respond: (url: string, init: LlmFetchInit) => LlmFetchResponse | Promise<LlmFetchResponse>) {
  const calls: Array<{ url: string; init: LlmFetchInit }> = [];
  const fn: LlmFetch = async (url, init) => {
    calls.push({ url, init });
    return respond(url, init);
  };
  return { fn, calls };
}

const baseCfg = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'secret-key',
  model: 'gpt-test',
};

describe('OpenAICompatibleClient', () => {
  it('posts chat/completions with JSON mode, bearer auth and passthrough messages', async () => {
    const { fn, calls } = fakeFetch(() =>
      contentResponse(JSON.stringify({ summary: 'hello' })),
    );
    const client = new OpenAICompatibleClient({ ...baseCfg, fetchImpl: fn });
    const out = await client.generateJson<{ summary: string }>({
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
      ],
      temperature: 0.2,
    });

    expect(out).toEqual({ summary: 'hello' });
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe('Bearer secret-key');
    expect(init.headers['content-type']).toBe('application/json');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('gpt-test');
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.temperature).toBe(0.2);
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ]);
  });

  it('strips ```json fences and surrounding whitespace', async () => {
    const { fn } = fakeFetch(() =>
      contentResponse('```json\n{"summary": "fenced"}\n```'),
    );
    const client = new OpenAICompatibleClient({ ...baseCfg, fetchImpl: fn });
    const out = await client.generateJson<{ summary: string }>({ messages: [] });
    expect(out).toEqual({ summary: 'fenced' });
  });

  it('rejects non-2xx with status in the error and never leaks the api key', async () => {
    const { fn } = fakeFetch(() =>
      contentResponse({ error: { message: 'bad key' } }, 401),
    );
    const client = new OpenAICompatibleClient({ ...baseCfg, fetchImpl: fn });
    await expect(client.generateJson({ messages: [] })).rejects.toMatchObject({
      name: 'LlmResponseError',
    });
    await expect(client.generateJson({ messages: [] })).rejects.toThrow(/HTTP 401/);
    // 错误路径里也不应出现密钥
    const calls = fakeFetch(() => contentResponse({}, 401));
    const c2 = new OpenAICompatibleClient({ ...baseCfg, fetchImpl: calls.fn });
    await c2.generateJson({ messages: [] }).catch((err: LlmResponseError) => {
      expect(err.message).not.toContain('secret-key');
    });
  });

  it('rejects model content that is not a JSON object', async () => {
    const { fn } = fakeFetch(() => contentResponse('not json at all'));
    const client = new OpenAICompatibleClient({ ...baseCfg, fetchImpl: fn });
    await expect(client.generateJson({ messages: [] })).rejects.toThrow(
      /not be a JSON object|not a JSON object/,
    );
  });

  it('rejects when choices[0].message.content is missing', async () => {
    const { fn } = fakeFetch(() => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: {} }] }),
      text: async () => '{}',
    }));
    const client = new OpenAICompatibleClient({ ...baseCfg, fetchImpl: fn });
    await expect(client.generateJson({ messages: [] })).rejects.toThrow(
      /missing choices/,
    );
  });

  it('wraps network failures as LlmResponseError', async () => {
    const { fn } = fakeFetch(() => {
      throw new Error('ECONNREFUSED');
    });
    const client = new OpenAICompatibleClient({ ...baseCfg, fetchImpl: fn });
    await expect(client.generateJson({ messages: [] })).rejects.toThrow(
      /LLM request failed: ECONNREFUSED/,
    );
  });

  it('rejects JSON arrays (only objects satisfy the port contract)', () => {
    expect(parseJsonObject('[1,2,3]')).toBeUndefined();
    expect(parseJsonObject('"str"')).toBeUndefined();
    expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it('requires apiKey, model and baseUrl', () => {
    expect(
      () => new OpenAICompatibleClient({ ...baseCfg, apiKey: '  ' }),
    ).toThrow(/apiKey/);
    expect(
      () => new OpenAICompatibleClient({ ...baseCfg, model: '' }),
    ).toThrow(/model/);
    expect(
      () => new OpenAICompatibleClient({ ...baseCfg, baseUrl: '' }),
    ).toThrow(/baseUrl/);
  });
});

describe('providerFromBaseUrl', () => {
  it('maps known hosts and falls back to the second-level name', () => {
    expect(providerFromBaseUrl('https://api.openai.com/v1')).toBe('openai');
    expect(providerFromBaseUrl('https://api.deepseek.com/v1')).toBe('deepseek');
    expect(providerFromBaseUrl('https://gateway.example.com/v1')).toBe('example');
    expect(providerFromBaseUrl('http://localhost:11434/v1')).toBe('localhost');
  });
});

describe('createResumePolishProviderFromEnv', () => {
  it('returns null when LLM_API_KEY is absent (default off, rule-based path)', () => {
    expect(createResumePolishProviderFromEnv({})).toBeNull();
    expect(createResumePolishProviderFromEnv({ LLM_API_KEY: '  ' })).toBeNull();
  });

  it('throws when a key is present but model is missing (no implicit paid default)', () => {
    expect(() =>
      createResumePolishProviderFromEnv({ LLM_API_KEY: 'k' }),
    ).toThrow(/LLM_MODEL/);
  });

  it('builds a working deepseek provider from env without any network access', async () => {
    const spy = vi.fn<LlmFetch>(async () =>
      contentResponse(JSON.stringify({ summary: 'polished line' })),
    );
    const provider = createResumePolishProviderFromEnv(
      {
        LLM_API_KEY: 'k',
        LLM_MODEL: 'deepseek-chat',
        LLM_BASE_URL: 'https://api.deepseek.com/v1',
      },
      { fetchImpl: spy },
    );
    expect(provider).not.toBeNull();
    expect(provider?.provider).toBe('deepseek');
    expect(provider?.model).toBe('deepseek-chat');
    expect(provider?.promptVersion).toBe('resume-polish-0.1');

    const edits = await provider!.polish({
      // userPrompt 读取 summary/evidenceHighlights 与 posting.title/company，做最小合法构造
      draft: { summary: 'rule summary', evidenceHighlights: [] } as never,
      posting: { title: 'Backend Engineer', company: 'Acme' } as never,
      locale: 'en',
    });
    expect(edits.summary).toBe('polished line');
    expect(spy).toHaveBeenCalledTimes(1);
    // 密钥只在 Authorization 头
    const init = spy.mock.calls[0]![1];
    expect(init.headers.authorization).toBe('Bearer k');
  });

  it('defaults to the OpenAI base url and honours an explicit provider override', async () => {
    const spy = vi.fn<LlmFetch>(async () => contentResponse('{}'));
    const provider = createResumePolishProviderFromEnv(
      { LLM_API_KEY: 'k', LLM_MODEL: 'm', LLM_PROVIDER: 'self-hosted' },
      { fetchImpl: spy },
    );
    expect(provider?.provider).toBe('self-hosted');
    await provider!.polish({
      draft: { summary: 'rule summary', evidenceHighlights: [] } as never,
      posting: { title: 'SWE', company: 'Acme' } as never,
      locale: 'en',
    });
    const url = spy.mock.calls[0]![0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
  });
});
