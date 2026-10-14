import { describe, expect, it } from 'vitest';
import {
  FakeLlmClient,
  JD_DESCRIPTION_CHAR_LIMIT,
  JD_EXTRACTION_PROMPT_VERSION,
  LlmJdExtractionProvider,
  LlmResponseError,
  createJdExtractionProviderFromEnv,
  type LlmTokenUsage,
} from './index.js';

describe('LlmJdExtractionProvider', () => {
  it('assembles provider/model and returns validated JD facts', async () => {
    const fake = new FakeLlmClient(() => ({
      responsibilities: ['Build backend services'],
      requiredSkills: ['TypeScript', 'PostgreSQL'],
      qualifications: ['5+ years experience'],
    }));
    const provider = new LlmJdExtractionProvider(fake);
    expect(provider.provider).toBe('fake');
    expect(provider.model).toBe('fake-model-1');
    expect(provider.promptVersion).toBe(JD_EXTRACTION_PROMPT_VERSION);

    const out = await provider.extract('Backend Engineer', 'We need TypeScript and PostgreSQL.');
    expect(out).toEqual({
      responsibilities: ['Build backend services'],
      requiredSkills: ['TypeScript', 'PostgreSQL'],
      qualifications: ['5+ years experience'],
    });
  });

  it('only extracts job-side facts: prompt forbids candidate assessment', async () => {
    const fake = new FakeLlmClient(() => ({
      responsibilities: [],
      requiredSkills: ['Rust'],
      qualifications: [],
    }));
    const provider = new LlmJdExtractionProvider(fake);
    await provider.extract('Engineer', 'Rust required');
    const system = fake.calls[0]!.messages[0]!.content;
    expect(system).toContain('Do NOT assess, score, or describe the candidate');
    expect(system).toContain('Extract ONLY facts stated in the job posting');
  });

  it('truncates title to 200 and description to the configured char limit', async () => {
    const fake = new FakeLlmClient(() => ({
      responsibilities: [],
      requiredSkills: [],
      qualifications: [],
    }));
    const provider = new LlmJdExtractionProvider(fake);
    await provider.extract('T'.repeat(300), 'B'.repeat(8000));
    const payload = JSON.parse(fake.calls[0]!.messages[1]!.content) as {
      title: string;
      description: string;
    };
    expect(payload.title.length).toBe(200);
    expect(payload.description.length).toBe(JD_DESCRIPTION_CHAR_LIMIT);
  });

  it('rejects output that fails schema validation (fail-closed)', async () => {
    const fake = new FakeLlmClient(() => ({
      requiredSkills: 'TypeScript', // wrong type
      qualifications: [],
    }));
    const provider = new LlmJdExtractionProvider(fake);
    await expect(provider.extract('Engineer', 'desc')).rejects.toThrow(LlmResponseError);
  });

  it('propagates non-JSON client failures as LlmResponseError', async () => {
    const fake = new FakeLlmClient(() => 'not-json');
    const provider = new LlmJdExtractionProvider(fake);
    await expect(provider.extract('Engineer', 'desc')).rejects.toThrow(LlmResponseError);
  });

  it('forwards onUsage to the underlying client (计量接缝，决策 #25 ④)', async () => {
    const fake = new FakeLlmClient(
      () => ({ responsibilities: [], requiredSkills: ['TypeScript'], qualifications: [] }),
      'fake-model-1',
      { promptTokens: 512, completionTokens: 64 },
    );
    const provider = new LlmJdExtractionProvider(fake);
    const observed: LlmTokenUsage[] = [];
    await provider.extract('Backend Engineer', 'TypeScript required', (u) => observed.push(u));
    expect(observed).toEqual([{ promptTokens: 512, completionTokens: 64 }]);
  });
});

describe('createJdExtractionProviderFromEnv', () => {
  it('returns null when LLM_API_KEY is unset (default off, rule-based path)', () => {
    expect(createJdExtractionProviderFromEnv({})).toBeNull();
  });

  it('throws when a key is set but LLM_MODEL is missing (no implicit paid model)', () => {
    expect(() => createJdExtractionProviderFromEnv({ LLM_API_KEY: 'sk-test' })).toThrow(
      /LLM_MODEL/,
    );
  });

  it('builds a provider when key and model are present', () => {
    const provider = createJdExtractionProviderFromEnv({
      LLM_API_KEY: 'sk-test',
      LLM_MODEL: 'test-model',
      LLM_BASE_URL: 'https://llm.test/v1/',
    });
    expect(provider).not.toBeNull();
    expect(provider?.model).toBe('test-model');
  });
});
