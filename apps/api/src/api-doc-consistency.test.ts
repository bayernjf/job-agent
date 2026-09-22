/**
 * Docs/API.md 与 apps/api 实际注册路由的双向一致性守护：
 * 注册的每个路由必须在文档中出现，文档中列出的每个路由也必须真实注册，
 * 防止新增端点忘写文档或文档残留已删除端点。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../..');
const DOC = readFileSync(resolve(REPO_ROOT, 'docs/API.md'), 'utf8');
const SOURCE = readFileSync(resolve(__dirname, 'index.ts'), 'utf8');

const METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const;
type Endpoint = `${(typeof METHODS)[number]} ${string}`;

function documentedEndpoints(): Set<Endpoint> {
  const found = new Set<Endpoint>();
  const re = /`(GET|POST|PATCH|PUT|DELETE)\s+(\/[^`]*)`/g;
  for (const match of DOC.matchAll(re)) {
    const method = match[1];
    const rawPath = match[2];
    if (!method || !rawPath) continue;
    const path = (rawPath.split('?')[0] ?? rawPath).replace(/\/+$/, '');
    // [locale] paths are Astro report-app pages, not Hono API routes.
    if (path.includes('[locale]')) continue;
    found.add(`${method} ${path}` as Endpoint);
  }
  return found;
}

function registeredEndpoints(): Set<Endpoint> {
  const found = new Set<Endpoint>();
  const literal = /app\.(get|post|patch|put|delete)\(\s*'([^']+)'/g;
  for (const match of SOURCE.matchAll(literal)) {
    const method = match[1];
    const path = match[2];
    if (method && path) found.add(`${method.toUpperCase()} ${path}` as Endpoint);
  }
  // OAuth login/callback paths are built per platform from template strings.
  const oauth = /registerOAuthFlow\('(\w+)'/g;
  for (const match of SOURCE.matchAll(oauth)) {
    const platform = match[1];
    if (!platform) continue;
    found.add(`GET /auth/${platform}/login`);
    found.add(`GET /auth/${platform}/callback`);
  }
  return found;
}

describe('docs/API.md route consistency', () => {
  it('documents every registered route', () => {
    const registered = registeredEndpoints();
    const documented = documentedEndpoints();
    const missing = [...registered].filter((e) => !documented.has(e));
    expect(missing).toEqual([]);
  });

  it('registers every documented route', () => {
    const registered = registeredEndpoints();
    const documented = documentedEndpoints();
    const stale = [...documented].filter((e) => !registered.has(e));
    expect(stale).toEqual([]);
  });
});
