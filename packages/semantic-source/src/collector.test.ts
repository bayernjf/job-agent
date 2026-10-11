import { describe, expect, it } from 'vitest';
import { SemanticSource, FILE_TREE_MAX } from './index.js';

/** 最小 fake fetch：按 URL 路由返回录制响应（与 github-source 同模式） */
function makeFetch(routes: Record<string, { status?: number; body?: unknown; raw?: string }>) {
  return async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    // Octokit 对 contents path 的斜杠编码为 %2F，先解码再匹配
    const path = decodeURIComponent(url.split('?')[0] ?? '');
    for (const [key, route] of Object.entries(routes)) {
      if (!path.endsWith(key) && !path.includes(key)) continue;
      if (route.raw !== undefined) {
        return new Response(route.raw, { status: route.status ?? 200 });
      }
      return new Response(JSON.stringify(route.body ?? {}), {
        status: route.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
  };
}

const userRepos = [
  {
    name: 'alpha',
    owner: { login: 'dev-user' },
    default_branch: 'main',
    language: 'TypeScript',
    topics: ['ai', 'agent'],
    description: 'an agent framework',
    stargazers_count: 120,
  },
  {
    name: 'beta',
    owner: { login: 'dev-user' },
    default_branch: 'master',
    language: 'Python',
    topics: [],
    description: 'cli utility',
    stargazers_count: 3,
  },
];

const treeBody = {
  tree: [
    { path: 'package.json', type: 'blob' },
    { path: 'src/index.ts', type: 'blob' },
    { path: 'src/index.test.ts', type: 'blob' },
    { path: 'tests/smoke.ts', type: 'blob' },
    { path: '.github/workflows/ci.yml', type: 'blob' },
    { path: 'Dockerfile', type: 'blob' },
    { path: 'LICENSE', type: 'blob' },
  ],
  truncated: false,
};

const packageJson = JSON.stringify({
  dependencies: { react: '^18', next: '14' },
  devDependencies: { typescript: '^5', vitest: '^2' },
});

const defaultRoutes = {
  '/users/dev-user/repos': { body: userRepos },
  '/repos/dev-user/alpha/git/trees/main': { body: treeBody },
  '/repos/dev-user/alpha/readme': { raw: '# Alpha\n\nAn agent framework that does things.' },
  '/repos/dev-user/alpha/contents/package.json': { raw: packageJson },
  '/repos/dev-user/alpha/contents/pyproject.toml': { status: 404 },
  '/repos/dev-user/alpha/contents/go.mod': { status: 404 },
  '/repos/dev-user/alpha/contents/Cargo.toml': { status: 404 },
  '/repos/dev-user/alpha/contents/requirements.txt': { status: 404 },
  '/repos/dev-user/alpha/contents/Dockerfile': { raw: 'FROM node:20\n' },
  '/repos/dev-user/alpha/contents/.github/workflows/ci.yml': { raw: 'name: ci\n' },
  '/repos/dev-user/beta/git/trees/master': { status: 404 },
  '/repos/dev-user/beta/readme': { status: 404 },
};

describe('SemanticSource', () => {
  it('collects file tree, readme and key files with meta counts', async () => {
    const source = new SemanticSource({
      token: 'fake-token',
      fetch: makeFetch(defaultRoutes),
      log: { info() {}, warn() {}, error() {} },
    });
    const result = await source.collect('dev-user');

    expect(result.meta.platform).toBe('github');
    expect(result.meta.reposScanned).toBe(2);
    expect(result.input.login).toBe('dev-user');

    const alpha = result.input.repos.find((r) => r.name === 'alpha')!;
    expect(alpha.fileTree).toContain('src/index.ts');
    expect(alpha.fileTree).toContain('.github/workflows/ci.yml');
    expect(alpha.readmeExcerpt).toContain('An agent framework');
    expect(alpha.keyFiles['package.json']).toContain('react');
    expect(alpha.keyFiles['Dockerfile']).toBe('FROM node:20\n');
    expect(alpha.keyFiles['.github/workflows/ci.yml']).toBe('name: ci\n');
    expect(alpha.missing).toEqual([]);

    // beta 整仓降级：tree/readme/keyFiles 全部缺失但不失败
    const beta = result.input.repos.find((r) => r.name === 'beta')!;
    expect(beta.missing).toContain('tree');
    expect(beta.missing).toContain('readme');
    expect(beta.missing).toContain('key_files');
    expect(beta.fileTree).toEqual([]);
    expect(beta.readmeExcerpt).toBe('');
  });

  it('throws not_found for a missing user', async () => {
    const source = new SemanticSource({
      token: 'fake-token',
      fetch: makeFetch({}),
      log: { info() {}, warn() {}, error() {} },
    });
    await expect(source.collect('ghost')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('truncates oversized file trees and marks tree missing', async () => {
    const hugeTree = Array.from({ length: FILE_TREE_MAX + 100 }, (_, i) => ({
      path: `src/file-${i}.ts`,
      type: 'blob',
    }));
    const source = new SemanticSource({
      token: 'fake-token',
      fetch: makeFetch({
        '/users/dev-user/repos': { body: userRepos.slice(0, 1) },
        '/repos/dev-user/alpha/git/trees/main': { body: { tree: hugeTree, truncated: true } },
        '/repos/dev-user/alpha/readme': { raw: '# Alpha\n' },
      }),
      log: { info() {}, warn() {}, error() {} },
    });
    const result = await source.collect('dev-user');
    const alpha = result.input.repos[0]!;
    expect(alpha.fileTree.length).toBe(FILE_TREE_MAX);
    expect(alpha.missing).toContain('tree');
  });

  it('respects the REST budget and fails hard on exhaustion', async () => {
    const source = new SemanticSource({
      token: 'fake-token',
      budget: { restCalls: 2 },
      fetch: makeFetch(defaultRoutes),
      log: { info() {}, warn() {}, error() {} },
    });
    await expect(source.collect('dev-user')).rejects.toMatchObject({ code: 'budget_exhausted' });
  });
});
