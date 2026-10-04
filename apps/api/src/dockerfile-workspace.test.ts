/**
 * Dockerfile 依赖阶段 ↔ workspace 包清单一致性守护（审计 A11）。
 *
 * 症状：`pnpm-workspace.yaml` 用 `packages/*` + `apps/*` 通配，而 Dockerfile 的 deps 阶段
 * 逐个 `COPY <pkg>/package.json`。新增 workspace 包时忘了加一行，`pnpm install --frozen-lockfile`
 * **不会报错**（pnpm 容忍 lockfile 里多出来的 importer），于是镜像里留下一个
 * 指向不存在目录的 `node_modules/@jobagent/<pkg>` 悬空符号链接；构建阶段 `COPY . .`
 * 又把源码补回来，所以 `docker build` 照样绿。只有当那个包**新增外部依赖**时才会炸，
 * 而且报错发生在镜像里、最难查。
 * 本仓历史上已经踩过一次（漏 COPY job-source/ui-tokens/extension，见 handoff 归档）。
 *
 * 断言：每个 workspace 包的 package.json 都出现在 deps 阶段（`RUN pnpm install` 之前），
 * 并带反空转下限，防止解析退化成"什么都没匹配也算绿"。
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../..');
const DOCKERFILE = join(REPO_ROOT, 'Dockerfile');

/** 与 pnpm-workspace.yaml 一致的两个 glob 根。 */
const GROUPS = ['packages', 'apps'];

function workspacePackages(): string[] {
  const out: string[] = [];
  for (const group of GROUPS) {
    const dir = join(REPO_ROOT, group);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (existsSync(join(dir, entry, 'package.json'))) out.push(`${group}/${entry}`);
    }
  }
  return out.sort();
}

/** 只取 deps 阶段（到 `RUN pnpm install` 为止）的 COPY 目标，避免被后续构建阶段误导。 */
function depsStageCopies(docker: string): Set<string> {
  const lines = docker.split('\n');
  const stop = lines.findIndex((l) => /RUN pnpm install/.test(l));
  const scope = stop === -1 ? lines : lines.slice(0, stop);
  const copies = new Set<string>();
  for (const line of scope) {
    const m = line.match(/^COPY\s+(\S+)\/package\.json\s/);
    if (m) copies.add(m[1]!.replace(/^\.\//, ''));
  }
  return copies;
}

describe('Dockerfile deps 阶段与 workspace 清单对齐', () => {
  const packages = workspacePackages();
  const docker = readFileSync(DOCKERFILE, 'utf8');
  const copies = depsStageCopies(docker);

  it('枚举到足量 workspace 包与 COPY 行（反空转）', () => {
    expect(packages.length).toBeGreaterThanOrEqual(16);
    expect(copies.size).toBeGreaterThanOrEqual(16);
  });

  it('每个 workspace 包的 package.json 都被 COPY 进 deps 阶段', () => {
    const missing = packages.filter((p) => !copies.has(p));
    // 缺一个就列出全部缺失项：镜像里的悬空符号链接不会自己说话，只能在这里拦住
    expect(missing).toEqual([]);
  });

  it('COPY 的包都真实存在（反向：删包要同步 Dockerfile）', () => {
    const stale = [...copies].filter((p) => !existsSync(join(REPO_ROOT, p, 'package.json')));
    expect(stale).toEqual([]);
  });
});
