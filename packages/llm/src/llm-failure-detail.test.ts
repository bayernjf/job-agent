/**
 * 失败详情结构化（LLM 观测面，2026-10-11）。
 *
 * 生产两次 502 只能看到一句 "LLM request failed: The operation was aborted due to timeout"，
 * 分不清"上游 401"与"60s 没返回"。这里把 kind／上游状态码／超时预算挂到错误对象上，
 * 并让 describeError 带出去，服务端日志才有可判读的字段。
 */
import { describe, expect, it } from 'vitest';
import { LlmResponseError, OpenAICompatibleClient, type LlmFetch } from './index.js';

const baseCfg = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'secret-key',
  model: 'gpt-test',
};

/** 抛指定 name/message 的 fetch（形状取自真 fetch 的实测输出，不是自拟）。 */
function throwingFetch(name: string, message: string): LlmFetch {
  return async () => {
    throw Object.assign(new Error(message), { name });
  };
}

describe('LlmResponseError.detail', () => {
  it('classifies an AbortSignal.timeout abort as a timeout with its budget', async () => {
    // 实测：AbortSignal.timeout() 让真 fetch 抛 name='TimeoutError'（不是 AbortError），
    // 只判 AbortError 会把它降级成网络错、timeoutMs 随之丢失
    const client = new OpenAICompatibleClient({
      ...baseCfg,
      timeoutMs: 60_000,
      fetchImpl: throwingFetch('TimeoutError', 'The operation was aborted due to timeout'),
    });
    const err = await client.generateJson({ messages: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmResponseError);
    expect((err as LlmResponseError).message).toContain('timed out after 60000ms');
    expect((err as LlmResponseError).detail).toEqual({ kind: 'timeout', timeoutMs: 60_000 });
  });

  it('still classifies a manual AbortError as a timeout', async () => {
    const client = new OpenAICompatibleClient({
      ...baseCfg,
      timeoutMs: 1234,
      fetchImpl: throwingFetch('AbortError', 'manually aborted'),
    });
    const err = (await client.generateJson({ messages: [] }).catch((e) => e)) as LlmResponseError;
    expect(err.detail).toEqual({ kind: 'timeout', timeoutMs: 1234 });
  });

  it('carries the upstream status on a non-2xx', async () => {
    const client = new OpenAICompatibleClient({
      ...baseCfg,
      fetchImpl: (async () => ({
        ok: false,
        status: 401,
        json: async () => ({}),
        text: async () => 'invalid api key',
      })) as LlmFetch,
    });
    const err = (await client.generateJson({ messages: [] }).catch((e) => e)) as LlmResponseError;
    expect(err.detail).toEqual({ kind: 'http', status: 401 });
    expect(err.message).not.toContain('secret-key');
  });

  it('marks an unparseable body as a parse failure, distinct from a transport one', async () => {
    const client = new OpenAICompatibleClient({
      ...baseCfg,
      fetchImpl: (async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error('not json');
        },
        text: async () => '',
      })) as LlmFetch,
    });
    const err = (await client.generateJson({ messages: [] }).catch((e) => e)) as LlmResponseError;
    expect(err.detail).toEqual({ kind: 'parse' });
  });

  it('keeps a network error as network (no status, no budget)', async () => {
    const client = new OpenAICompatibleClient({
      ...baseCfg,
      fetchImpl: throwingFetch('TypeError', 'fetch failed'),
    });
    const err = (await client.generateJson({ messages: [] }).catch((e) => e)) as LlmResponseError;
    expect(err.detail).toEqual({ kind: 'network' });
  });
});

// 一次性说明：本文件只验 detail 字段，不重复 openai-compatible-client.test.ts 的请求形状。
