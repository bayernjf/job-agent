/**
 * 仓库内 Markdown 相对链接完整性守护。
 *
 * 文档分层靠链接导航（handoff ↔ docs ↔ 归档），链接一旦指错就是静默的：
 * 本轮首扫发现 30 条指向不存在文件的相对链接，两类根因——归档/评审文档写于
 * 文件还在仓库根的时候，搬进 docs/ 后整体偏一层；以及纯打错
 * （docs/handoff-archive-20260924.md 少两个连字符）。
 * 与 api-doc-consistency / env-doc-consistency 同放 apps/api：本仓的
 * 「仓库结构 ↔ 文档」守护都收在这里，随 `pnpm -r test` 在 CI 实跑。
 *
 * 只读文件、零网络。检查相对路径是否存在，锚点（#section）不验。
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../..');
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.vercel',
  '.git',
  '.astro',
  'test-results',
  'playwright-report',
  'release',
  'data',
  'coverage',
]);

function markdownFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) markdownFiles(full, out);
    else if (extname(full) === '.md') out.push(full);
  }
  return out;
}

/** [text](relative) 与 ![alt](relative)，跳过 http(s)/mailto/纯锚点 */
const LINK = /!?\[[^\]]*\]\(\s*(?!https?:|mailto:|data:)([^)\s#]+)(#[^)]*)?\)/g;

describe('markdown relative links', () => {
  it('resolve to a file that exists', () => {
    const broken: string[] = [];
    for (const file of markdownFiles(REPO_ROOT)) {
      const dir = file.slice(0, file.lastIndexOf('/'));
      for (const match of readFileSync(file, 'utf8').matchAll(new RegExp(LINK.source, 'g'))) {
        const target = match[1];
        if (!target || target.startsWith('/')) continue;
        if (!statSync(join(dir, target), { throwIfNoEntry: false })) {
          broken.push(`${file.replace(`${REPO_ROOT}/`, '')} -> ${target}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it('finds the links it claims to guard', () => {
    // 防守护空转：仓库文档里至少有这么多条相对链接在被检查
    let count = 0;
    for (const file of markdownFiles(REPO_ROOT)) {
      for (const _ of readFileSync(file, 'utf8').matchAll(new RegExp(LINK.source, 'g'))) count += 1;
    }
    expect(count).toBeGreaterThan(150);
  });
});
