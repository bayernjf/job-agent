import { describe, expect, it } from 'vitest';
import type { L3SemanticInput } from '@jobagent/shared';
import {
  FakeLlmClient,
  LlmResponseError,
  LlmSemanticProvider,
  SEMANTIC_PROMPT_VERSION,
  createSemanticProviderFromEnv,
} from './index.js';

function makeInput(): L3SemanticInput {
  return {
    collectedAt: '2026-10-11T00:00:00.000Z',
    login: 'alice',
    repos: [
      {
        owner: 'alice',
        name: 'engine',
        defaultBranch: 'main',
        language: 'TypeScript',
        topics: ['api', 'typescript'],
        description: 'Event-driven API engine',
        starred: 42,
        fileTree: Array.from({ length: 60 }, (_, i) => `src/file${i}.ts`),
        readmeExcerpt: 'A'.repeat(3000),
        keyFiles: { 'package.json': '{"dependencies":{"typescript":"^5"}}' },
        missing: [],
      },
    ],
  };
}

describe('LlmSemanticProvider', () => {
  it('assembles provider/model and returns the validated summary', async () => {
    const fake = new FakeLlmClient(() => ({
      repoSummary: 'Focuses on event-driven TypeScript API engines.',
      designDecisions: ['Strict TypeScript (evidence: package.json)', 'Modular src layout (evidence: file tree)'],
    }));
    const provider = new LlmSemanticProvider(fake, { temperature: 0.2 });
    expect(provider.provider).toBe('fake');
    expect(provider.model).toBe('fake-model-1');
    expect(provider.promptVersion).toBe(SEMANTIC_PROMPT_VERSION);

    const out = await provider.generate(makeInput());
    expect(out.repoSummary).toBe('Focuses on event-driven TypeScript API engines.');
    expect(out.designDecisions).toHaveLength(2);
    // 裁剪生效：readme 只传 1500 字符、fileTree 只传 40 条、keyFiles 只传键名
    const user = fake.calls[0]!.messages[1]!.content;
    const payload = JSON.parse(user) as {
      repos: Array<{ readmeExcerpt: string; fileTree: string[]; keyFileNames: string[] }>;
    };
    expect(payload.repos[0]!.readmeExcerpt.length).toBe(1500);
    expect(payload.repos[0]!.fileTree).toHaveLength(40);
    expect(payload.repos[0]!.keyFileNames).toEqual(['package.json']);
    expect(JSON.stringify(payload)).not.toContain('"dependencies"');
  });

  it('rejects output that fails schema validation (fail-closed)', async () => {
    const fake = new FakeLlmClient(() => ({ repoSummary: 42, designDecisions: 'not-an-array' }));
    const provider = new LlmSemanticProvider(fake);
    await expect(provider.generate(makeInput())).rejects.toThrow(LlmResponseError);
  });

  it('propagates client-level failures as LlmResponseError', async () => {
    const fake = new FakeLlmClient(() => 'not-json');
    const provider = new LlmSemanticProvider(fake);
    await expect(provider.generate(makeInput())).rejects.toThrow(LlmResponseError);
  });
});

describe('createSemanticProviderFromEnv', () => {
  it('returns null without LLM_API_KEY (rule fallback)', () => {
    expect(createSemanticProviderFromEnv({})).toBeNull();
  });

  it('throws when key is set but model is missing', () => {
    expect(() => createSemanticProviderFromEnv({ LLM_API_KEY: 'k' })).toThrow(/LLM_MODEL/);
  });

  it('builds a provider from key + model', () => {
    const provider = createSemanticProviderFromEnv({ LLM_API_KEY: 'k', LLM_MODEL: 'm' });
    expect(provider).not.toBeNull();
    expect(provider!.provider).toBeTruthy();
    expect(provider!.model).toBe('m');
  });
});
