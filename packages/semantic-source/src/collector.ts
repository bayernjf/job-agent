/**
 * L3 语义层采集器（2026-10-11，设计见 docs/design-semantic-layer-20261011.md）。
 *
 * 只采集公开数据、不 clone：文件树（递归路径，不存内容）+ README 节选 +
 * 关键文件白名单。复用 @jobagent/github-source 的 createOctokit（限频退避/重试/
 * 凭证只在服务端）。单仓库失败降级不失败（missing 标记），整仓采集成功。
 */
import { createOctokit, type ProfileBudget } from '@jobagent/github-source';
import {
  L3_MISSING_KEYS,
  type L3MissingKey,
  type L3RepoFiles,
} from '@jobagent/shared';
import { SemanticSourceError, type L3CollectedData, type SemanticSourceOptions } from './types.js';

/** 递归文件树截断条数（GitHub truncated 时也按此截断） */
export const FILE_TREE_MAX = 2000;
/** README 节选字节上限 */
export const README_MAX_BYTES = 16 * 1024;
/** 单个关键文件字节上限 */
export const KEY_FILE_MAX_BYTES = 16 * 1024;
/** 固定路径关键文件白名单（按序尝试；.github/workflows/*.yml 额外取第一条） */
export const KEY_FILE_CANDIDATES = [
  'package.json',
  'pyproject.toml',
  'go.mod',
  'Cargo.toml',
  'requirements.txt',
  'Dockerfile',
] as const;
/** 关键文件总条数上限（6 固定 + 1 workflow） */
export const KEY_FILES_MAX_COUNT = 7;

export class SemanticSource {
  private readonly octokit: ReturnType<typeof createOctokit>;
  private readonly reposN: number;
  private readonly budget: { restCalls: number };
  private readonly log: Pick<Console, 'info' | 'warn' | 'error'>;
  private restCalls = 0;

  constructor(options: SemanticSourceOptions) {
    this.octokit = createOctokit({
      token: options.token,
      budget: options.budget as Partial<ProfileBudget> | undefined,
      log: options.log,
      fetch: options.fetch,
    });
    this.reposN = options.reposN ?? 5;
    this.budget = options.budget ?? { restCalls: 60 };
    this.log = options.log ?? console;
  }

  async collect(login: string): Promise<L3CollectedData> {
    const started = Date.now();
    const repos = await this.listRepos(login);
    const scanned: L3RepoFiles[] = [];
    for (const repo of repos) {
      scanned.push(await this.collectRepo(repo));
    }
    return {
      input: {
        collectedAt: new Date(started).toISOString(),
        login,
        repos: scanned,
      },
      meta: {
        platform: 'github',
        restCalls: this.restCalls,
        reposScanned: scanned.length,
      },
    };
  }

  private charge(): void {
    if (this.restCalls >= this.budget.restCalls) {
      throw new SemanticSourceError(
        'budget_exhausted',
        `semantic collection exceeded REST budget (${this.budget.restCalls})`,
      );
    }
    this.restCalls += 1;
  }

  private async listRepos(
    login: string,
  ): Promise<Array<{ owner: string; name: string; defaultBranch: string; language: string | null; topics: string[]; description: string | null; starred: number }>> {
    this.charge();
    try {
      const { data } = await this.octokit.rest.repos.listForUser({
        username: login,
        sort: 'pushed',
        per_page: this.reposN,
      });
      return data.map((repo) => ({
        owner: repo.owner.login,
        name: repo.name,
        defaultBranch: repo.default_branch ?? 'HEAD',
        language: repo.language ?? null,
        topics: repo.topics ?? [],
        description: repo.description,
        starred: repo.stargazers_count ?? 0,
      }));
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404) {
        throw new SemanticSourceError('not_found', `GitHub user '${login}' not found`);
      }
      throw new SemanticSourceError('api_error', `list repos for '${login}' failed: ${(err as Error).message}`);
    }
  }

  private async collectRepo(
    repo: { owner: string; name: string; defaultBranch: string; language: string | null; topics: string[]; description: string | null; starred: number },
  ): Promise<L3RepoFiles> {
    const missing: L3MissingKey[] = [];
    const { owner, name, defaultBranch } = repo;

    // 1. 递归文件树（截断 2000 条）
    let fileTree: string[] = [];
    try {
      this.charge();
      const { data } = await this.octokit.rest.git.getTree({
        owner,
        repo: name,
        tree_sha: defaultBranch,
        recursive: '1',
      });
      fileTree = (data.tree ?? [])
        .filter((entry) => entry.path !== undefined)
        .map((entry) => entry.path as string)
        .slice(0, FILE_TREE_MAX);
      if (data.truncated || (data.tree?.length ?? 0) > FILE_TREE_MAX) missing.push('tree');
    } catch (err) {
      if (err instanceof SemanticSourceError) throw err; // 预算耗尽硬失败，不降级
      missing.push('tree');
      this.log.warn(`semantic: tree for ${owner}/${name} unavailable: ${(err as Error).message}`);
    }

    // 2. README 节选（raw，≤16KB）
    let readmeExcerpt = '';
    try {
      this.charge();
      const { data } = await this.octokit.rest.repos.getReadme({
        owner,
        repo: name,
        mediaType: { format: 'raw' },
      });
      readmeExcerpt = truncateBytes(normalizeText(data), README_MAX_BYTES);
    } catch (err) {
      if (err instanceof SemanticSourceError) throw err;
      missing.push('readme');
      this.log.warn(`semantic: readme for ${owner}/${name} unavailable: ${(err as Error).message}`);
    }

    // 3. 关键文件白名单（固定路径 + workflows 第一条，每个 ≤16KB）
    const keyFiles: Record<string, string> = {};
    const workflowPath = fileTree.find(
      (p) => p.startsWith('.github/workflows/') && p.endsWith('.yml'),
    );
    const candidates = [...KEY_FILE_CANDIDATES, ...(workflowPath ? [workflowPath] : [])].slice(
      0,
      KEY_FILES_MAX_COUNT,
    );
    for (const candidate of candidates) {
      if (keyFiles[candidate]) continue;
      try {
        this.charge();
        const { data } = await this.octokit.rest.repos.getContent({
          owner,
          repo: name,
          path: candidate,
          mediaType: { format: 'raw' },
        });
        keyFiles[candidate] = truncateBytes(normalizeText(data), KEY_FILE_MAX_BYTES);
      } catch (err) {
        if (err instanceof SemanticSourceError) throw err;
        // 404 / 任何失败：该文件缺失不失败（白名单尽力而为）
      }
    }
    if (Object.keys(keyFiles).length === 0) missing.push('key_files');

    return {
      owner,
      name,
      defaultBranch,
      language: repo.language,
      topics: repo.topics,
      description: repo.description,
      starred: repo.starred,
      fileTree,
      readmeExcerpt,
      keyFiles,
      missing,
    };
  }
}

/** raw 响应可能是 string（纯文本）或 base64 对象；统一转 utf8 文本 */
function normalizeText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (
    data &&
    typeof data === 'object' &&
    'content' in data &&
    typeof (data as { content: unknown }).content === 'string'
  ) {
    return Buffer.from((data as { content: string }).content, 'base64').toString('utf8');
  }
  return String(data ?? '');
}

/** 按字节截断（安全处理多字节 UTF-8） */
function truncateBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  return buf.subarray(0, maxBytes).toString('utf8');
}

export { L3_MISSING_KEYS };
