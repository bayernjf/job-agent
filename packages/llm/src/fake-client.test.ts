import { describe, expect, it } from 'vitest';
import { FakeLlmClient } from './fake-client.js';
import { LlmResponseError, type LlmTokenUsage } from './port.js';

describe('FakeLlmClient usage（可控 token 用量，决策 #25 ④）', () => {
  it('未配置 usage 时成功路径回 {null, null}，与真实客户端契约一致', async () => {
    const client = new FakeLlmClient(() => ({ ok: true }));
    const observed: LlmTokenUsage[] = [];
    await client.generateJson({ messages: [], onUsage: (u) => observed.push(u) });
    expect(observed).toEqual([{ promptTokens: null, completionTokens: null }]);
  });

  it('固定值 usage 在成功路径恰好透出一次', async () => {
    const client = new FakeLlmClient(() => ({ ok: true }), 'fake-model-1', {
      promptTokens: 100,
      completionTokens: 20,
    });
    const observed: LlmTokenUsage[] = [];
    await client.generateJson({ messages: [], onUsage: (u) => observed.push(u) });
    await client.generateJson({ messages: [], onUsage: (u) => observed.push(u) });
    expect(observed).toEqual([
      { promptTokens: 100, completionTokens: 20 },
      { promptTokens: 100, completionTokens: 20 },
    ]);
  });

  it('函数形 usage 可按请求/调用序给出不同值（含单字段 null）', async () => {
    const client = new FakeLlmClient(
      () => ({ ok: true }),
      'fake-model-1',
      (_request, callIndex) =>
        callIndex === 0
          ? { promptTokens: 10, completionTokens: 1 }
          : { promptTokens: 20, completionTokens: null },
    );
    const observed: LlmTokenUsage[] = [];
    await client.generateJson({ messages: [], onUsage: (u) => observed.push(u) });
    await client.generateJson({ messages: [], onUsage: (u) => observed.push(u) });
    expect(observed).toEqual([
      { promptTokens: 10, completionTokens: 1 },
      { promptTokens: 20, completionTokens: null },
    ]);
  });

  it('字符串响应成功解析后也透出 usage', async () => {
    const client = new FakeLlmClient(() => '{"ok":true}', 'fake-model-1', {
      promptTokens: 3,
      completionTokens: 4,
    });
    const observed: LlmTokenUsage[] = [];
    await client.generateJson({ messages: [], onUsage: (u) => observed.push(u) });
    expect(observed).toEqual([{ promptTokens: 3, completionTokens: 4 }]);
  });

  it('失败路径（responder 抛错 / 非 JSON / 非对象）绝不回调 onUsage', async () => {
    const observed: LlmTokenUsage[] = [];
    const onUsage = (u: LlmTokenUsage) => observed.push(u);
    const usage = { promptTokens: 1, completionTokens: 1 };

    const throwing = new FakeLlmClient(
      () => {
        throw new Error('responder boom');
      },
      'fake-model-1',
      usage,
    );
    await expect(throwing.generateJson({ messages: [], onUsage })).rejects.toThrow('responder boom');

    const nonJson = new FakeLlmClient(() => 'not-json', 'fake-model-1', usage);
    await expect(nonJson.generateJson({ messages: [], onUsage })).rejects.toBeInstanceOf(
      LlmResponseError,
    );

    const scalar = new FakeLlmClient(() => 42, 'fake-model-1', usage);
    await expect(scalar.generateJson({ messages: [], onUsage })).rejects.toBeInstanceOf(
      LlmResponseError,
    );

    expect(observed).toEqual([]);
  });

  it('不传 onUsage 也能正常返回（无观察者不炸）', async () => {
    const client = new FakeLlmClient(() => ({ ok: true }), 'fake-model-1', {
      promptTokens: 1,
      completionTokens: 1,
    });
    await expect(client.generateJson<{ ok: boolean }>({ messages: [] })).resolves.toEqual({
      ok: true,
    });
  });
});
