import { describe, expect, it } from 'vitest';
import { run } from './index.js';
import { analyzeSemantic } from '@jobagent/semantic-core';
import type { L3CollectedData } from '@jobagent/semantic-source';

const fakeInput: L3CollectedData = {
  input: {
    collectedAt: '2026-10-11T00:00:00.000Z',
    login: 'dev-user',
    repos: [
      {
        owner: 'dev-user',
        name: 'alpha',
        defaultBranch: 'main',
        language: 'TypeScript',
        topics: ['ai', 'agent'],
        description: 'An agent framework',
        starred: 120,
        fileTree: ['package.json', 'src/index.test.ts', '.github/workflows/ci.yml'],
        readmeExcerpt: '# Alpha\n\nAn agent framework that does things with several words here.',
        keyFiles: {
          'package.json': JSON.stringify({ dependencies: { react: '^18' }, devDependencies: { typescript: '^5' } }),
        },
        missing: [],
      },
    ],
  },
  meta: { platform: 'github', restCalls: 4, reposScanned: 1 },
};

function makeCli() {
  const out: string[] = [];
  return {
    deps: {
      token: 'fake-token',
      semanticSource: { collect: async () => fakeInput },
      logger: { error: (m: string) => out.push(m), warn: () => {}, info: () => {}, log: () => {} },
      stdout: { write: (c: string) => out.push(c) },
    },
    out,
  };
}

describe('semantic CLI', () => {
  it('analyze renders json with signals by default', async () => {
    const { deps, out } = makeCli();
    const code = await run(['semantic', 'analyze', 'dev-user'], deps);
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join(''));
    expect(parsed.signals.ruleVersion).toBe(analyzeSemantic(fakeInput.input).ruleVersion);
    expect(parsed.signals.summary.techStack).toContain('react');
    expect(parsed.collected.meta.restCalls).toBe(4);
  });

  it('analyze renders markdown report with maturity facts', async () => {
    const { deps, out } = makeCli();
    const code = await run(['semantic', 'analyze', 'dev-user', '--format', 'markdown'], deps);
    expect(code).toBe(0);
    const text = out.join('');
    expect(text).toContain('# L3 语义信号 — dev-user');
    expect(text).toContain('工程成熟度：测试 ✓｜CI ✓');
    expect(text).toContain('技术栈：react, typescript');
  });

  it('rejects a missing username with usage error', async () => {
    const { deps, out } = makeCli();
    const code = await run(['semantic', 'analyze'], deps);
    expect(code).toBe(2);
    expect(out.join('')).toContain('Usage: jobagent semantic analyze');
  });

  it('reports collection failures without a stack dump', async () => {
    const { deps, out } = makeCli();
    deps.semanticSource = {
      collect: async () => {
        throw new Error('not_found: GitHub user ghost not found');
      },
    };
    const code = await run(['semantic', 'analyze', 'ghost'], deps);
    expect(code).toBe(1);
    expect(out.join('')).toContain('semantic analyze failed for ghost: not_found');
  });
});
